/**
 * EXECUTION side of the agent-tool boundary
 * (`firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6`): the toolkit handler Layer
 * that routes every registered tool through the runtime-owned
 * `ToolDispatch` facade.
 *
 * The binding values (`Tool`/`Toolkit`, failure schema, routing tag) live
 * in `../bindings`; this module composes them with the runtime dispatch
 * Tag.
 *
 * Wave D-B: handler dispatch goes through `ToolDispatch.call(...)` from
 * `@firegrid/runtime/subscribers/tool-dispatch`. The legacy per-call
 * workflow-runtime bridge (kernel `.run({supportLayer, effect})` wrapper
 * + the per-call tool support layer + the vestigial `provideRuntimeContext`
 * call) is deleted. host-sdk no longer imports `@effect/workflow`, the
 * kernel workflow-runtime Tag, the per-call support layer, or the
 * protocol's `provideRuntimeContext` helper from this file.
 */

import { IdGenerator } from "@effect/ai"
import type * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import { ToolDispatch } from "./index.ts"
import { type Context, Effect, Layer } from "effect"
import { toolExecutionFailed } from "./bindings/tool-error.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridPrimitiveProfileToolkit,
  type FiregridMcpToolFailure,
} from "./bindings/tools.ts"

const TOOL_USE_ID_PREFIX = "mcp"

// `ToolCallWorkflow` + `ToolCallWorkflowLayer` are canonically exported
// by `./index.ts` (which re-exports `RuntimeToolCallWorkflowLayer as
// ToolCallWorkflowLayer` from `./workflow.ts`). Duplicate re-exports
// from this module were dead and removed.

type ToolCallHostEnvironment = ToolDispatch

/**
 * Common handler shape: every tool dispatches through the runtime-owned
 * `ToolDispatch` facade so tool calls observe the same workflow identity,
 * replay safety, and host seams as direct codec paths. At-most-once across
 * restart is `Workflow.idempotencyKey: toolUseId` over
 * `WorkflowEngineTable` (#713 GREEN).
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
    if (resolved.runtimeContext === undefined) {
      return yield* Effect.fail(toolExecutionFailed(
        toolUseId,
        toolName,
        "MCP tool execution requires a resolved runtime context",
      ))
    }
    const dispatch = yield* ToolDispatch
    const result = yield* dispatch.call({
      contextId: resolved.contextId,
      toolUseId,
      toolName,
      input: params,
    }).pipe(
      Effect.mapError(failure =>
        toolExecutionFailed(failure.toolUseId, failure.toolName, failure.cause)),
    )
    if (result.part.isFailure) {
      const error = extractToolFailure(result.part.result)
      return yield* Effect.fail(error)
    }
    return result.part.result as Output
  }).pipe(
    Effect.provide(captured),
    Effect.annotateSpans("firegrid.side", "agent-tools"),
  )

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

const makeToolkitHandlers = (
  captured: Context.Context<ToolCallHostEnvironment>,
) => ({
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
  })

/**
 * Toolkit handler Layer. Registering this with `McpServer` (via
 * `McpServer.registerToolkit`) projects the toolkit to MCP `tools/list`
 * and `tools/call`.
 *
 * Host services are captured once when the MCP layer is built; each handler
 * resolves the runtime-owned `ToolDispatch` facade and a route-scoped
 * runtime context at call time.
 */
export const FiregridAgentToolkitLayer = FiregridAgentToolkit.toLayer(
  Effect.map(Effect.context<ToolCallHostEnvironment>(), makeToolkitHandlers),
).pipe(Layer.annotateSpans("firegrid.side", "agent-tools"))

export const FiregridPrimitiveProfileToolkitLayer = FiregridPrimitiveProfileToolkit.toLayer(
  Effect.map(Effect.context<ToolCallHostEnvironment>(), captured => {
    const handlers = makeToolkitHandlers(captured)
    return {
      wait_for: handlers.wait_for,
      wait_for_any: handlers.wait_for_any,
      send: handlers.send,
      call: handlers.call,
    }
  }),
).pipe(Layer.annotateSpans("firegrid.side", "agent-tools"))
