/**
 * EXECUTION side of the agent-tool boundary
 * (`firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6`): the toolkit handler Layer
 * that routes every registered tool through the unified-owned `ToolDispatch`
 * facade (`./tool-dispatch.ts`).
 *
 * The binding values (`Tool`/`Toolkit`, failure schema, routing tag) live in
 * `./toolkit.ts`; this module composes them with the dispatch Tag.
 *
 * Each handler returns `Effect<Output, ToolError>`: on success the tool
 * output (which `@effect/ai`'s `McpServer.registerToolkit` lowers into a
 * `CallToolResult`), on failure a typed `ToolError` (the tool's
 * `.setFailure` schema). With the Tools' default `failureMode: "error"`,
 * `registerToolkit` catches that failure via `Effect.match` and builds
 * `CallToolResult{isError:true, structuredContent: <ToolError>}` — we do NOT
 * build the MCP result ourselves. (The MCP-entry path is relay-free; the
 * `ToolResultEvent` → `AgentInputEvent` lowering is wire-path machinery and
 * lives in the future wire-path slice, not here.)
 */

import { IdGenerator } from "@effect/ai"
import type * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import type {
  SessionCreateOrLoadInput,
  SessionHandleReference,
} from "@firegrid/protocol/session-facade"
import { type Context, Effect, Layer } from "effect"
import { ToolDispatch } from "./tool-dispatch.ts"
import { type ToolError, toolExecutionFailed } from "./tool-error.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridPrimitiveProfileToolkit,
} from "./toolkit.ts"

const TOOL_USE_ID_PREFIX = "mcp"

type ToolCallHostEnvironment = ToolDispatch

/**
 * Common handler shape: every tool dispatches through the unified-owned
 * `ToolDispatch` facade so MCP-entry tool calls observe the same workflow
 * identity and at-most-once (`Workflow.idempotencyKey: toolUseId`) as the
 * direct codec path. Context routing is resolved host-side from
 * `FiregridAgentToolContext`, never an agent-visible argument.
 *
 * The error channel is `ToolError` (the tool's `.setFailure` schema), so a
 * dispatch failure propagates as a typed agent-tool failure that the
 * library lowers to `CallToolResult{isError:true}`.
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
      Effect.mapError((cause): ToolError =>
        toolExecutionFailed(
          `${TOOL_USE_ID_PREFIX}:unrouted:${idSuffix}`,
          toolName,
          cause,
        )),
    )
    const toolUseId = `${TOOL_USE_ID_PREFIX}:${resolved.contextId}:${idSuffix}`
    if (resolved.runtimeContext === undefined) {
      return yield* toolExecutionFailed(
        toolUseId,
        toolName,
        "MCP tool execution requires a resolved runtime context",
      )
    }
    const dispatch = yield* ToolDispatch
    return (yield* dispatch.call({
      contextId: resolved.contextId,
      toolUseId,
      toolName,
      input: params,
    })) as Output
  }).pipe(
    Effect.provide(captured),
    Effect.annotateSpans("firegrid.side", "agent-tools"),
  )

const makeToolkitHandlers = (
  captured: Context.Context<ToolCallHostEnvironment>,
) => ({
    sleep: (params: AgentToolSchemas.SleepToolInput) =>
      handleTool<AgentToolSchemas.SleepToolOutput>(captured, "sleep", params),
    wait_for: (params: AgentToolSchemas.WaitForToolInput) =>
      handleTool<AgentToolSchemas.WaitForToolOutput>(captured, "wait_for", params),
    wait_until: (params: AgentToolSchemas.WaitUntilToolInput) =>
      handleTool<AgentToolSchemas.WaitUntilToolOutput>(captured, "wait_until", params),
    send: (params: AgentToolSchemas.SendToolInput) =>
      handleTool<AgentToolSchemas.SendToolOutput>(captured, "send", params),
    call: (params: AgentToolSchemas.CallToolInput) =>
      handleTool<AgentToolSchemas.CallToolOutput>(captured, "call", params),
    wait_any: (params: AgentToolSchemas.WaitAnyToolInput) =>
      handleTool<AgentToolSchemas.WaitAnyToolOutput>(captured, "wait_any", params),
    session_new: (params: AgentToolSchemas.SessionNewToolInput) =>
      handleTool<AgentToolSchemas.SessionNewToolOutput>(captured, "session_new", params),
    session_prompt: (params: AgentToolSchemas.SessionPromptToolInput) =>
      handleTool<AgentToolSchemas.SessionPromptToolOutput>(captured, "session_prompt", params),
    session_cancel: (params: AgentToolSchemas.SessionCancelToolInput) =>
      handleTool<AgentToolSchemas.SessionCancelToolOutput>(captured, "session_cancel", params),
    session_close: (params: AgentToolSchemas.SessionCloseToolInput) =>
      handleTool<AgentToolSchemas.SessionCloseToolOutput>(captured, "session_close", params),
    session_create_or_load: (params: SessionCreateOrLoadInput) =>
      handleTool<SessionHandleReference>(captured, "session_create_or_load", params),
    execute: (params: AgentToolSchemas.ExecuteToolInput) =>
      handleTool<AgentToolSchemas.ExecuteToolOutput>(captured, "execute", params),
  })

/**
 * Toolkit handler Layer. Registering this with `McpServer` (via
 * `McpServer.registerToolkit`) projects the toolkit to MCP `tools/list` and
 * `tools/call`. Host services are captured once when the MCP layer is
 * built; each handler resolves the `ToolDispatch` facade and a route-scoped
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
      wait_any: handlers.wait_any,
      send: handlers.send,
      call: handlers.call,
    }
  }),
).pipe(Layer.annotateSpans("firegrid.side", "agent-tools"))
