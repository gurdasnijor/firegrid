import { Schema } from "effect"

/**
 * Durable fact wait descriptor protocol.
 *
 * Schemas for the `firegrid.wait.*` row family. These are the canonical
 * shapes for the named wait descriptor substrate; runtime packages
 * consume them but do not redefine them.
 *
 * Implements:
 *  - firegrid-durable-fact-wait-descriptor.DESCRIPTOR.1
 *  - firegrid-durable-fact-wait-descriptor.DESCRIPTOR.2 (no
 *    code-as-data: matcherParams is `Schema.Unknown`, evaluated by a
 *    host-owned registry)
 *  - firegrid-durable-fact-wait-descriptor.DESCRIPTOR.3
 *  - firegrid-durable-fact-wait-descriptor.DESCRIPTOR.4
 *  - firegrid-durable-fact-wait-descriptor.EVALUATOR.3
 */

// A wait points at a source durable stream and a starting cursor. The
// stream URL is required (it's the substrate the matcher reads); the
// cursor is optional and, when omitted, the evaluator starts the
// snapshot at the beginning of retained history.
export const WaitSourceDescriptorSchema = Schema.Struct({
  streamUrl: Schema.String,
  cursor: Schema.optional(Schema.String),
})
export type WaitSourceDescriptor = Schema.Schema.Type<typeof WaitSourceDescriptorSchema>

/**
 * firegrid-durable-fact-wait-descriptor.DESCRIPTOR.1
 * firegrid-durable-fact-wait-descriptor.DESCRIPTOR.3
 */
export const WaitRequestedRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.wait.requested"),
  id: Schema.String,
  at: Schema.String,
  waitId: Schema.String,
  ownerId: Schema.String,
  idempotencyKey: Schema.String,
  source: WaitSourceDescriptorSchema,
  matcherId: Schema.String,
  matcherVersion: Schema.Number,
  matcherParams: Schema.Unknown,
  // Optional absolute durable deadline. v0 evaluator does NOT fire
  // timeouts; the field exists so future tracers can settle timeout
  // semantics without changing this row family.
  timeoutAt: Schema.optional(Schema.String),
})
export type WaitRequestedRow = Schema.Schema.Type<typeof WaitRequestedRowSchema>

/**
 * Outcome carried by a `firegrid.wait.matched` fact. `matchedValue` is
 * the matcher's typed match payload (e.g. the matched row, or a
 * derived shape). `sourceOffset` records where the match was observed
 * so consumers can correlate with the source stream.
 */
export const WaitMatchSchema = Schema.Struct({
  waitId: Schema.String,
  matcherId: Schema.String,
  matcherVersion: Schema.Number,
  matchedAt: Schema.String,
  sourceOffset: Schema.optional(Schema.String),
  matchedValue: Schema.Unknown,
})
export type WaitMatch = Schema.Schema.Type<typeof WaitMatchSchema>

/**
 * firegrid-durable-fact-wait-descriptor.EVALUATOR.3
 */
export const WaitMatchedRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.wait.matched"),
  id: Schema.String,
  at: Schema.String,
  waitId: Schema.String,
  match: WaitMatchSchema,
})
export type WaitMatchedRow = Schema.Schema.Type<typeof WaitMatchedRowSchema>

/**
 * firegrid-durable-fact-wait-descriptor.TIMEOUT.2
 *
 * Carried by a `firegrid.wait.timed_out` fact when timeout firing is
 * implemented. The v0 evaluator does not emit these rows; the schema
 * is reserved.
 */
export const WaitTimedOutRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.wait.timed_out"),
  id: Schema.String,
  at: Schema.String,
  waitId: Schema.String,
  timeoutAt: Schema.String,
})
export type WaitTimedOutRow = Schema.Schema.Type<typeof WaitTimedOutRowSchema>

/**
 * Carried by a `firegrid.wait.failed` fact when the matcher registry
 * cannot resolve `(matcherId, matcherVersion)` or the matcher itself
 * raises an expected failure (DESCRIPTOR.2 / EVALUATOR.5).
 */
export const WaitFailureSchema = Schema.Struct({
  reason: Schema.Literal(
    "unknown-matcher",
    "incompatible-matcher-version",
    "matcher-error",
  ),
  detail: Schema.optional(Schema.String),
})
export type WaitFailure = Schema.Schema.Type<typeof WaitFailureSchema>

export const WaitFailedRowSchema = Schema.Struct({
  type: Schema.Literal("firegrid.wait.failed"),
  id: Schema.String,
  at: Schema.String,
  waitId: Schema.String,
  failure: WaitFailureSchema,
})
export type WaitFailedRow = Schema.Schema.Type<typeof WaitFailedRowSchema>

// Wait stream is a Union of request + the outcome row families. Wait
// outcomes share a stream with their requests so the evaluator can
// dedupe on (waitId) without consulting a separate substrate.
export const WaitOutcomeRowSchema = Schema.Union(
  WaitMatchedRowSchema,
  WaitTimedOutRowSchema,
  WaitFailedRowSchema,
)
export type WaitOutcomeRow = Schema.Schema.Type<typeof WaitOutcomeRowSchema>

export const WaitRowSchema = Schema.Union(
  WaitRequestedRowSchema,
  WaitOutcomeRowSchema,
)
export type WaitRow = Schema.Schema.Type<typeof WaitRowSchema>
