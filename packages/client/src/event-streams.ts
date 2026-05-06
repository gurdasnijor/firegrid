import {
  appendChange,
  decodeAtBoundary,
  encodeAtBoundary,
  eventStreamEnvelopeFromStateRow,
  makeEventStreamStateRow,
  type EventStream,
} from "@firegrid/substrate/descriptors"
import { IdGen, IdGenLive, type IdGenService } from "@firegrid/substrate/id-gen"
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

// firegrid-remediation-hardening.EFFECT_CONSISTENCY.5
// Event ids come through `IdGen` rather than `Date.now()` /
// `Math.random()` so the browser-safe client honours the same
// injectable identity seam as the substrate kernel. `IdGenLive`
// uses `globalThis.crypto.randomUUID` and is browser-safe.
export const buildEventStreamService = (
  cfg: EventStreamClientConfig,
  idGen: IdGenService,
): EventStreamClientService => {
  const durable = new DurableStream({
    url: cfg.streamUrl,
    contentType: cfg.contentType ?? "application/json",
  })

  const emit: EventStreamClientService["emit"] = (stream, event) =>
    Effect.gen(function* () {
      const encoded = yield* encodeEvent(stream, event)
      const eventId = yield* idGen.nextId
      yield* appendChange(
        durable,
        makeEventStreamStateRow({
          stream: stream.name,
          eventId,
          event: encoded,
        }),
        (cause) => new EventStreamAppendError({ stream: stream.name, cause }),
      )
    })

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
  Layer.effect(
    EventStreamClient,
    Effect.map(IdGen, (idGen) => buildEventStreamService(cfg, idGen)),
  ).pipe(Layer.provide(IdGenLive))

export {
  EventStream,
} from "@firegrid/substrate/descriptors"
