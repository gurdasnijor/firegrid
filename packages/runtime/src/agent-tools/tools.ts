/**
 * Canonical Firegrid agent tools as Effect AI `Tool` values plus a single
 * `Toolkit.make(...)` allowlist (`FiregridAgentToolkit`).
 *
 * The toolkit is the public contract and the exposure manifest. Adding
 * a tool requires (a) a protocol Effect Schema in
 * `@firegrid/protocol/agent-tools`, (b) a new `Tool.make(...)` here with
 * `setParameters` / `setSuccess` pointing at that schema, (c) inclusion
 * in `Toolkit.make(...)`, and (d) a handler in `FiregridAgentToolkitLayer`
 * routing through `toolUseToEffect`.
 *
 * The toolkit is consumed by:
 *  - `@effect/ai/McpServer.registerToolkit(FiregridAgentToolkit)` for
 *    MCP `tools/list` and `tools/call`.
 *  - In-process Effect AI / direct toolkit handler execution for unit
 *    tests and future provider-backed agent sessions.
 *  - Downstream codecs that read `Tool.name`, `Tool.description`,
 *    `Tool.parametersSchema`, and `Tool.successSchema` rather than
 *    maintaining a parallel descriptor catalog.
 *
 * Implements (SDD):
 *  - SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md §"V0: Effect AI Tools + Local MCP Layer"
 *  - SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md §"Schema Projection And Exposure"
 *  - SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md §"Runtime Semantics"
 *
 * Implements (feature spec):
 *  - firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.1..5
 *  - firegrid-workflow-driven-runtime.AGENT_TOOL_BOUNDARIES.5 (one
 *    schema source of truth in `@firegrid/protocol`)
 */

import { IdGenerator, Prompt, Tool, Toolkit } from "@effect/ai"
import { Workflow, WorkflowEngine } from "@effect/workflow"
import {
  FiregridAgentToolOperations,
  type ExecuteToolOutput,
  type ScheduleMeToolOutput,
  type SessionCancelToolOutput,
  type SessionCloseToolOutput,
  type SessionNewToolOutput,
  type SessionPromptToolOutput,
  type SleepToolOutput,
  type WaitForToolOutput,
} from "@firegrid/protocol/agent-tools"
import { type RuntimeContext } from "@firegrid/protocol/launch"
import { Context, Effect, Layer, Schema } from "effect"
import { ToolResultEventSchema } from "../agent-io/index.ts"
import { provideRuntimeContext } from "../runtime-host/host-context-authority.ts"
import { ToolError, toolExecutionFailed } from "./tool-error.ts"
import { toolUseToEffect } from "./tool-use-to-effect.ts"

// ---------------------------------------------------------------------------
// MCP-facing tool failure
// ---------------------------------------------------------------------------

/**
 * The runtime-owned MCP-facing tool failure schema. Reuses the existing
 * `ToolError` tagged union from `tool-error.ts` so the structured
 * payload an MCP client observes is the same shape direct codec callers
 * already see in `ToolResult.part.result.error`. `@effect/ai`'s MCP layer
 * maps a failed Effect AI tool handler to `CallToolResult.isError ===
 * true` with `structuredContent` set to this payload.
 *
 * Tool failures are agent-visible results, not workflow failures.
 */
export const FiregridMcpToolFailureSchema = ToolError
export type FiregridMcpToolFailure = Schema.Schema.Type<
  typeof FiregridMcpToolFailureSchema
>

// ---------------------------------------------------------------------------
// Runtime-context routing
// ---------------------------------------------------------------------------

/**
 * Bridge-scoped runtime context. The MCP bridge is configured for one
 * runtime context (`/mcp/runtime-context/:contextId` per the SDD); tool
 * handlers read the context id from this service rather than accepting
 * it as an agent-visible argument. Per SDD §"Authentication And Routing":
 * "Context routing is not a tool argument."
 *
 * Tests provide a stub service via `FiregridAgentToolContext.layer({
 * contextId })`.
 */
export class FiregridAgentToolContext extends Context.Tag(
  "firegrid/agent-tools/FiregridAgentToolContext",
)<
  FiregridAgentToolContext,
  {
    readonly resolve: Effect.Effect<{
      readonly contextId: string
      readonly runtimeContext?: RuntimeContext
    }, unknown>
  }
