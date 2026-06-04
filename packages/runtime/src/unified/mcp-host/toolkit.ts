/**
 * Canonical Firegrid agent tools as Effect AI `Tool` values plus a single
 * `Toolkit.make(...)` allowlist (`FiregridAgentToolkit`).
 *
 * BINDING side of the agent-tool boundary
 * (`firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6`): pure protocol-schema →
 * Effect AI `Tool`/`Toolkit` values, the MCP-facing failure schema, and
 * the bridge-scoped routing-context tag. No host execution, lowering, or
 * durable side effects live here — that is `./tool-dispatch.ts`
 * (`FiregridAgentToolExecutor`, which drives the unified
 * `ToolDispatchWorkflow`).
 *
 * Adding a tool requires (a) a protocol Effect Schema in
 * `@firegrid/protocol/agent-tools`, (b) inclusion in the schema group list
 * here, and (c) a handler in `FiregridAgentToolkitLayer`
 * (in `./toolkit-layer.ts`) routing through `ToolDispatch.call`.
 *
 * Implements (feature spec):
 *  - firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.1..5
 *  - firegrid-workflow-driven-runtime.AGENT_TOOL_BOUNDARIES.5 (one
 *    schema source of truth in `@firegrid/protocol`)
 *  - firegrid-host-sdk.AGENT_TOOL_BOUNDARY.1..2
 */

