import { DurableStream, type StreamResponse } from "@durable-streams/client"
import {
  decodeAtBoundary,
  eventStreamEnvelopeFromStateRow,
  isEventStreamEnvelope,
  type EventStream,
} from "@firegrid/substrate/descriptors"
import {
  Cause,
  Data,
  Effect,
  Option,
  type ParseResult,
  type Scope,
  Stream,
} from "effect"
import {
  RuntimeContext,
  type RuntimeContextService,
} from "../context.ts"

// firegrid-event-streams.RUNTIME_API.1
// firegrid-event-streams.RUNTIME_API.2
// firegrid-event-streams.RUNTIME_API.3
// firegrid-event-streams.SCHEMA_OWNERSHIP.2
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
// firegrid-architecture-boundary.DEPENDENCY_GRAPH.2
//
// Private runtime helper backing the public `Firegrid.eventStream`
// Layer. The materializer follows the runtime's substrate stream as
// Durable Streams State Protocol rows (`type`, `key`, `value`,
// `headers.operation`). Firegrid EventStream rows use `type:
// "firegrid.event"` and carry the shared envelope as `value`. The
// materializer filters rows whose envelope stream matches the
// descriptor's `name`, decodes the event payload via the descriptor's
// Schema, and runs the caller's materialize Effect once per event in
// arrival order.
//
// Authority (SCHEMA_OWNERSHIP.2): the materializer never writes
// substrate authority rows. ESLint enforces this at the file level
// via a `no-restricted-imports.importNames` block on
// `@firegrid/substrate` covering the state-machine
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

class EventStreamSessionError extends Data.TaggedError(
  "firegrid/EventStreamSessionError",
)<{
  readonly stream: string
  readonly cause: unknown
}> {}

class EventStreamMaterializerDecodeError extends Data.TaggedError(
  "firegrid/EventStreamMaterializerDecodeError",
)<{
  readonly stream: string
  readonly cause: ParseResult.ParseError
}> {}

interface EventStreamMaterializerInput<
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
  decodeAtBoundary(
    descriptor.event,
    (cause) =>
      new EventStreamMaterializerDecodeError({
        stream: descriptor.name,
        cause,
      }),
  )(raw) as Effect.Effect<
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
      // firegrid-remediation-hardening.EFFECT_CONSISTENCY.3
      const records = Stream.asyncScoped<unknown>(
        (emit) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              response.subscribeJson<unknown>(async (batch) => {
                for (const item of batch.items) {
                  await emit.single(item)
                }
              }),
            ),
            (unsubscribe) => Effect.sync(() => unsubscribe()),
          ),
        { bufferSize: 64, strategy: "suspend" },
      )
      yield* records.pipe(
        Stream.filterMap((record) =>
          Option.fromNullable(eventStreamEnvelopeFromStateRow(record)),
        ),
        Stream.filter((envelope) => isEventStreamEnvelope(envelope)),
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
