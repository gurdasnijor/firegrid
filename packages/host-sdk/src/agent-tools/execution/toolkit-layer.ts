/**
 * EXECUTION side of the agent-tool boundary
 * (`firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6`): the per-call workflow that
 * gives `toolUseToEffect` a `WorkflowEngine.WorkflowInstance`, and the
 * toolkit handler Layer that routes every registered tool through the
 * host-side lowering.
 *
 * The binding values (`Tool`/`Toolkit`, failure schema, routing tag) live
 * in `../bindings`; this module composes them with host execution.
 */

import { IdGenerator, Prompt } from "@effect/ai"
import { Workflow, WorkflowEngine } from "@effect/workflow"
import {
  type ExecuteToolOutput,
  type ExecuteToolInput,
  type ScheduleMeToolInput,
  type ScheduleMeToolOutput,
  type SessionCancelToolInput,
  type SessionCancelToolOutput,
  type SessionCloseToolInput,
  type SessionCloseToolOutput,
  type SessionNewToolInput,
  type SessionNewToolOutput,
  type SessionPromptToolInput,
  type SessionPromptToolOutput,
  type SleepToolInput,
  type SleepToolOutput,
  type WaitForToolInput,
  type WaitForToolOutput,
} from "@firegrid/protocol/agent-tools"
import {
  type CurrentHostSession,
  type RuntimeControlPlaneTable,
  type RuntimeOutputTable,
  provideRuntimeContext,
} from "@firegrid/protocol/launch"
import { ToolResultEventSchema } from "@firegrid/runtime/events"
import { type Context, Effect, Layer, Schema } from "effect"
import { WorkflowEngineTable } from "@firegrid/runtime/workflow-engine"
import { toolExecutionFailed } from "../bindings/tool-error.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  type FiregridMcpToolFailure,
} from "../bindings/tools.ts"
import { AgentToolHost } from "./tool-host.ts"
import { toolUseToEffect } from "./tool-use-to-effect.ts"
import {
  RuntimeContextEngineRegistry,
  type ActiveRuntimeContextEngine,
} from "../../host/runtime-context-engine-registry.ts"

const TOOL_USE_ID_PREFIX = "mcp"

// ---------------------------------------------------------------------------
// Tool-call workflow — required only so `toolUseToEffect` runs inside a
// `WorkflowEngine.WorkflowInstance`
// ---------------------------------------------------------------------------
//
// `@effect/workflow`'s `DurableClock.sleep` (and therefore the `sleep` arm,
// `WaitFor.match`, and any child workflow execution in `toolUseToEffect`)
// requires the `WorkflowInstance` service in its `R` channel, and
// `WorkflowInstance` is only produced inside a registered workflow body
// (`Workflow.toLayer(...)`). This ephemeral per-call workflow exists
// solely to satisfy that requirement.

export const ToolCallWorkflow = Workflow.make({
  name: "firegrid.agent-tool-call",
  payload: Schema.Struct({
    contextId: Schema.String,
    toolUseId: Schema.String,
    toolName: Schema.String,
    input: Schema.Unknown,
  }),
  success: ToolResultEventSchema,
  idempotencyKey: ({ toolUseId }) => toolUseId,
})

export const ToolCallWorkflowLayer = ToolCallWorkflow.toLayer(
  ({ contextId, toolUseId, toolName, input }) =>
    toolUseToEffect(
      { contextId },
      {
        _tag: "ToolUse",
        part: Prompt.toolCallPart({
          id: toolUseId,
          name: toolName,
          params: input,
          providerExecuted: false,
        }),
      },
    ),
)

const toolCallWorkflowSupportLayer = (
  handle: ActiveRuntimeContextEngine,
  agentToolHost: AgentToolHost["Type"],
) =>
  ToolCallWorkflowLayer.pipe(
    Layer.provideMerge(Layer.succeed(WorkflowEngine.WorkflowEngine, handle.engine)),
    Layer.provideMerge(Layer.succeed(WorkflowEngineTable, handle.table)),
    Layer.provideMerge(Layer.succeed(AgentToolHost, agentToolHost)),
  )

type ToolCallHostEnvironment =
  | RuntimeContextEngineRegistry
  | AgentToolHost
  | CurrentHostSession
  | RuntimeControlPlaneTable
  | RuntimeOutputTable

/**
 * Common handler shape: every tool routes through `toolUseToEffect` so
 * tool calls observe the same workflow identity, replay safety, and
 * host seams as direct codec paths.
 */
