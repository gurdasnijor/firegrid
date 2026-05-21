/**
 * EXECUTION side of the agent-tool boundary
 * (`firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6`): the per-call workflow that
 * gives runtime-owned tool execution a workflow instance, and the toolkit
 * handler Layer that routes every registered tool through the host-side
 * lowering.
 *
 * The binding values (`Tool`/`Toolkit`, failure schema, routing tag) live
 * in `../bindings`; this module composes them with host execution.
 */

import { IdGenerator } from "@effect/ai"
import type * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import {
  provideRuntimeContext,
} from "@firegrid/protocol/launch"
import {
  ToolCallWorkflow,
} from "@firegrid/runtime/tool-executor"
import { type Context, Effect, Layer } from "effect"
import { toolExecutionFailed } from "../bindings/tool-error.ts"
import {
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridPrimitiveProfileToolkit,
  type FiregridMcpToolFailure,
} from "../bindings/tools.ts"
import { AgentToolHost } from "./tool-host.ts"
import {
  RuntimeContextWorkflowRuntime,
} from "../../host/runtime-context-workflow-runtime.ts"
import type { RuntimeContextMcpChannelCatalog } from "../../host/channel.ts"
import {
  toolCallWorkflowSupportLayer,
  type HostRuntimeContextExecutionEnv,
} from "../../host/runtime-context-workflow-support.ts"

const TOOL_USE_ID_PREFIX = "mcp"

export { ToolCallWorkflow } from "@firegrid/runtime/tool-executor"
export { RuntimeToolCallWorkflowLayer as ToolCallWorkflowLayer } from "@firegrid/runtime/tool-executor"

// TFIND-031: includes the host runtime context that deferred tool
// handlers genuinely require. The execution-scoped observation substrate
// is provided inside the tool-call workflow support layer instead of
// leaking onto every MCP tool handler.
type ToolCallHostEnvironment =
  | RuntimeContextWorkflowRuntime
  | AgentToolHost
  | RuntimeContextMcpChannelCatalog
  | HostRuntimeContextExecutionEnv

/**
 * Common handler shape: every tool routes through the runtime-owned
 * tool-call workflow so tool calls observe the same workflow identity,
 * replay safety, and host seams as direct codec paths.
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
 * still resolves its route-scoped runtime context at call time and then runs
 * the tool-call workflow on that context's active host-scoped RuntimeContext engine.
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
