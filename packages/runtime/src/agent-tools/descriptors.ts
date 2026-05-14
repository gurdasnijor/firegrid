/**
 * Canonical Firegrid agent-tool descriptor manifest.
 *
 * `FiregridAgentTools` is the *public contract*: an explicit, statically
 * known map from canonical tool name to the descriptor codecs publish and
 * `toolUseToEffect` lowers. Adding a tool requires (a) a protocol Effect
 * Schema in `@firegrid/protocol/agent-tools` and (b) a new entry here plus a
 * new match arm in `tool-use-to-effect.ts` — the SDD's "descriptor +
 * implementation" pair.
 *
 * Schemas are imported, not duplicated, so client APIs, codec catalog
 * projections, and runtime validation share one source of truth.
 *
 * Implements:
 *  - agent-codec-runtime-tools.md/agent-tool-layer-phase-2 §"Canonical descriptors"
 *  - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.1 (neutral vocabulary)
 *  - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.4 (no credentials/transport)
 *  - firegrid-scheduling-tool-bindings.PACKAGE_PLACEMENT.1 (schema source of truth)
 *  - firegrid-scheduling-tool-bindings.DURABLE_DESCRIPTOR_PUBLICATION.4 (frozen catalog)
 */

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
} from "@firegrid/protocol/agent-tools"
import {
  defineAgentTool,
  type AgentToolDescriptor,
} from "../agent-io/index.ts"

export const FiregridAgentTools = {
  sleep: defineAgentTool({
    name: "sleep",
    description: "Durably suspend until a duration elapses.",
    inputSchema: SleepToolInputSchema,
    outputSchema: SleepToolOutputSchema,
    stability: "stable",
    capabilities: {
      requiresPermission: false,
      idempotent: true,
      streaming: false,
    },
  }),
  wait_for: defineAgentTool({
    name: "wait_for",
    description: "Wait until a matching durable event appears, optionally bounded by a timeout.",
    inputSchema: WaitForToolInputSchema,
    outputSchema: WaitForToolOutputSchema,
    stability: "experimental",
    capabilities: {
      requiresPermission: false,
      idempotent: true,
      streaming: false,
    },
  }),
  spawn: defineAgentTool({
    name: "spawn",
    description: "Run a child RuntimeContextWorkflow with the given prompt and await its terminal state.",
    inputSchema: SpawnToolInputSchema,
    outputSchema: SpawnToolOutputSchema,
    stability: "experimental",
    capabilities: {
      requiresPermission: false,
      idempotent: true,
      streaming: false,
    },
  }),
  spawn_all: defineAgentTool({
    name: "spawn_all",
    description: "Fan out child workflows; await every terminal state.",
    inputSchema: SpawnAllToolInputSchema,
    outputSchema: SpawnAllToolOutputSchema,
    stability: "experimental",
    capabilities: {
      requiresPermission: false,
      idempotent: true,
      streaming: false,
    },
  }),
  schedule_me: defineAgentTool({
    name: "schedule_me",
    description: "Schedule a future prompt to the same agent context.",
    inputSchema: ScheduleMeToolInputSchema,
    outputSchema: ScheduleMeToolOutputSchema,
    stability: "experimental",
    capabilities: {
      requiresPermission: false,
      idempotent: true,
      streaming: false,
    },
  }),
  execute: defineAgentTool({
    name: "execute",
    description: "Invoke a SandboxProvider-backed tool by sandbox-neutral reference.",
    inputSchema: ExecuteToolInputSchema,
    outputSchema: ExecuteToolOutputSchema,
    stability: "stable",
    capabilities: {
      requiresPermission: false,
      idempotent: false,
      streaming: false,
    },
  }),
} as const

// `AgentToolDescriptor` is invariant in its I/O type parameters because
// `Schema.Schema` itself is invariant. `satisfies Record<string,
// AgentToolDescriptor<unknown, unknown>>` therefore cannot hold here; we
// re-narrow with an `as` cast for catalog projection, which is the only
// place a wider element type is required.

/**
 * The canonical Firegrid agent-tool name set. Useful for codecs that
 * publish the catalog and want exhaustive type checking against the
 * descriptor manifest.
 */
export type FiregridAgentToolName = keyof typeof FiregridAgentTools

export const firegridAgentToolNames: ReadonlyArray<FiregridAgentToolName> =
  Object.keys(FiregridAgentTools) as ReadonlyArray<FiregridAgentToolName>

/**
 * Ordered catalog projection. Codec `AgentCodecOpenOptions.toolCatalog`
 * receives a `ReadonlyArray<AgentToolDescriptor<unknown, unknown>>`, so
 * descriptor publication is ordered serialization rather than keyed
 * dispatch (Phase 1 PR 1).
 */
export const firegridAgentToolCatalog: ReadonlyArray<
  AgentToolDescriptor<unknown, unknown>
> = firegridAgentToolNames.map(
  (name) =>
    FiregridAgentTools[name] as unknown as AgentToolDescriptor<unknown, unknown>,
)
