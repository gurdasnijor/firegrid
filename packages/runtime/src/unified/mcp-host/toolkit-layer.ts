/**
 * EXECUTION side of the agent-tool boundary
 * (`firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6`): the toolkit handler Layer
 * that routes every registered tool through the unified-owned
 * `ToolDispatch` facade (`./tool-dispatch.ts`).
 *
 * The binding values (`Tool`/`Toolkit`, failure schema, routing tag) live
 * in `./toolkit.ts`; this module composes them with the dispatch Tag.
 *
 * Option B (tf-r06u.28): handler dispatch goes through `ToolDispatch.call`,
 * which drives the relay-free MCP-entry `McpToolDispatchWorkflow` over
 * #765's unified substrate — NOT main's deleted `ToolCallWorkflow`. The
 * handlers are uniform: every tool resolves the route-scoped context and
 * calls the facade; what each tool actually does lives in the shared
 * `FiregridAgentToolExecutor`.
 */

import { IdGenerator } from "@effect/ai"
import type * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import { type Context, Effect, Layer } from "effect"
import { ToolDispatch } from "./tool-dispatch.ts"
import { toolExecutionFailed } from "./tool-error.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridPrimitiveProfileToolkit,
  type FiregridMcpToolFailure,
} from "./toolkit.ts"

const TOOL_USE_ID_PREFIX = "mcp"

type ToolCallHostEnvironment = ToolDispatch

/**
 * Common handler shape: every tool dispatches through the unified-owned
 * `ToolDispatch` facade so MCP-entry tool calls observe the same workflow
 * identity and at-most-once (`Workflow.idempotencyKey: toolUseId`) as the
 * direct codec path. Context routing is resolved host-side from
 * `FiregridAgentToolContext`, never an agent-visible argument.
 */
const handleTool = <Output>(
  captured: Context.Context<ToolCallHostEnvironment>,
  toolName: string,
  params: unknown,
) =>
  Effect.gen(function*() {
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
 * resolves the `ToolDispatch` facade and a route-scoped runtime context at
 * call time.
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
