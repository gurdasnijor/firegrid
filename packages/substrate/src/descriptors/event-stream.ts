import type { Schema } from "effect"
import { isChangeEvent, type ChangeEvent } from "@durable-streams/state"
import {
  EventStreamEnvelopeTag,
  EventStreamRowType,
  type EventStreamValue,
} from "../schema/rows.ts"
import { substrateState } from "../schema/state.ts"

// firegrid-event-streams.CLIENT_API.1
// firegrid-event-streams.CLIENT_API.2
//
// Wire envelope for EventStream rows. Client emit encodes the caller-owned
// event payload into this envelope, then stores it as the `value` of a
// Durable Streams State Protocol change message; clients and runtime
// materializers share this shape from the descriptor module so encode/decode
// boundaries cannot drift.
export const EVENT_STREAM_ENVELOPE_TAG = EventStreamEnvelopeTag
export const EVENT_STREAM_ROW_TYPE = EventStreamRowType

export type EventStreamEnvelope = EventStreamValue

export type EventStreamStateRow = ChangeEvent<EventStreamEnvelope>

type UnknownChangeEvent = ChangeEvent<unknown>

export const eventStreamStateKey = (
  streamName: string,
  eventId: string,
): string => `${streamName}:${eventId}`

export const makeEventStreamEnvelope = (
  streamName: string,
  encodedEvent: unknown,
): EventStreamEnvelope => ({
  _envelope: EVENT_STREAM_ENVELOPE_TAG,
  stream: streamName,
  event: encodedEvent,
})

export const makeEventStreamStateRow = (input: {
  readonly stream: string
  readonly eventId: string
  readonly event: unknown
}): EventStreamStateRow =>
  substrateState.eventStreams.insert({
    key: eventStreamStateKey(input.stream, input.eventId),
    value: makeEventStreamEnvelope(input.stream, input.event),
  })

export const isEventStreamEnvelope = (
  value: unknown,
): value is EventStreamEnvelope =>
  typeof value === "object" &&
  value !== null &&
  (value as EventStreamEnvelope)._envelope === EVENT_STREAM_ENVELOPE_TAG

export const isEventStreamStateRow = (
  value: unknown,
): value is EventStreamStateRow => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("headers" in value)
  ) {
    return false
  }
  if (!isChangeEvent(value as never)) return false
  const row = value as UnknownChangeEvent
  return (
    row.type === EVENT_STREAM_ROW_TYPE &&
    row.headers.operation === "insert" &&
    isEventStreamEnvelope(row.value)
  )
}

export const eventStreamEnvelopeFromStateRow = (
  value: unknown,
): EventStreamEnvelope | undefined =>
  isEventStreamStateRow(value) ? value.value : undefined

// firegrid-event-streams.EVENT_STREAM_DEFINITION.1
// firegrid-event-streams.EVENT_STREAM_DEFINITION.2
// firegrid-event-streams.EVENT_STREAM_DEFINITION.3
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
//
// EventStream is a browser-safe descriptor: a name plus an event
// Schema. It carries no client instance, no runtime materializer,
// no Durable Streams URL, and no mutable registry. Both clients
// and runtimes import the same descriptor; runtime materializer
// installation happens separately via runtime-only Layer
// constructors (out of scope for this slice).
//
// This module depends only on Effect / Schema. A future
// extraction to @firegrid/core is mechanical.
//
// Schema bound: we use `Schema.Schema.All`, mirroring the Operation
// descriptor. `Schema.Schema.Any = Schema<any, any, unknown>`
// excludes `Schema.Never`-style branches by Effect's own
// documentation; `All` is the narrowest supertype that admits
// every concrete user schema and keeps the slot truly typed as a
// Schema value rather than weakened to `unknown`.

export interface EventStreamDescriptor<
  Name extends string = string,
  EventSchema extends Schema.Schema.All = Schema.Schema.All,
> {
  readonly _tag: "EventStream"
  readonly name: Name
  readonly event: EventSchema
}

export interface EventStreamDefinition<
  Name extends string,
  EventSchema extends Schema.Schema.All,
> {
  readonly name: Name
  readonly event: EventSchema
}

const defineEventStream = <
  Name extends string,
  EventSchema extends Schema.Schema.All,
>(
  args: EventStreamDefinition<Name, EventSchema>,
): EventStreamDescriptor<Name, EventSchema> =>
  Object.freeze({
    _tag: "EventStream",
    name: args.name,
    event: args.event,
  })

export const EventStream = {
  define: defineEventStream,
} as const

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace EventStream {
  export type Any = EventStreamDescriptor<string, Schema.Schema.All>
  export type Event<S extends Any> = Schema.Schema.Type<S["event"]>
  export type EncodedEvent<S extends Any> = Schema.Schema.Encoded<S["event"]>
}
