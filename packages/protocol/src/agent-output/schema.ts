/**
 * Canonical normalized agent-output event union (single source of truth).
 *
 * TFIND-035: this is the ONE definition of `AgentOutputEvent` + its part
 * sub-schemas. It lives in `@firegrid/protocol` (browser-safe,
 * runtime-source-free) because the dependency graph is one-directional —
 * `@firegrid/runtime` and `@firegrid/client-sdk` depend on
 * `@firegrid/protocol`, never the reverse. `@firegrid/runtime`'s
 * `agent-event-pipeline/events/contract.ts` re-exports these names for
 * back-compat; this module is the authority.
 *
 * Part payloads reuse the same `@effect/ai` Prompt/Response contracts the
 * runtime encoder/codecs use, so the durable wire form is identical.
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

export const PermissionOptionSchema = Schema.Struct({
  optionId: Schema.String,
  kind: PermissionOptionKindSchema,
  name: Schema.String,
})
export type PermissionOption = Schema.Schema.Type<typeof PermissionOptionSchema>

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

export const AgentOutputEventSchema = Schema.Union(
  Schema.TaggedStruct("Ready", { capabilities: AgentCapabilitiesSchema }),
  Schema.TaggedStruct("TextChunk", {
    part: AgentTextDeltaPartSchema,
  }),
  Schema.TaggedStruct("ToolUse", {
    // firegrid-agent-io-effect-ai-alignment.DURABLE_PAYLOAD_ALIGNMENT.2
    part: AgentToolCallPartSchema,
  }),
  Schema.TaggedStruct("PermissionRequest", {
    permissionRequestId: Schema.String,
    toolUseId: Schema.String,
    options: Schema.Array(PermissionOptionSchema),
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
