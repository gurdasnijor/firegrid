/**
 * Neutral agent-tool descriptor type.
 *
 * Phase 1 owns the descriptor TYPE that codecs accept at session-open
 * time. Phase 2 owns the canonical Firegrid descriptor *instances*
 * (`FiregridAgentTools`) and the host-side lowering match expression
 * (`toolUseToEffect`).
 *
 * Descriptor fields must never carry credentials, callback tokens,
 * provider session tokens, Durable Streams URLs, sandbox handles, host
 * ids, or transport references — those remain host-side authority per
 * `firegrid-platform-invariants.SECURITY.1` and
 * `firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.4`.
 *
 * Schemas attached to descriptors are expected to live in
 * `@firegrid/protocol/agent-tools` so client APIs, codec catalog
 * projection, and runtime validation share one Effect Schema source of
 * truth (`firegrid-scheduling-tool-bindings.PACKAGE_PLACEMENT.1`).
 */

import type { Schema } from "effect"

export interface AgentToolCapabilities {
  readonly requiresPermission: boolean
  readonly idempotent: boolean
  readonly streaming: boolean
}

export type AgentToolStability = "stable" | "experimental"

export interface AgentToolDescriptor<I = unknown, O = unknown> {
  readonly name: string
  readonly description: string
  // The encoded side stays an `any` parameter so concrete descriptors
  // can use Schemas with `Schema.transform`/`Schema.transformOrFail` to
  // shape the agent-visible JSON differently from the host-side type
  // (per `firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.1`
  // and `agent-codec-runtime-tools` Phase 2 catalog projection rules).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly inputSchema: Schema.Schema<I, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly outputSchema: Schema.Schema<O, any>
  readonly stability: AgentToolStability
  readonly capabilities: AgentToolCapabilities
}

/**
 * Convenience helper for Phase 2 (and downstream code authoring
 * descriptors) to construct a descriptor without exposing the
 * `inputSchema`/`outputSchema` generics through their call sites.
 * The function performs no validation; it exists to anchor the
 * descriptor shape at one place.
 */
export const defineAgentTool = <I, O>(
  descriptor: AgentToolDescriptor<I, O>,
): AgentToolDescriptor<I, O> => descriptor
