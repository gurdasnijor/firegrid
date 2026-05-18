/**
 * Protocol-owned normalized agent-output event union.
 *
 * TFIND-030 (Option C, smallest sound down-payment): the canonical
 * discriminated `AgentOutputEvent` union is currently defined in
 * `@firegrid/runtime` (`agent-event-pipeline/events/contract.ts`), which
 * `@firegrid/protocol` / `@firegrid/client-sdk` must not depend on
 * (browser-safe / runtime-source-free). To expose `session.snapshot()`
 * agent-output events as the typed public union *and* parse the durable
 * envelope against it (not assert a phantom type), protocol owns this
 * mirror. It is byte-compatible with the runtime union by construction:
 * the part sub-schemas are the same `@effect/ai` Prompt/Response contracts
 * the runtime encoder uses.
 *
 * The full single-source-of-truth consolidation (relocate the union to
 * protocol; runtime re-exports) is the deliberately deferred dependent
 * tracked as TFIND-035 — NOT a bridge, NOT in this PR's scope.
 */

import { Prompt, Response } from "@effect/ai"
import { Schema } from "effect"

export const AgentTextDeltaPartSchema = Response.TextDeltaPart
export type AgentTextDeltaPart = Response.TextDeltaPart

export const AgentToolCallPartSchema = Prompt.ToolCallPart
export type AgentToolCallPart = Prompt.ToolCallPart

export const StopReasonSchema = Response.FinishReason
export type StopReason = Response.FinishReason

export const PermissionOptionKindSchema = Schema.Literal(
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
)
export type PermissionOptionKind = Schema.Schema.Type<typeof PermissionOptionKindSchema>

export const AgentOutputPermissionOptionSchema = Schema.Struct({
  optionId: Schema.String,
  kind: PermissionOptionKindSchema,
  name: Schema.String,
})
export type AgentOutputPermissionOption = Schema.Schema.Type<
  typeof AgentOutputPermissionOptionSchema
>

export const AgentCapabilitiesSchema = Schema.Struct({
  streamingText: Schema.Boolean,
  tools: Schema.Boolean,
  permissions: Schema.Boolean,
  images: Schema.Boolean,
  structuredInput: Schema.Boolean,
  cancellation: Schema.Boolean,
  multiTurn: Schema.Boolean,
  customStatus: Schema.Array(Schema.String),
})
export type AgentCapabilities = Schema.Schema.Type<typeof AgentCapabilitiesSchema>

// Mirrors @firegrid/runtime AgentOutputEventSchema exactly. Keep the two in
// lockstep until TFIND-035 collapses them to one source of truth.
export const AgentOutputEventSchema = Schema.Union(
  Schema.TaggedStruct("Ready", { capabilities: AgentCapabilitiesSchema }),
  Schema.TaggedStruct("TextChunk", {
    part: AgentTextDeltaPartSchema,
  }),
  Schema.TaggedStruct("ToolUse", {
    part: AgentToolCallPartSchema,
  }),
  Schema.TaggedStruct("PermissionRequest", {
    permissionRequestId: Schema.String,
    toolUseId: Schema.String,
    options: Schema.Array(AgentOutputPermissionOptionSchema),
  }),
  Schema.TaggedStruct("TurnComplete", {
    finishReason: StopReasonSchema,
    messageId: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Status", {
    kind: Schema.String,
    payload: Schema.optional(Schema.Unknown),
  }),
  Schema.TaggedStruct("Error", {
    cause: Schema.Unknown,
    recoverable: Schema.Boolean,
  }),
  Schema.TaggedStruct("Terminated", {
    exitCode: Schema.optional(Schema.Number),
  }),
)
export type AgentOutputEvent = Schema.Schema.Type<typeof AgentOutputEventSchema>
