import type {
  DurableTableCollectionFacade,
  ProjectionStream,
} from "effect-durable-operators"
import type { DurableTableError } from "effect-durable-operators"
import { Stream, type Effect, type Schema } from "effect"
import {
  makeBidirectionalChannel,
  makeChannelTarget,
  type BidirectionalChannel,
  type ChannelSourceClass,
  type ChannelTarget,
} from "./channel-registry.ts"

export const EventChannelSourceClasses = [
  "static-source",
  "predicate-eligible",
] as const satisfies ReadonlyArray<ChannelSourceClass>

export type EventChannel<S extends Schema.Schema.Any> = BidirectionalChannel<S> & {
  readonly kind: "event"
  readonly eventName: string
  readonly callerFactStream: string
}

interface EventChannelBaseOptions<S extends Schema.Schema.Any> {
  readonly name: string
  readonly target?: ChannelTarget | string
  readonly schema: S
  readonly callerFactStream: string
  readonly sourceClasses?: ReadonlyArray<ChannelSourceClass>
}

interface EventChannelOptions<S extends Schema.Schema.Any>
  extends EventChannelBaseOptions<S> {
  readonly rows: () => ProjectionStream<Schema.Schema.Type<S> & object, DurableTableError>
  readonly append: (
    payload: Schema.Schema.Type<S>,
  ) => Effect.Effect<void, unknown, never>
}

interface EventChannelFromCollectionOptions<S extends Schema.Schema.Any>
  extends EventChannelBaseOptions<S> {
  readonly collection: Pick<
    DurableTableCollectionFacade<Schema.Schema.Type<S> & object, unknown>,
    "rows" | "insert"
  >
}

export const eventChannelTarget = (name: string): ChannelTarget =>
  makeChannelTarget(`event.${name}`)

const rowMatchesEventName = (row: object, name: string): boolean =>
  Object.hasOwn(row, "name")
  && (row as { readonly name?: unknown }).name === name

export const eventChannel = <S extends Schema.Schema.Any>(
  options: EventChannelOptions<S>,
): EventChannel<S> => {
  const channel = makeBidirectionalChannel({
    target: options.target ?? eventChannelTarget(options.name),
    schema: options.schema,
    sourceClasses: options.sourceClasses ?? EventChannelSourceClasses,
    // firegrid-agent-body-plan.EVENT_CHANNEL.5
    stream: options.rows().pipe(
      Stream.filter(row => rowMatchesEventName(row, options.name)),
    ),
    append: options.append,
  })
  return {
    ...channel,
    kind: "event",
    eventName: options.name,
    callerFactStream: options.callerFactStream,
  }
}

export const eventChannelFromCollection = <S extends Schema.Schema.Any>(
  options: EventChannelFromCollectionOptions<S>,
): EventChannel<S> =>
  eventChannel({
    ...options,
    rows: options.collection.rows,
    append: payload =>
      options.collection.insert(payload as Schema.Schema.Type<S> & object),
  })
