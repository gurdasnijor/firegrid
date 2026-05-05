import {
  eventStreamEnvelopeFromStateRow,
  makeEventStreamStateRow,
  type EventStream,
} from "@durable-agent-substrate/substrate/descriptors"
import { DurableStream } from "@durable-streams/client"
import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Schema,
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

export interface FiregridClientConfig {
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

export interface FiregridClientService {
  readonly emit: <S extends EventStream.Any>(
    stream: S,
    event: EventStream.Event<S>,
  ) => Effect.Effect<void, EmitError>

  readonly events: <S extends EventStream.Any>(
    stream: S,
  ) => Stream.Stream<EventStream.Event<S>, EventsError>
}

export class FiregridClient extends Context.Tag("firegrid/FiregridClient")<
  FiregridClient,
  FiregridClientService
>() {}

const encodeEvent = <S extends EventStream.Any>(
  stream: S,
  event: EventStream.Event<S>,
): Effect.Effect<EventStream.EncodedEvent<S>, EventStreamEncodeError> =>
  Schema.encodeUnknown(stream.event as Schema.Schema.AnyNoContext)(event).pipe(
    Effect.mapError(
      (cause) =>
        new EventStreamEncodeError({ stream: stream.name, cause }),
    ),
  ) as Effect.Effect<EventStream.EncodedEvent<S>, EventStreamEncodeError>

const decodeEvent = <S extends EventStream.Any>(
  stream: S,
  raw: unknown,
): Effect.Effect<EventStream.Event<S>, EventStreamDecodeError> =>
  Schema.decodeUnknown(stream.event as Schema.Schema.AnyNoContext)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new EventStreamDecodeError({ stream: stream.name, cause }),
    ),
  ) as Effect.Effect<EventStream.Event<S>, EventStreamDecodeError>

const nextEventId = (): string =>
  `${Date.now()}:${Math.random().toString(36).slice(2)}`

export const buildEventStreamService = (
  cfg: FiregridClientConfig,
): FiregridClientService => {
  const durable = new DurableStream({
    url: cfg.streamUrl,
    contentType: cfg.contentType ?? "application/json",
  })

  const emit: FiregridClientService["emit"] = (stream, event) =>
    encodeEvent(stream, event).pipe(
      Effect.flatMap((encoded) =>
        Effect.tryPromise({
          try: () =>
            durable.append(
              JSON.stringify(
                makeEventStreamStateRow({
                  stream: stream.name,
                  eventId: nextEventId(),
                  event: encoded,
                }),
              ),
            ),
          catch: (cause) =>
            new EventStreamAppendError({ stream: stream.name, cause }),
        }),
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

  const events: FiregridClientService["events"] = (stream) =>
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

export const FiregridClientLive = (
  cfg: FiregridClientConfig,
): Layer.Layer<FiregridClient> =>
  Layer.succeed(FiregridClient, buildEventStreamService(cfg))

export {
  EVENT_STREAM_ENVELOPE_TAG,
  EVENT_STREAM_ROW_TYPE,
  eventStreamEnvelopeFromStateRow,
  eventStreamStateKey,
  EventStream,
  isEventStreamStateRow,
  isEventStreamEnvelope,
  makeEventStreamEnvelope,
  makeEventStreamStateRow,
  Operation,
  OperationHandle,
  OPERATION_ENVELOPE_TAG,
  type EventStreamEnvelope,
  type EventStreamStateRow,
  type OperationEnvelope,
} from "@durable-agent-substrate/substrate/descriptors"