import { IdGenerator, Tool, Toolkit } from "@effect/ai"
import * as AgentToolSchemas from "@firegrid/protocol/agent-tools"
import {
  SessionCreateOrLoadInputSchema,
  SessionHandleReferenceSchema,
} from "@firegrid/protocol/session-facade"
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
 * Each Firegrid tool routes its execution through the unified
 * `ToolDispatchWorkflow` (`../subscribers/permission-and-tool.ts`),
 * idempotency-keyed on `toolUseId`. The toolkit handler
 * (`./toolkit-layer.ts`) resolves the `ToolDispatch` facade
 * (`./tool-dispatch.ts`) and calls it; the facade drives the workflow,
 * whose injected `FiregridAgentToolExecutor` maps each tool name onto a
 * unified substrate primitive. (Option B: reuse #765's unified dispatch,
 * NOT main's deleted `ToolCallWorkflow` / `toolUseToEffect`.)
 *
 * The handler resolves the route-scoped runtime context from
 * `FiregridAgentToolContext` and never accepts it as an agent-visible
 * argument.
 */
const FiregridToolDependencies: Array<
  | typeof FiregridAgentToolContext
  | typeof IdGenerator.IdGenerator
> = [
  FiregridAgentToolContext,
  IdGenerator.IdGenerator,
]

const schemaDescription = (
  schema: { readonly ast: SchemaAST.AST },
  fallback: string,
): string => {
  const description = schema.ast.annotations[SchemaAST.DescriptionAnnotationId]
  return typeof description === "string" ? description : fallback
}

const AGENT_TOOL_GROUPS = [
  {
    input: AgentToolSchemas.SleepToolInputSchema,
    output: AgentToolSchemas.SleepToolOutputSchema,
  },
  {
    input: AgentToolSchemas.WaitForToolInputSchema,
    output: AgentToolSchemas.WaitForToolOutputSchema,
  },
  {
    input: AgentToolSchemas.WaitUntilToolInputSchema,
    output: AgentToolSchemas.WaitUntilToolOutputSchema,
  },
  {
    input: AgentToolSchemas.WaitAnyToolInputSchema,
    output: AgentToolSchemas.WaitAnyToolOutputSchema,
  },
  {
    input: AgentToolSchemas.SendToolInputSchema,
    output: AgentToolSchemas.SendToolOutputSchema,
  },
  {
    input: AgentToolSchemas.SessionNewToolInputSchema,
    output: AgentToolSchemas.SessionNewToolOutputSchema,
  },
  {
    input: AgentToolSchemas.SessionPromptToolInputSchema,
    output: AgentToolSchemas.SessionPromptToolOutputSchema,
  },
  {
    input: AgentToolSchemas.SessionCancelToolInputSchema,
    output: AgentToolSchemas.SessionCancelToolOutputSchema,
  },
  {
    input: AgentToolSchemas.SessionCloseToolInputSchema,
    output: AgentToolSchemas.SessionCloseToolOutputSchema,
  },
  {
    input: AgentToolSchemas.ExecuteToolInputSchema,
    output: AgentToolSchemas.ExecuteToolOutputSchema,
  },
  {
    input: AgentToolSchemas.CallToolInputSchema,
    output: AgentToolSchemas.CallToolOutputSchema,
  },
  {
    input: SessionCreateOrLoadInputSchema,
    output: SessionHandleReferenceSchema,
  },
] as const

type AgentToolGroup = (typeof AGENT_TOOL_GROUPS)[number]

const projectTool = (group: AgentToolGroup) => {
  const metadata = Option.getOrThrow(getFiregridProjectionMetadata(group.input))
  const toolName = metadata.toolName ?? metadata.operationId
  return Tool.make(toolName, {
    description: schemaDescription(group.input, toolName),
    dependencies: FiregridToolDependencies,
  })
    .setParameters(group.input)
    .setSuccess(group.output)
    .setFailure(FiregridMcpToolFailureSchema)
}

type AgentToolNames = [
  "sleep",
  "wait_for",
  "wait_until",
  "wait_any",
  "send",
  "session_new",
  "session_prompt",
  "session_cancel",
  "session_close",
  "execute",
  "call",
  "session_create_or_load",
]

type ProjectedTool<
  Name extends string,
  Group,
> = Group extends {
  readonly input: infer Input extends Schema.Struct<infer _Fields>
  readonly output: infer Output extends Schema.Schema.Any
}
  ? Tool.Tool<
    Name,
    {
      readonly parameters: Input
      readonly success: Output
      readonly failure: typeof FiregridMcpToolFailureSchema
      readonly failureMode: "error"
    },
    typeof FiregridAgentToolContext | typeof IdGenerator.IdGenerator
  >
  : never

type ProjectedAgentTools = [
  ProjectedTool<AgentToolNames[0], (typeof AGENT_TOOL_GROUPS)[0]>,
  ProjectedTool<AgentToolNames[1], (typeof AGENT_TOOL_GROUPS)[1]>,
  ProjectedTool<AgentToolNames[2], (typeof AGENT_TOOL_GROUPS)[2]>,
  ProjectedTool<AgentToolNames[3], (typeof AGENT_TOOL_GROUPS)[3]>,
  ProjectedTool<AgentToolNames[4], (typeof AGENT_TOOL_GROUPS)[4]>,
  ProjectedTool<AgentToolNames[5], (typeof AGENT_TOOL_GROUPS)[5]>,
  ProjectedTool<AgentToolNames[6], (typeof AGENT_TOOL_GROUPS)[6]>,
  ProjectedTool<AgentToolNames[7], (typeof AGENT_TOOL_GROUPS)[7]>,
  ProjectedTool<AgentToolNames[8], (typeof AGENT_TOOL_GROUPS)[8]>,
  ProjectedTool<AgentToolNames[9], (typeof AGENT_TOOL_GROUPS)[9]>,
  ProjectedTool<AgentToolNames[10], (typeof AGENT_TOOL_GROUPS)[10]>,
  ProjectedTool<AgentToolNames[11], (typeof AGENT_TOOL_GROUPS)[11]>,
]

// `.map` over the tuple yields a homogeneous array, but the result must be the
// positional `ProjectedAgentTools` tuple whose per-element tool names are computed
// at runtime (from projection metadata) and cannot be derived by the type system.
// eslint-disable-next-line local/no-launder-cast -- runtime-named positional tuple
const AGENT_TOOLS = AGENT_TOOL_GROUPS.map(group =>
  projectTool(group),
) as unknown as ProjectedAgentTools

export const [
  SleepTool,
  WaitForTool,
  WaitUntilTool,
  WaitAnyTool,
  SendTool,
  SessionNewTool,
  SessionPromptTool,
  SessionCancelTool,
  SessionCloseTool,
  ExecuteTool,
  CallTool,
  SessionCreateOrLoadTool,
] = AGENT_TOOLS

/**
 * Canonical Firegrid agent toolkit. The single source of truth for tool
 * exposure: codecs publish this set, MCP `tools/list` projects this
 * set, and `FiregridAgentToolExecutor` (`./tool-dispatch.ts`) switches on
 * the tool name against the same `@firegrid/protocol/agent-tools` Effect
 * Schemas these `Tool.make` values bind. The toolkit value and the
 * executor's name-switch share one schema source of truth
 * (`@firegrid/protocol/agent-tools`); they do not maintain parallel
 * registries.
 */
export const FiregridAgentToolkit = Toolkit.make(...AGENT_TOOLS)

/**
 * Locked primitive profile for showcase participants.
 *
 * agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.1
 * agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.2
 * agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.3
 * agentic-patterns-primitive-profile.LOCKED_TOOL_SURFACE.4
 */
export const FiregridPrimitiveProfileToolkit = Toolkit.make(
  WaitForTool,
  WaitAnyTool,
  SendTool,
  CallTool,
)
