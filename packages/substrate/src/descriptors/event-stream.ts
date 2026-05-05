import { Schema } from "effect"

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