const handleTool = <Output>(
  captured: Context.Context<ToolCallHostEnvironment>,
  toolName: string,
  params: unknown,
) =>
  Effect.gen(function* () {
    const ctx = yield* FiregridAgentToolContext
    const idGen = yield* IdGenerator.IdGenerator
    const idSuffix = yield* idGen.generateId()
    const resolved = yield* ctx.resolve.pipe(
      Effect.mapError(cause =>
        toolExecutionFailed(
          `${TOOL_USE_ID_PREFIX}:unrouted:${idSuffix}`,
          toolName,
          cause,
        )),
    )
    const toolUseId = `${TOOL_USE_ID_PREFIX}:${resolved.contextId}:${idSuffix}`
    const execute = ToolCallWorkflow.execute({
      contextId: resolved.contextId,
      toolUseId,
      toolName,
      input: params,
    })
    if (resolved.runtimeContext === undefined) {
      return yield* Effect.fail(toolExecutionFailed(
        toolUseId,
        toolName,
        "MCP tool execution requires a resolved runtime context",
      ))
    }
    const runtimeContext = resolved.runtimeContext
    const result = yield* Effect.gen(function*() {
      const registry = yield* RuntimeContextEngineRegistry
      const agentToolHost = yield* AgentToolHost
      const handle = yield* registry.startOrAttach(runtimeContext).pipe(
        Effect.mapError(cause =>
          toolExecutionFailed(toolUseId, toolName, cause)),
      )
      return yield* execute.pipe(
        provideRuntimeContext(runtimeContext),
        Effect.provide(toolCallWorkflowSupportLayer(handle, agentToolHost)),
      )
    }).pipe(
      Effect.mapError(cause =>
        toolExecutionFailed(toolUseId, toolName, cause)),
      Effect.provide(captured),
    )
    if (result.part.isFailure) {
      const error = extractToolFailure(result.part.result)
      return yield* Effect.fail(error)
    }
    return result.part.result as Output
  })

/**
 * Pull a structured `ToolError` out of `ToolResult.part.result`. The
 * unknown-tool case (`_tag: "UnknownTool"`) should never reach an MCP
 * handler because toolkit dispatch only invokes registered names; if it
 * does, map it to `ToolExecutionFailed` so the MCP-facing failure stays
 * a valid `FiregridMcpToolFailure`.
 */
const extractToolFailure = (content: unknown): FiregridMcpToolFailure => {
  const record = (typeof content === "object" && content !== null
    ? content
    : {}) as Record<string, unknown>
  const error = record.error
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { readonly _tag: unknown })._tag !== "UnknownTool"
  ) {
    return error as FiregridMcpToolFailure
  }
  return {
    _tag: "ToolExecutionFailed",
    toolUseId: "unknown",
    name: "unknown",
    message:
      typeof record.message === "string"
        ? record.message
        : "Tool returned an unstructured error payload",
  }
}

/**
 * Toolkit handler Layer. Registering this with `McpServer` (via
 * `McpServer.registerToolkit`) projects the toolkit to MCP `tools/list`
 * and `tools/call`.
 *
 * Host services are captured once when the MCP layer is built; each handler
 * still resolves its route-scoped runtime context at call time and then runs
 * the tool-call workflow on that context's active per-context engine.
 */
export const FiregridAgentToolkitLayer = FiregridAgentToolkit.toLayer(
  Effect.map(Effect.context<ToolCallHostEnvironment>(), captured => ({
    sleep: (params: SleepToolInput) => handleTool<SleepToolOutput>(captured, "sleep", params),
    wait_for: (params: WaitForToolInput) => handleTool<WaitForToolOutput>(captured, "wait_for", params),
    session_new: (params: SessionNewToolInput) =>
      handleTool<SessionNewToolOutput>(captured, "session_new", params),
    session_prompt: (params: SessionPromptToolInput) =>
      handleTool<SessionPromptToolOutput>(captured, "session_prompt", params),
    session_cancel: (params: SessionCancelToolInput) =>
      handleTool<SessionCancelToolOutput>(captured, "session_cancel", params),
    session_close: (params: SessionCloseToolInput) =>
      handleTool<SessionCloseToolOutput>(captured, "session_close", params),
    schedule_me: (params: ScheduleMeToolInput) =>
      handleTool<ScheduleMeToolOutput>(captured, "schedule_me", params),
    execute: (params: ExecuteToolInput) => handleTool<ExecuteToolOutput>(captured, "execute", params),
  })),
)
