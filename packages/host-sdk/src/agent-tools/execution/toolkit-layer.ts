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
import { Workflow } from "@effect/workflow"
import {
  type ExecuteToolOutput,
  type ScheduleMeToolOutput,
  type SessionCancelToolOutput,
  type SessionCloseToolOutput,
  type SessionNewToolOutput,
  type SessionPromptToolOutput,
  type SleepToolOutput,
  type WaitForToolOutput,
} from "@firegrid/protocol/agent-tools"
import { provideRuntimeContext } from "@firegrid/protocol/launch"
import { ToolResultEventSchema } from "@firegrid/runtime/events"
import { Effect, Schema } from "effect"
import { toolExecutionFailed } from "../bindings/tool-error.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  type FiregridMcpToolFailure,
} from "../bindings/tools.ts"
import { toolUseToEffect } from "./tool-use-to-effect.ts"

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

/**
 * Common handler shape: every tool routes through `toolUseToEffect` so
 * tool calls observe the same workflow identity, replay safety, and
 * host seams as direct codec paths.
 */
const handleTool = <Output>(toolName: string, params: unknown) =>
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
    const result = yield* (resolved.runtimeContext === undefined
      ? execute
      : execute.pipe(provideRuntimeContext(resolved.runtimeContext)))
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
 * The handler requirements channel includes every `R` accumulated by
 * `toolUseToEffect` (workflow engine, durable-tools table, scope,
 * `AgentToolHost`) plus the bridge-scoped `FiregridAgentToolContext`
 * and `IdGenerator`. Composition wiring provides those services at the
 * MCP layer boundary.
 */
export const FiregridAgentToolkitLayer = FiregridAgentToolkit.toLayer({
  sleep: (params) => handleTool<SleepToolOutput>("sleep", params),
  wait_for: (params) => handleTool<WaitForToolOutput>("wait_for", params),
  session_new: (params) =>
    handleTool<SessionNewToolOutput>("session_new", params),
  session_prompt: (params) =>
    handleTool<SessionPromptToolOutput>("session_prompt", params),
  session_cancel: (params) =>
    handleTool<SessionCancelToolOutput>("session_cancel", params),
  session_close: (params) =>
    handleTool<SessionCloseToolOutput>("session_close", params),
  schedule_me: (params) =>
    handleTool<ScheduleMeToolOutput>("schedule_me", params),
  execute: (params) => handleTool<ExecuteToolOutput>("execute", params),
})
