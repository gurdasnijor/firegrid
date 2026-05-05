import { DurableStream, type StreamResponse } from "@durable-streams/client"
import {
  isEventStreamEnvelope,
  type EventStream,
} from "@durable-agent-substrate/substrate"
import { Cause, Data, Effect, type ParseResult, Schema, type Scope, Stream } from "effect"
import {
  RuntimeContext,
  type RuntimeContextService,
} from "../runtime-context.ts"

// firegrid-event-streams.RUNTIME_API.1
// firegrid-event-streams.RUNTIME_API.2
// firegrid-event-streams.RUNTIME_API.3
// firegrid-event-streams.SCHEMA_OWNERSHIP.2
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
// firegrid-architecture-boundary.DEPENDENCY_GRAPH.2
//
// Private runtime helper backing the public `Firegrid.eventStream`
// Layer. The materializer follows the runtime's substrate stream as
// raw JSON records (E1 wire envelope, owned by the substrate
// descriptor module: `EVENT_STREAM_ENVELOPE_TAG = "firegrid/event@1"`,
// shape `{ _envelope, stream, event }`), filters envelopes whose
// `stream` matches the descriptor's `name`, decodes the event payload
// via the descriptor's Schema, and runs the caller's materialize
// Effect once per event in arrival order.
//
// Authority (SCHEMA_OWNERSHIP.2): the materializer never writes
// substrate authority rows. ESLint enforces this at the file level
// via a `no-restricted-imports.importNames` block on
// `@durable-agent-substrate/substrate` covering the state-machine
// builders.
//
// Hot-path posture: a single long-lived `DurableStream.stream({ live:
// true })` session is held for the materializer fiber's lifetime; no
// per-wake replay or projection rebuild.
//
// Error policy: stream-session acquisition failures surface as a
// typed `EventStreamSessionError`; decode failures are surfaced as
// `EventStreamMaterializerDecodeError`. Both propagate through the
// forked materializer fiber. Non-interruption causes are logged via
// `Effect.logError` so a failed materializer dies loudly via the
// runtime's default cause logger.

export class EventStreamSessionError extends Data.TaggedError(
  "firegrid/EventStreamSessionError",
)<{
  readonly stream: string
  readonly cause: unknown
}> {}

export class EventStreamMaterializerDecodeError extends Data.TaggedError(
  "firegrid/EventStreamMaterializerDecodeError",
)<{
  readonly stream: string
  readonly cause: ParseResult.ParseError
}> {}

export interface EventStreamMaterializerInput<
  S extends EventStream.Any,
  E,
  R,
> {
  readonly descriptor: S
  readonly materialize: (
    event: EventStream.Event<S>,
  ) => Effect.Effect<void, E, R>
}

export const runEventStreamMaterializer = <
  S extends EventStream.Any,
  E,
  R,
>(
  input: EventStreamMaterializerInput<S, E, R>,
) =>
  Effect.gen(function* () {
    const cfg = yield* RuntimeContext
    yield* Effect.forkScoped(runMaterializerLoop(cfg, input))
  })

// Open a long-lived raw DurableStream session bound to the runtime's
// substrate stream URL. Scope finalization cancels the underlying
// reader so the live-tailing connection is released cleanly.
const acquireSession = (
  cfg: RuntimeContextService,
  descriptorName: string,
): Effect.Effect<
  StreamResponse<unknown>,
  EventStreamSessionError,
  Scope.Scope
> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const handle = new DurableStream({
          url: cfg.streamUrl,
          contentType: cfg.contentType,
        })
        return await handle.stream<unknown>({
          offset: "-1",
          live: true,
        })
      },
      catch: (cause) =>
        new EventStreamSessionError({
          stream: descriptorName,
          cause,
        }),
    }),
    (response) => Effect.promise(async () => response.cancel()),
  )

const decodeEvent = <S extends EventStream.Any>(
  descriptor: S,
  raw: unknown,
): Effect.Effect<
  EventStream.Event<S>,
  EventStreamMaterializerDecodeError
> =>
  Schema.decodeUnknown(descriptor.event as Schema.Schema.AnyNoContext)(
    raw,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new EventStreamMaterializerDecodeError({
          stream: descriptor.name,
          cause,
        }),
    ),
  ) as Effect.Effect<
    EventStream.Event<S>,
    EventStreamMaterializerDecodeError
  >

const runMaterializerLoop = <S extends EventStream.Any, E, R>(
  cfg: RuntimeContextService,
  input: EventStreamMaterializerInput<S, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const response = yield* acquireSession(cfg, input.descriptor.name)
      const records = Stream.async<unknown, EventStreamSessionError>(
        (emit) => {
          // subscribeJson is the durable-streams client's
          // backpressure-aware consumption hook. The unsubscribe
          // function terminates iteration immediately on Scope
          // finalization, which is what we want for clean teardown
          // — async-iterable + interrupt does not propagate the
          // cancel signal reliably across the HTTP reader boundary.
          const subscribable = response as unknown as {
            readonly subscribeJson: (
              handler: (batch: {
                readonly items: ReadonlyArray<unknown>
              }) => unknown,
            ) => () => void
          }
          const unsubscribe = subscribable.subscribeJson((batch) => {
            for (const item of batch.items) {
              void emit.single(item)
            }
          })
          return Effect.sync(() => unsubscribe())
        },
      )
      yield* records.pipe(
        Stream.filter((record) => isEventStreamEnvelope(record)),
        Stream.filter(
          (envelope) => envelope.stream === input.descriptor.name,
        ),
        Stream.mapEffect((envelope) =>
          decodeEvent(input.descriptor, envelope.event),
        ),
        Stream.runForEach((event) => input.materialize(event)),
      )
    }),
  ).pipe(
    Effect.tapErrorCause((cause) =>
      Cause.isInterruptedOnly(cause)
        ? Effect.void
        : Effect.logError(
            `firegrid eventStream ${input.descriptor.name}: materializer loop failed`,
            cause,
          ),
    ),
  )
