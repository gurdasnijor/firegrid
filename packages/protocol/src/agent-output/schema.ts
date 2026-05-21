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

export const AgentReadyEventSchema = Schema.TaggedStruct("Ready", {
  capabilities: AgentCapabilitiesSchema,
})
export const AgentTextChunkEventSchema = Schema.TaggedStruct("TextChunk", {
  part: AgentTextDeltaPartSchema,
})
export const AgentToolUseEventSchema = Schema.TaggedStruct("ToolUse", {
  // firegrid-agent-io-effect-ai-alignment.DURABLE_PAYLOAD_ALIGNMENT.2
  part: AgentToolCallPartSchema,
})
export const AgentPermissionRequestEventSchema = Schema.TaggedStruct(
  "PermissionRequest",
  {
    permissionRequestId: Schema.String,
    toolUseId: Schema.String,
    options: Schema.Array(PermissionOptionSchema),
  },
)
export const AgentTurnCompleteEventSchema = Schema.TaggedStruct(
  "TurnComplete",
  {
    finishReason: StopReasonSchema,
    messageId: Schema.optional(Schema.String),
  },
)
export const AgentStatusEventSchema = Schema.TaggedStruct("Status", {
  kind: Schema.String,
  payload: Schema.optional(Schema.Unknown),
})
export const AgentErrorEventSchema = Schema.TaggedStruct("Error", {
  cause: Schema.Unknown,
  recoverable: Schema.Boolean,
})
export const AgentTerminatedEventSchema = Schema.TaggedStruct("Terminated", {
  exitCode: Schema.optional(Schema.Number),
})

export const AgentOutputEventSchema = Schema.Union(
  AgentReadyEventSchema,
  AgentTextChunkEventSchema,
  AgentToolUseEventSchema,
  AgentPermissionRequestEventSchema,
  AgentTurnCompleteEventSchema,
  AgentStatusEventSchema,
  AgentErrorEventSchema,
  AgentTerminatedEventSchema,
)
export type AgentOutputEvent = Schema.Schema.Type<typeof AgentOutputEventSchema>

// tf-8s7d — forward-compatibility fallback for unknown `_tag` variants.
//
// Per the tf-ypq9 schema-evolution policy
// (`docs/cannon/architecture/schema-evolution-and-error-ownership.md`),
// replay-facing row families must accept "old rows continue to decode"
// — and the symmetric case, "new rows decode on older readers", is the
// load-bearing property for cross-version replay safety.
//
// `AgentOutputEventSchema` is intentionally STRICT for known `_tag`
// variants (the schema-evolution policy's "new literal variants may be
// added only when older projections can ignore or preserve them"
// clause). This sibling schema gives older readers the
// preserve-not-crash behavior: a row carrying a future `_tag` decodes
// to `AgentUnknownEvent`, carrying the original tag in
// `unknownTag` and the rest of the event payload in `payload` for
// downstream consumers that choose to surface or audit it.
//
// Use through `tryDecodeRuntimeAgentOutputEnvelope` in
// `@firegrid/protocol/session-facade`: strict decode first, fallback
// only on strict failure. Known tags continue to produce typed
// `AgentOutputEvent` values; only genuinely unknown tags produce
// `AgentUnknownEvent`.
export const AgentUnknownEventSchema = Schema.TaggedStruct(
  "AgentOutputUnknown",
  {
    unknownTag: Schema.String.pipe(Schema.minLength(1)),
    payload: Schema.optional(Schema.Unknown),
  },
).annotations({
  identifier: "firegrid.agentOutput.unknownEvent",
  title: "Forward-compat fallback for an unknown AgentOutputEvent _tag",
  description:
    "Terminal fallback emitted by tryDecodeRuntimeAgentOutputEnvelope when a stored envelope's event carries a _tag this version's AgentOutputEventSchema does not know. Preserves the original _tag (in unknownTag) and the original event payload so older readers can audit, surface, or drop without losing the row.",
})
export type AgentUnknownEvent = Schema.Schema.Type<typeof AgentUnknownEventSchema>

export const AgentOutputEventOrUnknownSchema = Schema.Union(
  AgentOutputEventSchema,
  AgentUnknownEventSchema,
)
export type AgentOutputEventOrUnknown = Schema.Schema.Type<
  typeof AgentOutputEventOrUnknownSchema
>
