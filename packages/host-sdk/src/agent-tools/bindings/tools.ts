/**
 * Canonical Firegrid agent tools as Effect AI `Tool` values plus a single
 * `Toolkit.make(...)` allowlist (`FiregridAgentToolkit`).
 *
 * BINDING side of the agent-tool boundary
 * (`firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6`): pure protocol-schema →
 * Effect AI `Tool`/`Toolkit` values, the MCP-facing failure schema, and
 * the bridge-scoped routing-context tag. No host execution, lowering, or
 * durable side effects live here — that is the `../execution` module.
 *
 * Adding a tool requires (a) a protocol Effect Schema in
 * `@firegrid/protocol/agent-tools`, (b) a new `Tool.make(...)` here with
 * `setParameters` / `setSuccess` pointing at that schema, (c) inclusion
 * in `Toolkit.make(...)`, and (d) a handler in `FiregridAgentToolkitLayer`
 * (in `../execution`) routing through `toolUseToEffect`.
 *
 * Implements (feature spec):
 *  - firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.1..5
 *  - firegrid-workflow-driven-runtime.AGENT_TOOL_BOUNDARIES.5 (one
 *    schema source of truth in `@firegrid/protocol`)
 *  - firegrid-host-sdk.AGENT_TOOL_BOUNDARY.1..2
 */

import { IdGenerator, Tool, Toolkit } from "@effect/ai"
import { FiregridAgentToolOperations } from "@firegrid/protocol/agent-tools"
import { type RuntimeContext } from "@firegrid/protocol/launch"
import { Context, Effect, Layer } from "effect"
import type { Schema } from "effect"
import { ToolError } from "./tool-error.ts"

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

/**
 * Each Firegrid tool routes its execution through `ToolCallWorkflow`
 * (defined in `../execution`), which gives the underlying
 * `toolUseToEffect` body a `WorkflowEngine.WorkflowInstance`.
 *
 * The execution layer resolves the route-scoped runtime context and runs the
 * tool-call workflow on that context's active per-context engine.
 */
const FiregridToolDependencies: Array<
  | typeof FiregridAgentToolContext
  | typeof IdGenerator.IdGenerator
> = [
  FiregridAgentToolContext,
  IdGenerator.IdGenerator,
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
 * Lowers through `DurableClock.sleep` and the canonical host prompt append
 * seam; the active per-context engine or startup reconciliation owns runtime
 * input delivery.
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
 * set, and `toolUseToEffect` switches on `event.part.name` against the
 * same `@firegrid/protocol/agent-tools` Effect Schemas these `Tool.make`
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
