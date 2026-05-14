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

import { IdGenerator, Tool, Toolkit } from "@effect/ai"
import { Workflow, WorkflowEngine } from "@effect/workflow"
import {
  ExecuteToolInputSchema,
  ExecuteToolOutputSchema,
  ScheduleMeToolInputSchema,
  ScheduleMeToolOutputSchema,
  SleepToolInputSchema,
  SleepToolOutputSchema,
  SpawnAllToolInputSchema,
  SpawnAllToolOutputSchema,
  SpawnToolInputSchema,
  SpawnToolOutputSchema,
  WaitForToolInputSchema,
  WaitForToolOutputSchema,
  type ExecuteToolOutput,
  type ScheduleMeToolOutput,
  type SleepToolOutput,
  type SpawnAllToolOutput,
  type SpawnToolOutput,
  type WaitForToolOutput,
} from "@firegrid/protocol/agent-tools"
import { Context, Effect, Layer, Schema } from "effect"
import { ToolResultEventSchema } from "../agent-io/index.ts"
import { ToolError } from "./tool-error.ts"
import { toolUseToEffect } from "./tool-use-to-effect.ts"

// ---------------------------------------------------------------------------
// MCP-facing tool failure
// ---------------------------------------------------------------------------

/**
 * The runtime-owned MCP-facing tool failure schema. Reuses the existing
 * `ToolError` tagged union from `tool-error.ts` so the structured
 * payload an MCP client observes is the same shape direct codec callers
 * already see in `ToolResult.content.error`. `@effect/ai`'s MCP layer
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
    readonly contextId: string
  }
>() {
  static layer = (options: {
    readonly contextId: string
  }): Layer.Layer<FiregridAgentToolContext> =>
    Layer.succeed(this, options)
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

/**
 * `sleep` — durably suspend until a duration elapses.
 * Lowers onto `DurableClock.sleep` in `toolUseToEffect`.
 */
export const SleepTool = Tool.make("sleep", {
  description: "Durably suspend until a duration elapses.",
  dependencies: FiregridToolDependencies,
})
  .setParameters(SleepToolInputSchema)
  .setSuccess(SleepToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `wait_for` — wait until a matching durable event appears.
 * Lowers onto the durable-tools `WaitFor.match` surface in
 * `toolUseToEffect`.
 */
export const WaitForTool = Tool.make("wait_for", {
  description:
    "Wait until a matching durable event appears, optionally bounded by a timeout.",
  dependencies: FiregridToolDependencies,
})
  .setParameters(WaitForToolInputSchema)
  .setSuccess(WaitForToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `spawn` — run a child RuntimeContextWorkflow and await its terminal
 * state. Lowers onto `AgentToolHost.spawnChildContext` in
 * `toolUseToEffect`.
 */
export const SpawnTool = Tool.make("spawn", {
  description:
    "Run a child RuntimeContextWorkflow with the given prompt and await its terminal state.",
  dependencies: FiregridToolDependencies,
})
  .setParameters(SpawnToolInputSchema)
  .setSuccess(SpawnToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `spawn_all` — fan out child workflows and await every terminal state.
 * Lowers onto `AgentToolHost.spawnChildContexts` in `toolUseToEffect`.
 */
export const SpawnAllTool = Tool.make("spawn_all", {
  description: "Fan out child workflows; await every terminal state.",
  dependencies: FiregridToolDependencies,
})
  .setParameters(SpawnAllToolInputSchema)
  .setSuccess(SpawnAllToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `schedule_me` — schedule a future prompt to the same agent context.
 * Lowers onto `ScheduledInputWorkflow.execute({ discard: true })` in
 * `toolUseToEffect`.
 */
export const ScheduleMeTool = Tool.make("schedule_me", {
  description: "Schedule a future prompt to the same agent context.",
  dependencies: FiregridToolDependencies,
})
  .setParameters(ScheduleMeToolInputSchema)
  .setSuccess(ScheduleMeToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `execute` — invoke a SandboxProvider-backed tool by sandbox-neutral
 * reference. Lowers onto `AgentToolHost.executeSandboxTool` in
 * `toolUseToEffect`.
 */
export const ExecuteTool = Tool.make("execute", {
  description:
    "Invoke a SandboxProvider-backed tool by sandbox-neutral reference.",
  dependencies: FiregridToolDependencies,
})
  .setParameters(ExecuteToolInputSchema)
  .setSuccess(ExecuteToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * Canonical Firegrid agent toolkit. The single source of truth for tool
 * exposure: codecs publish this set, MCP `tools/list` projects this
 * set, and `toolUseToEffect` switches on `event.name` against the same
 * `@firegrid/protocol/agent-tools` Effect Schemas these `Tool.make`
 * values bind. The toolkit value and the lowering's name-switch share
 * one schema source of truth (`@firegrid/protocol/agent-tools`); they
 * do not maintain parallel registries.
 */
export const FiregridAgentToolkit = Toolkit.make(
  SleepTool,
  WaitForTool,
  SpawnTool,
  SpawnAllTool,
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
      { _tag: "ToolUse", toolUseId, name: toolName, input },
    ),
)

/**
 * Common handler shape: every tool routes through `toolUseToEffect` so
 * tool calls observe the same workflow identity, replay safety, and
 * host seams as direct codec paths.
 *
 *   1. Generate a non-durable `toolUseId` via `IdGenerator` (deterministic
 *      workflow identities still come from durable idempotency keys
 *      derived inside `toolUseToEffect`, e.g.,
 *      `schedule-me:${contextId}:${toolUseId}`).
 *   2. Build a normalized `ToolUse` event.
 *   3. Run `toolUseToEffect` and inspect `ToolResult.isError`.
 *   4. On success, return `ToolResult.content` typed against the tool
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
    const toolUseId = `${TOOL_USE_ID_PREFIX}:${ctx.contextId}:${idSuffix}`
    const result = yield* ToolCallWorkflow.execute({
      contextId: ctx.contextId,
      toolUseId,
      toolName,
      input: params,
    })
    if (result.isError) {
      const error = extractToolFailure(result.content)
      return yield* Effect.fail(error)
    }
    return result.content as Output
  })

/**
 * Pull a structured `ToolError` out of `ToolResult.content`. The
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
  spawn: (params) => handleTool<SpawnToolOutput>("spawn", params),
  spawn_all: (params) => handleTool<SpawnAllToolOutput>("spawn_all", params),
  schedule_me: (params) =>
    handleTool<ScheduleMeToolOutput>("schedule_me", params),
  execute: (params) => handleTool<ExecuteToolOutput>("execute", params),
})

