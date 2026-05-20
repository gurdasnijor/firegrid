import { Schema } from "effect"

/**
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.1
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.3
 * firegrid-typed-wait-source-redesign.TYPED_SOURCES.6
 *
 * Schema-backed runtime observation source discriminator. The variant
 * selects which runtime observation stream a consumer observes; any
 * predicate language layered on top of the stream is owned by that consumer,
 * not by this source catalog.
 */
export const AgentOutputObservationSourceSchema = Schema.Struct({
  _tag: Schema.Literal("AgentOutput"),
})

export const AgentOutputAfterObservationSourceSchema = Schema.Struct({
  _tag: Schema.Literal("AgentOutputAfter"),
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  afterSequence: Schema.Number,
})

export const RuntimeRunObservationSourceSchema = Schema.Struct({
  _tag: Schema.Literal("RuntimeRun"),
})

/**
 * firegrid-typed-wait-source-redesign.CONTEXT.3
 *
 * Caller-owned durable observation. `stream` is the app-chosen stable name
 * of a caller-owned durable fact stream; the host composition that knows
 * the app's collection binds the concrete stream behind this name through
 * the `CallerOwnedFactStreams` capability.
 */
export const CallerFactObservationSourceSchema = Schema.Struct({
  _tag: Schema.Literal("CallerFact"),
  stream: Schema.String,
})

export const RuntimeObservationSourceSchema = Schema.Union(
  AgentOutputObservationSourceSchema,
  AgentOutputAfterObservationSourceSchema,
  RuntimeRunObservationSourceSchema,
  CallerFactObservationSourceSchema,
)
export type RuntimeObservationSource = Schema.Schema.Type<
  typeof RuntimeObservationSourceSchema
>
