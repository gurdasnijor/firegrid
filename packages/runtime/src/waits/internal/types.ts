/**
 * Shared schemas and error types for the durable-tools `wait_for` surface.
 *
 * Implements (selectively):
 *  - firegrid-durable-tools.SUBSCRIPTION.4 — AND-of-fieldEquals trigger DSL
 *  - firegrid-durable-tools.LIFECYCLE.1 — wait status enum
 */

import { Schema } from "effect"

/**
 * firegrid-durable-tools.SUBSCRIPTION.4
 *
 * Trigger expressivity for v0 is an AND of scalar field-equality predicates
 * over decoded row paths. No OR, NOT, range, lambda, contains, or defaulted
 * path traversal.
 */
export const FieldEqualsPredicateSchema = Schema.Struct({
  path: Schema.Array(Schema.String),
  equals: Schema.Union(Schema.String, Schema.Number, Schema.Boolean),
})
export type FieldEqualsPredicate = Schema.Schema.Type<
  typeof FieldEqualsPredicateSchema
>

export const FieldEqualsTriggerSchema = Schema.Array(FieldEqualsPredicateSchema)
export type FieldEqualsTrigger = Schema.Schema.Type<
  typeof FieldEqualsTriggerSchema
>

/**
 * firegrid-durable-tools.LIFECYCLE.1
 *
 * v0 wait status enum. No `paused`.
 */
export const WaitStatusSchema = Schema.Literal(
  "active",
  "completed",
  "timed_out",
  "retired",
)
export type WaitStatus = Schema.Schema.Type<typeof WaitStatusSchema>

export const WaitOutcomeKindSchema = Schema.Literal("match", "timeout")
export type WaitOutcomeKind = Schema.Schema.Type<typeof WaitOutcomeKindSchema>

/**
 * Public discriminated outcome returned by `WaitFor.match`.
 *
 * firegrid-durable-tools.WAIT_FOR.4
 */
export type WaitForOutcome<A> =
  | { readonly _tag: "Match"; readonly row: A }
  | { readonly _tag: "Timeout" }

/**
 * Errors surfaced by the wait_for surface to callers. Reserved for failures
 * that are part of the workflow-handler-visible contract.
 */
export class WaitForError extends Schema.TaggedError<WaitForError>()(
  "WaitForError",
  {
    op: Schema.String,
    waitName: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export const waitForError = (options: {
  readonly op: string
  readonly waitName: string
  readonly message: string
  readonly cause?: unknown
}): WaitForError =>
  new WaitForError({
    op: options.op,
    waitName: options.waitName,
    message: options.message,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  })

/**
 * firegrid-durable-tools.SUBSCRIPTION.4
 *
 * Evaluate the AND-of-fieldEquals trigger against a decoded source row.
 * Path traversal uses plain Record indexing; absent fields are treated as
 * non-matches (no defaulted traversal — SUBSCRIPTION.6).
 */
const traversePath = (
  row: unknown,
  path: ReadonlyArray<string>,
): unknown =>
  path.reduce<unknown>(
    (cursor, segment) =>
      typeof cursor === "object" && cursor !== null
        ? (cursor as Record<string, unknown>)[segment]
        : undefined,
    row,
  )

export const evaluateFieldEquals = (
  trigger: FieldEqualsTrigger,
  row: unknown,
): boolean => {
  if (typeof row !== "object" || row === null) return false
  return trigger.every((predicate) =>
    traversePath(row, predicate.path) === predicate.equals)
}
