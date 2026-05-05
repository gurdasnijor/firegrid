import {
  appendChange,
  decodeAtBoundary,
  encodeAtBoundary,
  eventStreamEnvelopeFromStateRow,
  makeEventStreamStateRow,
  type EventStream,
} from "@firegrid/substrate/descriptors"
import { DurableStream } from "@durable-streams/client"
import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Stream,
  type ParseResult,
} from "effect"

// firegrid-event-streams.CLIENT_API.4
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
// firegrid-architecture-boundary.DEPENDENCY_GRAPH.4
//
// Browser-safe Firegrid EventStream client surface. This module is
// physically isolated from the full substrate client layer and root
// barrel so browser bundlers never resolve Node-only substrate modules
// while compiling EventStream emit/events.

export interface EventStreamClientConfig {
  readonly streamUrl: string
  readonly contentType?: string
  readonly clientId?: string
}

export class EventStreamEncodeError extends Data.TaggedError(
  "firegrid/EventStreamEncodeError",
)<{
  readonly stream: string
  readonly cause: ParseResult.ParseError
}> {}

export class EventStreamDecodeError extends Data.TaggedError(
  "firegrid/EventStreamDecodeError",
)<{
  readonly stream: string
  readonly cause: ParseResult.ParseError
}> {}

export class EventStreamAppendError extends Data.TaggedError(
  "firegrid/EventStreamAppendError",
)<{
  readonly stream: string
  readonly cause: unknown
}> {}

export class EventStreamReadError extends Data.TaggedError(
  "firegrid/EventStreamReadError",
)<{
  readonly stream: string
  readonly cause: unknown
}> {}

export type EmitError = EventStreamEncodeError | EventStreamAppendError
export type EventsError = EventStreamReadError | EventStreamDecodeError

export interface EventStreamClientService {
  readonly emit: <S extends EventStream.Any>(
    stream: S,
    event: EventStream.Event<S>,
  ) => Effect.Effect<void, EmitError>

  readonly events: <S extends EventStream.Any>(
    stream: S,
  ) => Stream.Stream<EventStream.Event<S>, EventsError>
}

export class EventStreamClient extends Context.Tag("firegrid/EventStreamClient")<
  EventStreamClient,
  EventStreamClientService
>() {}

const encodeEvent = <S extends EventStream.Any>(
  stream: S,
  event: EventStream.Event<S>,
): Effect.Effect<EventStream.EncodedEvent<S>, EventStreamEncodeError> =>
  encodeAtBoundary(
    stream.event,
    (cause) =>
      new EventStreamEncodeError({ stream: stream.name, cause }),
  )(event) as Effect.Effect<EventStream.EncodedEvent<S>, EventStreamEncodeError>

const decodeEvent = <S extends EventStream.Any>(
  stream: S,
  raw: unknown,
): Effect.Effect<EventStream.Event<S>, EventStreamDecodeError> =>
  decodeAtBoundary(
    stream.event,
    (cause) =>
      new EventStreamDecodeError({ stream: stream.name, cause }),
  )(raw) as Effect.Effect<EventStream.Event<S>, EventStreamDecodeError>

const nextEventId = (): string =>
  `${Date.now()}:${Math.random().toString(36).slice(2)}`

export const buildEventStreamService = (
  cfg: EventStreamClientConfig,
): EventStreamClientService => {
  const durable = new DurableStream({
    url: cfg.streamUrl,
    contentType: cfg.contentType ?? "application/json",
  })

  const emit: EventStreamClientService["emit"] = (stream, event) =>
    encodeEvent(stream, event).pipe(
      Effect.flatMap((encoded) =>
        appendChange(
          durable,
          makeEventStreamStateRow({
            stream: stream.name,
            eventId: nextEventId(),
            event: encoded,
          }),
          (cause) => new EventStreamAppendError({ stream: stream.name, cause }),
        ),
      ),
      Effect.asVoid,
    )

  const rawEvents = <S extends EventStream.Any>(
    stream: S,
  ): Stream.Stream<unknown, EventStreamReadError> =>
    Stream.unwrapScoped(
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            durable.stream<unknown>({
              offset: "-1",
              live: true,
            }),
          catch: (cause) =>
            new EventStreamReadError({ stream: stream.name, cause }),
        }),
        (response) => Effect.sync(() => response.cancel()),
      ).pipe(
        Effect.map((response) =>
          Stream.fromAsyncIterable(
            response.jsonStream(),
            (cause) =>
              new EventStreamReadError({ stream: stream.name, cause }),
          ),
        ),
      ),
    )

  const events: EventStreamClientService["events"] = (stream) =>
    rawEvents(stream).pipe(
      Stream.filterMapEffect((row) => {
        const envelope = eventStreamEnvelopeFromStateRow(row)
        if (envelope === undefined) return Option.none()
        if (envelope.stream !== stream.name) return Option.none()
        return Option.some(decodeEvent(stream, envelope.event))
      }),
    )

  return { emit, events }
}

export const EventStreamClientLive = (
  cfg: EventStreamClientConfig,
): Layer.Layer<EventStreamClient> =>
  Layer.succeed(EventStreamClient, buildEventStreamService(cfg))

export {
  EventStream,
} from "@firegrid/substrate/descriptors"
