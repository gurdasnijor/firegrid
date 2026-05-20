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
import * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import { type RuntimeContext } from "@firegrid/protocol/launch"
import { getFiregridProjectionMetadata } from "@firegrid/protocol/projection"
import { Context, Effect, Layer, Option, SchemaAST } from "effect"
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
 * tool-call workflow on that context's active host-scoped RuntimeContext engine.
 */
const FiregridToolDependencies: Array<
  | typeof FiregridAgentToolContext
  | typeof IdGenerator.IdGenerator
> = [
  FiregridAgentToolContext,
  IdGenerator.IdGenerator,
]

const schemaToolName = <Name extends string>(
  schema: { readonly ast: SchemaAST.AST },
  expected: Name,
): Name =>
  (Option.getOrUndefined(getFiregridProjectionMetadata(schema))?.toolName ??
    expected) as Name

const schemaDescription = (
  schema: { readonly ast: SchemaAST.AST },
  fallback: string,
): string => {
  const description = schema.ast.annotations[SchemaAST.DescriptionAnnotationId]
  return typeof description === "string" ? description : fallback
}

/**
 * `sleep` — durably suspend until a duration elapses.
 * Lowers onto `DurableClock.sleep` in `toolUseToEffect`.
 */
export const SleepTool = Tool.make(schemaToolName(AgentToolSchemas.SleepToolInputSchema, "sleep"), {
  description: schemaDescription(AgentToolSchemas.SleepToolInputSchema, "sleep"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.SleepToolInputSchema)
  .setSuccess(AgentToolSchemas.SleepToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `wait_for` — wait until a matching durable event appears.
 * Lowers onto the runtime-owned `WaitForWorkflow` surface in `toolUseToEffect`.
 */
export const WaitForTool = Tool.make(schemaToolName(AgentToolSchemas.WaitForToolInputSchema, "wait_for"), {
  description: schemaDescription(AgentToolSchemas.WaitForToolInputSchema, "wait_for"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.WaitForToolInputSchema)
  .setSuccess(AgentToolSchemas.WaitForToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `send` — append a payload to an egress channel.
 * firegrid-agent-body-plan.SLICE_D_VERBS.1
 */
export const SendTool = Tool.make(schemaToolName(AgentToolSchemas.SendToolInputSchema, "send"), {
  description: schemaDescription(AgentToolSchemas.SendToolInputSchema, "send"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.SendToolInputSchema)
  .setSuccess(AgentToolSchemas.SendToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `wait_for_any` — race waits over ingress channels and return the first
 * matching row.
 * firegrid-agent-body-plan.SLICE_D_VERBS.1
 */
export const WaitForAnyTool = Tool.make(schemaToolName(AgentToolSchemas.WaitForAnyToolInputSchema, "wait_for_any"), {
  description: schemaDescription(AgentToolSchemas.WaitForAnyToolInputSchema, "wait_for_any"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.WaitForAnyToolInputSchema)
  .setSuccess(AgentToolSchemas.WaitForAnyToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `spawn` — run a child RuntimeContextWorkflow and await its terminal
 * state. Lowers onto `AgentToolHost.spawnChildContext` in
 * `toolUseToEffect`.
 */
export const SpawnTool = Tool.make(schemaToolName(AgentToolSchemas.SpawnToolInputSchema, "spawn"), {
  description: schemaDescription(AgentToolSchemas.SpawnToolInputSchema, "spawn"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.SpawnToolInputSchema)
  .setSuccess(AgentToolSchemas.SpawnToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `spawn_all` — fan out child workflows and await every terminal state.
 * Lowers onto `AgentToolHost.spawnChildContexts` in `toolUseToEffect`.
 */
export const SpawnAllTool = Tool.make(schemaToolName(AgentToolSchemas.SpawnAllToolInputSchema, "spawn_all"), {
  description: schemaDescription(AgentToolSchemas.SpawnAllToolInputSchema, "spawn_all"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.SpawnAllToolInputSchema)
  .setSuccess(AgentToolSchemas.SpawnAllToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `session_new` — create a child RuntimeContext-backed session.
 * Lowers onto the internal `AgentToolHost.spawnChildContext` seam in
 * `toolUseToEffect`.
 */
export const SessionNewTool = Tool.make(schemaToolName(AgentToolSchemas.SessionNewToolInputSchema, "session_new"), {
  description: schemaDescription(AgentToolSchemas.SessionNewToolInputSchema, "session_new"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.SessionNewToolInputSchema)
  .setSuccess(AgentToolSchemas.SessionNewToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `session_prompt` — append a prompt to an existing session using
 * host-owned runtime ingress.
 */
export const SessionPromptTool = Tool.make(schemaToolName(AgentToolSchemas.SessionPromptToolInputSchema, "session_prompt"), {
  description: schemaDescription(AgentToolSchemas.SessionPromptToolInputSchema, "session_prompt"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.SessionPromptToolInputSchema)
  .setSuccess(AgentToolSchemas.SessionPromptToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `session_cancel` — request cancellation of an existing session.
 */
export const SessionCancelTool = Tool.make(schemaToolName(AgentToolSchemas.SessionCancelToolInputSchema, "session_cancel"), {
  description: schemaDescription(AgentToolSchemas.SessionCancelToolInputSchema, "session_cancel"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.SessionCancelToolInputSchema)
  .setSuccess(AgentToolSchemas.SessionCancelToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `session_close` — request closure of an existing session.
 */
export const SessionCloseTool = Tool.make(schemaToolName(AgentToolSchemas.SessionCloseToolInputSchema, "session_close"), {
  description: schemaDescription(AgentToolSchemas.SessionCloseToolInputSchema, "session_close"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.SessionCloseToolInputSchema)
  .setSuccess(AgentToolSchemas.SessionCloseToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `schedule_me` — schedule a future prompt to the same agent context.
 * Lowers through `DurableClock.sleep` and the canonical host prompt append
 * seam; the active host-scoped RuntimeContext engine or startup reconciliation owns runtime
 * input delivery.
 */
export const ScheduleMeTool = Tool.make(schemaToolName(AgentToolSchemas.ScheduleMeToolInputSchema, "schedule_me"), {
  description: schemaDescription(AgentToolSchemas.ScheduleMeToolInputSchema, "schedule_me"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.ScheduleMeToolInputSchema)
  .setSuccess(AgentToolSchemas.ScheduleMeToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `execute` — invoke a SandboxProvider-backed tool by sandbox-neutral
 * reference. Lowers onto `AgentToolHost.executeSandboxTool` in
 * `toolUseToEffect`.
 */
export const ExecuteTool = Tool.make(schemaToolName(AgentToolSchemas.ExecuteToolInputSchema, "execute"), {
  description: schemaDescription(AgentToolSchemas.ExecuteToolInputSchema, "execute"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.ExecuteToolInputSchema)
  .setSuccess(AgentToolSchemas.ExecuteToolOutputSchema)
  .setFailure(FiregridMcpToolFailureSchema)

/**
 * `call` — invoke an approval call channel.
 * Lowers onto `AgentToolHost.callApprovalChannel` in `toolUseToEffect`.
 */
export const CallTool = Tool.make(schemaToolName(AgentToolSchemas.CallToolInputSchema, "call"), {
  description: schemaDescription(AgentToolSchemas.CallToolInputSchema, "call"),
  dependencies: FiregridToolDependencies,
})
  .setParameters(AgentToolSchemas.CallToolInputSchema)
  .setSuccess(AgentToolSchemas.CallToolOutputSchema)
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
  SendTool,
  SessionNewTool,
  SessionPromptTool,
  SessionCancelTool,
  SessionCloseTool,
  ScheduleMeTool,
  ExecuteTool,
  CallTool,
  WaitForAnyTool,
)
