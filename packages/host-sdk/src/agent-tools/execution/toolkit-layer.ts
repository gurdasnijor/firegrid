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
import type { WorkflowEngine } from "@effect/workflow"
import type * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import {
  provideRuntimeContext,
} from "@firegrid/protocol/launch"
import {
  HostRuntimeObservationStreamsLive,
  HostRuntimeObservationSubstrateLive,
  RuntimeAgentToolExecutionLive,
  type HostRuntimeContextExecutionEnv,
} from "../../host/runtime-substrate.ts"
import {
  ToolCallWorkflow,
} from "@firegrid/runtime/workflows"
import { type Context, Effect, Layer } from "effect"
import type { WorkflowEngineTable } from "@firegrid/runtime/workflow-engine"
import { toolExecutionFailed } from "../bindings/tool-error.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  type FiregridMcpToolFailure,
} from "../bindings/tools.ts"
import { AgentToolHost } from "./tool-host.ts"
import { toolUseToEffect } from "./tool-use-to-effect.ts"
import {
  RuntimeContextWorkflowRuntime,
} from "../../host/runtime-context-workflow-runtime.ts"
import type { ChannelInventory } from "../../host/channel.ts"

const TOOL_USE_ID_PREFIX = "mcp"

export { ToolCallWorkflow } from "@firegrid/runtime/workflows"

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
  agentToolHost: AgentToolHost["Type"],
): Layer.Layer<
  never,
  unknown,
  | HostRuntimeContextExecutionEnv
  | ChannelInventory
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngineTable
> =>
  // TFIND-031 (Option Y): the ephemeral tool-call workflow body
  // (`toolUseToEffect` — `WaitFor.match`, child workflows) genuinely
  // requires the runtime observation substrate. Like
  // `runtimeContextWorkflowSupportLayer`, this execution-scoped support
  // layer must SELF-CONTAIN that substrate (one materialized store,
  // recorder/waker cannot diverge; SDD structural proof). Omitting it
  // only typechecked while `DurableTable.layer` leaked `any`; with
  // precise typing the real requirement must be discharged here, not
  // re-surfaced onto every MCP tool handler.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- DurableTable.layer still leaks any through substrate layers; the declared Layer R channel is the intended capability boundary.
  ToolCallWorkflowLayer.pipe(
    Layer.provideMerge(HostRuntimeObservationSubstrateLive),
    Layer.provideMerge(HostRuntimeObservationStreamsLive),
    Layer.provideMerge(RuntimeAgentToolExecutionLive),
    Layer.provideMerge(Layer.succeed(AgentToolHost, agentToolHost)),
  )

// TFIND-031: includes the host runtime context that deferred tool
// handlers genuinely require. The execution-scoped observation substrate
// is provided inside the tool-call workflow support layer instead of
// leaking onto every MCP tool handler.
type ToolCallHostEnvironment =
  | RuntimeContextWorkflowRuntime
  | AgentToolHost
  | ChannelInventory
  | HostRuntimeContextExecutionEnv

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
      const workflowRuntime = yield* RuntimeContextWorkflowRuntime
      const agentToolHost = yield* AgentToolHost
      return yield* workflowRuntime.run({
        context: runtimeContext,
        workflowName: ToolCallWorkflow.name,
        supportLayer: toolCallWorkflowSupportLayer(agentToolHost),
        effect: execute.pipe(provideRuntimeContext(runtimeContext)),
      })
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
  }).pipe(Effect.annotateSpans("firegrid.side", "agent-tools"))

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
 * the tool-call workflow on that context's active host-scoped RuntimeContext engine.
 */
export const FiregridAgentToolkitLayer = FiregridAgentToolkit.toLayer(
  Effect.map(Effect.context<ToolCallHostEnvironment>(), captured => ({
    sleep: (params: AgentToolSchemas.SleepToolInput) =>
      handleTool<AgentToolSchemas.SleepToolOutput>(captured, "sleep", params),
    wait_for: (params: AgentToolSchemas.WaitForToolInput) =>
      handleTool<AgentToolSchemas.WaitForToolOutput>(captured, "wait_for", params),
    send: (params: AgentToolSchemas.SendToolInput) =>
      handleTool<AgentToolSchemas.SendToolOutput>(captured, "send", params),
    call: (params: AgentToolSchemas.CallToolInput) =>
      handleTool<AgentToolSchemas.CallToolOutput>(captured, "call", params),
    wait_for_any: (params: AgentToolSchemas.WaitForAnyToolInput) =>
      handleTool<AgentToolSchemas.WaitForAnyToolOutput>(captured, "wait_for_any", params),
    session_new: (params: AgentToolSchemas.SessionNewToolInput) =>
      handleTool<AgentToolSchemas.SessionNewToolOutput>(captured, "session_new", params),
    session_prompt: (params: AgentToolSchemas.SessionPromptToolInput) =>
      handleTool<AgentToolSchemas.SessionPromptToolOutput>(captured, "session_prompt", params),
    session_cancel: (params: AgentToolSchemas.SessionCancelToolInput) =>
      handleTool<AgentToolSchemas.SessionCancelToolOutput>(captured, "session_cancel", params),
    session_close: (params: AgentToolSchemas.SessionCloseToolInput) =>
      handleTool<AgentToolSchemas.SessionCloseToolOutput>(captured, "session_close", params),
    schedule_me: (params: AgentToolSchemas.ScheduleMeToolInput) =>
      handleTool<AgentToolSchemas.ScheduleMeToolOutput>(captured, "schedule_me", params),
    execute: (params: AgentToolSchemas.ExecuteToolInput) =>
      handleTool<AgentToolSchemas.ExecuteToolOutput>(captured, "execute", params),
  })),
).pipe(Layer.annotateSpans("firegrid.side", "agent-tools"))
