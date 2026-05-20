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
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.1
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.3
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.6
 *
 * Schema-backed wait-source discriminator persisted on the wait row. The
 * variant selects which runtime observation stream the router observes; the
 * `FieldEqualsTrigger` value still decides which rows on that stream match.
 * First supported set is `AgentOutput` and `RuntimeRun` only; `RuntimeContext`
 * is deferred until a product flow needs context-state waiting.
 */
export const AgentOutputWaitSourceSchema = Schema.Struct({
  _tag: Schema.Literal("AgentOutput"),
})

const AgentOutputAfterWaitSourceSchema = Schema.Struct({
  _tag: Schema.Literal("AgentOutputAfter"),
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  afterSequence: Schema.Number,
})

export const RuntimeRunWaitSourceSchema = Schema.Struct({
  _tag: Schema.Literal("RuntimeRun"),
})

/**
 * firegrid-typed-wait-source-redesign.CONTEXT.3
 *
 * Caller-owned durable observation. `stream` is the app-chosen stable name
 * of a caller-owned durable fact stream; the host composition that knows
 * the app's collection binds the concrete stream behind this name through
 * the `CallerOwnedFactStreams` capability (TYPED_SOURCES.2). This is not a
 * runtime-authority internal and not a stringly registry for runtime-owned
 * sources (REJECTION.3 targets the runtime wait abstraction default; caller
 * facts are inherently app-named because the runtime cannot enumerate app
 * collections).
 */
export const CallerFactWaitSourceSchema = Schema.Struct({
  _tag: Schema.Literal("CallerFact"),
  stream: Schema.String,
})

export const RuntimeWaitSourceSchema = Schema.Union(
  AgentOutputWaitSourceSchema,
  AgentOutputAfterWaitSourceSchema,
  RuntimeRunWaitSourceSchema,
  CallerFactWaitSourceSchema,
)
export type RuntimeWaitSource = Schema.Schema.Type<
  typeof RuntimeWaitSourceSchema
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

// `WaitOutcomeKindSchema` was deleted with the `WaitCompletionRow` schema
// under Shape C Step 3 (docs/research/durable-tools-vs-workflow-engine-convergence.md):
// the durable completion artifact it tagged is gone — match/timeout
// arbitration is now `DurableDeferred.raceAll`'s race deferred.
// `WaitForOutcome` (below) is the only remaining public surface for the
// match/timeout discrimination.

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