>() {
  static layer = (options: {
    readonly contextId: string
  }): Layer.Layer<FiregridAgentToolContext> =>
    Layer.succeed(this, {
      resolve: Effect.succeed({ contextId: options.contextId }),
    })
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_USE_ID_PREFIX = "mcp"

/**
 * Each Firegrid tool routes its execution through `ToolCallWorkflow`
 * (defined below), which gives the underlying `toolUseToEffect` body
 * a `WorkflowEngine.WorkflowInstance` and lets it compose
 * `DurableClock.sleep`, durable-tools `WaitFor.match`, and child
 * workflow executions safely.
 *
 * From the toolkit handler's perspective, the required services are
 * just the bridge runtime-context routing, the id generator, and the
 * workflow engine entrypoint (`Workflow.execute`). The workflow body
 * pulls in its own services through `ToolCallWorkflowLayer`'s `R`
 * channel.
 *
 * Declaring these here surfaces them through `Tool.Requirements<T>` so
 * `Toolkit.toLayer` typechecks the handlers cleanly.
 */
// Tried trimming to `[FiregridAgentToolContext, IdGenerator.IdGenerator]`
// per review-step C; `Workflow.execute(ToolCallWorkflow, ...)` carries
// `WorkflowEngine.WorkflowEngine` in its `R` channel, so the toolkit
// handler's requirements include it and the tool must declare it. The
// minimum surface that typechecks is the three services below.
const FiregridToolDependencies: Array<
  | typeof FiregridAgentToolContext
  | typeof IdGenerator.IdGenerator
  | typeof WorkflowEngine.WorkflowEngine
> = [
  FiregridAgentToolContext,
  IdGenerator.IdGenerator,
  WorkflowEngine.WorkflowEngine,
]

const operationToolName = <Name extends string>(
  metadata: { readonly toolName?: string },
  expected: Name,
): Name => (metadata.toolName ?? expected) as Name

const operationDescription = (
  operation: { readonly description: string },
): string => operation.description

/**
 * `sleep` — durably suspend until a duration elapses.
 * Lowers onto `DurableClock.sleep` in `toolUseToEffect`.
 */
export const SleepTool = Tool.make(operationToolName(FiregridAgentToolOperations.sleep.metadata, "sleep"), {
  description: operationDescription(FiregridAgentToolOperations.sleep),
  dependencies: FiregridToolDependencies,
})
  .setParameters(FiregridAgentToolOperations.sleep.inputSchema)
  .setSuccess(FiregridAgentToolOperations.sleep.outputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `wait_for` — wait until a matching durable event appears.
 * Lowers onto the durable-tools `WaitFor.match` surface in
 * `toolUseToEffect`.
 */
export const WaitForTool = Tool.make(operationToolName(FiregridAgentToolOperations.waitFor.metadata, "wait_for"), {
  description: operationDescription(FiregridAgentToolOperations.waitFor),
  dependencies: FiregridToolDependencies,
})
  .setParameters(FiregridAgentToolOperations.waitFor.inputSchema)
  .setSuccess(FiregridAgentToolOperations.waitFor.outputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `spawn` — run a child RuntimeContextWorkflow and await its terminal
 * state. Lowers onto `AgentToolHost.spawnChildContext` in
 * `toolUseToEffect`.
 */
export const SpawnTool = Tool.make(operationToolName(FiregridAgentToolOperations.spawn.metadata, "spawn"), {
  description: operationDescription(FiregridAgentToolOperations.spawn),
  dependencies: FiregridToolDependencies,
})
  .setParameters(FiregridAgentToolOperations.spawn.inputSchema)
  .setSuccess(FiregridAgentToolOperations.spawn.outputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `spawn_all` — fan out child workflows and await every terminal state.
 * Lowers onto `AgentToolHost.spawnChildContexts` in `toolUseToEffect`.
 */
export const SpawnAllTool = Tool.make(operationToolName(FiregridAgentToolOperations.spawnAll.metadata, "spawn_all"), {
  description: operationDescription(FiregridAgentToolOperations.spawnAll),
  dependencies: FiregridToolDependencies,
})
  .setParameters(FiregridAgentToolOperations.spawnAll.inputSchema)
  .setSuccess(FiregridAgentToolOperations.spawnAll.outputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `session_new` — create a child RuntimeContext-backed session.
 * Lowers onto the internal `AgentToolHost.spawnChildContext` seam in
 * `toolUseToEffect`.
 */
export const SessionNewTool = Tool.make(operationToolName(FiregridAgentToolOperations.sessionCreate.metadata, "session_new"), {
  description: operationDescription(FiregridAgentToolOperations.sessionCreate),
  dependencies: FiregridToolDependencies,
})
  .setParameters(FiregridAgentToolOperations.sessionCreate.inputSchema)
  .setSuccess(FiregridAgentToolOperations.sessionCreate.outputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `session_prompt` — append a prompt to an existing session using
 * host-owned runtime ingress.
 */
export const SessionPromptTool = Tool.make(operationToolName(FiregridAgentToolOperations.sessionPrompt.metadata, "session_prompt"), {
  description: operationDescription(FiregridAgentToolOperations.sessionPrompt),
  dependencies: FiregridToolDependencies,
})
  .setParameters(FiregridAgentToolOperations.sessionPrompt.inputSchema)
  .setSuccess(FiregridAgentToolOperations.sessionPrompt.outputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `session_cancel` — request cancellation of an existing session.
 */
export const SessionCancelTool = Tool.make(operationToolName(FiregridAgentToolOperations.sessionCancel.metadata, "session_cancel"), {
  description: operationDescription(FiregridAgentToolOperations.sessionCancel),
  dependencies: FiregridToolDependencies,
})
  .setParameters(FiregridAgentToolOperations.sessionCancel.inputSchema)
  .setSuccess(FiregridAgentToolOperations.sessionCancel.outputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `session_close` — request closure of an existing session.
 */
export const SessionCloseTool = Tool.make(operationToolName(FiregridAgentToolOperations.sessionClose.metadata, "session_close"), {
  description: operationDescription(FiregridAgentToolOperations.sessionClose),
  dependencies: FiregridToolDependencies,
})
  .setParameters(FiregridAgentToolOperations.sessionClose.inputSchema)
  .setSuccess(FiregridAgentToolOperations.sessionClose.outputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `schedule_me` — schedule a future prompt to the same agent context.
 * Lowers onto `ScheduledInputWorkflow.execute({ discard: true })` in
 * `toolUseToEffect`.
 */
export const ScheduleMeTool = Tool.make(operationToolName(FiregridAgentToolOperations.scheduleMe.metadata, "schedule_me"), {
  description: operationDescription(FiregridAgentToolOperations.scheduleMe),
  dependencies: FiregridToolDependencies,
})
  .setParameters(FiregridAgentToolOperations.scheduleMe.inputSchema)
  .setSuccess(FiregridAgentToolOperations.scheduleMe.outputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `execute` — invoke a SandboxProvider-backed tool by sandbox-neutral
 * reference. Lowers onto `AgentToolHost.executeSandboxTool` in
 * `toolUseToEffect`.
 */
export const ExecuteTool = Tool.make(operationToolName(FiregridAgentToolOperations.execute.metadata, "execute"), {
  description: operationDescription(FiregridAgentToolOperations.execute),
  dependencies: FiregridToolDependencies,
})
  .setParameters(FiregridAgentToolOperations.execute.inputSchema)
  .setSuccess(FiregridAgentToolOperations.execute.outputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * Canonical Firegrid agent toolkit. The single source of truth for tool
 * exposure: codecs publish this set, MCP `tools/list` projects this
 * set, and `toolUseToEffect` switches on `event.part.name` against the same
 * `@firegrid/protocol/agent-tools` Effect Schemas these `Tool.make`
 * values bind. The toolkit value and the lowering's name-switch share
 * one schema source of truth (`@firegrid/protocol/agent-tools`); they
 * do not maintain parallel registries.
 */
export const FiregridAgentToolkit = Toolkit.make(
  SleepTool,
  WaitForTool,
  SessionNewTool,
  SessionPromptTool,
  SessionCancelTool,
  SessionCloseTool,
  ScheduleMeTool,
  ExecuteTool,
)

// ---------------------------------------------------------------------------
// Tool-call workflow — required only so `toolUseToEffect` runs inside a
// `WorkflowEngine.WorkflowInstance`
// ---------------------------------------------------------------------------
//
// `@effect/workflow`'s `DurableClock.sleep` (and therefore the `sleep` arm,
// `WaitFor.match`, and any child workflow execution in `toolUseToEffect`)
// requires the `WorkflowInstance` service in its `R` channel, and
// `WorkflowInstance` is only produced inside a registered workflow body
// (`Workflow.toLayer(...)`). The McpServer composition cannot construct
// one on its own. This ephemeral per-call workflow exists solely to
// satisfy that requirement — it is NOT an idempotency-as-replay-safety
// layer in V0 (each MCP request generates a fresh `toolUseId`, so the
// `idempotencyKey` is deterministic naming for the workflow engine's
// state but does not produce cross-retry dedup). V1's
// `AgentToolInvocationFact` is where durable retry identity belongs.

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
 *
 *   1. Generate a non-durable `toolUseId` via `IdGenerator`.
 *      firegrid-agent-io-effect-ai-alignment.EFFECT_AI_BOUNDARIES.1
 *      Deterministic
 *      workflow identities still come from durable idempotency keys
 *      derived inside `toolUseToEffect`, e.g.,
 *      `schedule-me:${contextId}:${toolUseId}`).
 *   2. Build a normalized `ToolUse` event.
 *   3. Run `toolUseToEffect` and inspect `ToolResult.part.isFailure`.
 *   4. On success, return `ToolResult.part.result` typed against the tool
 *      success schema. The toolkit re-validates / encodes via
 *      `Schema.validate` + `Schema.encodeUnknown`.
 *   5. On error, fail with the structured `FiregridMcpToolFailure`
 *      payload. `@effect/ai/McpServer` maps the failure to
 *      `CallToolResult.isError === true`.
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
 * and `tools/call`. Tests can also consume `FiregridAgentToolkit` (as
 * an Effect that produces `WithHandler`) for direct in-process toolkit
 * execution.
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
