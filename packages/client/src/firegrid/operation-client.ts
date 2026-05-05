import {
  EventStream,
  eventStreamEnvelopeFromStateRow,
  isEventStreamEnvelope,
  makeEventStreamStateRow,
  Operation,
  OperationHandle,
  OPERATION_ENVELOPE_TAG,
  type OperationEnvelope,
  type ProjectionReadError,
  type ProjectionWaitTimeout,
  type RunValue,
} from "@durable-agent-substrate/substrate"
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
import {
  SubstrateClient,
  SubstrateClientLive,
  type SubstrateClientConfig,
} from "../client/service.ts"

// firegrid-operation-messaging.CLIENT_MESSAGING.1
// firegrid-operation-messaging.CLIENT_MESSAGING.2
// firegrid-operation-messaging.CLIENT_MESSAGING.3
// firegrid-operation-messaging.CLIENT_MESSAGING.4
// firegrid-operation-messaging.CLIENT_MESSAGING.6
// firegrid-operation-messaging.APP_BOUNDARY.3
// firegrid-event-streams.CLIENT_API.1
// firegrid-event-streams.CLIENT_API.2
// firegrid-event-streams.CLIENT_API.3
// firegrid-event-streams.CLIENT_API.4
//
// FiregridClient is the typed app-facing client. It is a thin facade
// over SubstrateClient: send maps to client.work.declare,
// result/observe map to client.work.observe. Operation
// input/output/error pass through the descriptor's Schema, so the
// caller sees domain types end-to-end.

// Substrate runs carry caller input on `data`. To dispatch by
// Operation.name in runtime handlers, send wraps the encoded input
// in the shared envelope owned by `@durable-agent-substrate/substrate`
// (descriptors module) so the encode and decode sides cannot drift.
const wrap = (operation: string, payload: unknown): OperationEnvelope => ({
  _envelope: OPERATION_ENVELOPE_TAG,
  operation,
  payload,
})

const nextEventId = (): string =>
  `${Date.now()}:${Math.random().toString(36).slice(2)}`

// ────────────────────────────────────────────────────────────────
// Errors

export class OperationEncodeError extends Data.TaggedError(
  "firegrid/OperationEncodeError",
)<{
  readonly operation: string
  readonly cause: ParseResult.ParseError
}> {}

export class OperationDecodeError extends Data.TaggedError(
  "firegrid/OperationDecodeError",
)<{
  readonly operation: string
  readonly field: "output" | "error"
  readonly cause: ParseResult.ParseError
}> {}

export class OperationCancelled extends Data.TaggedError(
  "firegrid/OperationCancelled",
)<{
  readonly handleId: string
  readonly terminalReason?: unknown
}> {}

export class OperationNotFound extends Data.TaggedError(
  "firegrid/OperationNotFound",
)<{
  readonly handleId: string
}> {}

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

export type SendError = OperationEncodeError
export type EmitError = EventStreamEncodeError | EventStreamAppendError

export type ResultError =
  | OperationDecodeError
  | OperationCancelled
  | OperationNotFound
  | ProjectionWaitTimeout
  | ProjectionReadError

export type ObserveError = ProjectionReadError | OperationDecodeError
export type EventsError = EventStreamReadError | EventStreamDecodeError

// ────────────────────────────────────────────────────────────────
// OperationState (narrow, grounded directly in substrate run states)

export type OperationState<Op extends Operation.Any> =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Completed"; readonly output: Operation.Output<Op> }
  | { readonly _tag: "Failed"; readonly error: Operation.Error<Op> }
  | { readonly _tag: "Cancelled"; readonly terminalReason?: unknown }

const isTerminalRun = (run: RunValue | undefined): boolean =>
  run !== undefined &&
  (run.state === "completed" ||
    run.state === "failed" ||
    run.state === "cancelled")

// ────────────────────────────────────────────────────────────────
// Service

export interface FiregridClientService {
  readonly send: <Op extends Operation.Any>(
    op: Op,
    input: Operation.Input<Op>,
  ) => Effect.Effect<OperationHandle<Op>, SendError>

  readonly result: <Op extends Operation.Any>(
    op: Op,
    handle: OperationHandle<Op>,
  ) => Effect.Effect<
    Operation.Output<Op>,
    ResultError | Operation.Error<Op>
  >

  readonly call: <Op extends Operation.Any>(
    op: Op,
    input: Operation.Input<Op>,
  ) => Effect.Effect<
    Operation.Output<Op>,
    SendError | ResultError | Operation.Error<Op>
  >

  readonly observe: <Op extends Operation.Any>(
    op: Op,
    handle: OperationHandle<Op>,
  ) => Stream.Stream<OperationState<Op>, ObserveError>

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

// Re-export descriptor namespaces so app code can import a single
// client module for operation messaging and EventStream APIs.
export { EventStream, Operation, OperationHandle }

// ────────────────────────────────────────────────────────────────
// Live wiring (composes over SubstrateClient)

// Descriptor schema slots are typed as `Schema.Schema.All`, which
// admits `Schema<never, …>` branches and (in the public alias
// surface) carries `R = unknown`. `Schema.decodeUnknown` /
// `Schema.encodeUnknown` produce an Effect whose R matches the
// schema's R; to keep our public methods at `R = never` we cast to
// `Schema.Schema.AnyNoContext` (= `Schema<any, any, never>`). The
// cast is sound in v1 because descriptors carry pure schemas
// without context-using requirements; if a future descriptor needs
// context, the surface widens openly rather than silently.
const decodeOutput = <Op extends Operation.Any>(
  op: Op,
  raw: unknown,
): Effect.Effect<Operation.Output<Op>, OperationDecodeError> =>
  Schema.decodeUnknown(op.output as Schema.Schema.AnyNoContext)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new OperationDecodeError({
          operation: op.name,
          field: "output",
          cause,
        }),
    ),
  ) as Effect.Effect<Operation.Output<Op>, OperationDecodeError>

const decodeError = <Op extends Operation.Any>(
  op: Op,
  raw: unknown,
): Effect.Effect<Operation.Error<Op>, OperationDecodeError> =>
  Schema.decodeUnknown(op.error as Schema.Schema.AnyNoContext)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new OperationDecodeError({
          operation: op.name,
          field: "error",
          cause,
        }),
    ),
  ) as Effect.Effect<Operation.Error<Op>, OperationDecodeError>

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

const mapRunToState = <Op extends Operation.Any>(
  op: Op,
  run: RunValue | undefined,
): Effect.Effect<OperationState<Op>, OperationDecodeError> => {
  if (run === undefined || run.state === "started" || run.state === "blocked") {
    return Effect.succeed({ _tag: "Pending" } as const)
  }
  if (run.state === "completed") {
    return decodeOutput(op, run.result).pipe(
      Effect.map((output) => ({ _tag: "Completed" as const, output })),
    )
  }
  if (run.state === "failed") {
    return decodeError(op, run.error).pipe(
      Effect.map(
        (error) =>
          ({ _tag: "Failed" as const, error }),
      ),
    )
  }
  return Effect.succeed({
    _tag: "Cancelled" as const,
    ...(run.terminalReason !== undefined
      ? { terminalReason: run.terminalReason }
      : {}),
  })
}

const buildService = (cfg: SubstrateClientConfig): FiregridClientService => {
  const durable = new DurableStream({
    url: cfg.streamUrl,
    contentType: cfg.contentType ?? "application/json",
  })

  const withSubstrate = <A, E>(
    f: (client: typeof SubstrateClient.Service) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const client = yield* SubstrateClient
      return yield* f(client)
    }).pipe(Effect.provide(SubstrateClientLive(cfg)))

  const send: FiregridClientService["send"] = (op, input) =>
    Schema.encodeUnknown(op.input as Schema.Schema.AnyNoContext)(input).pipe(
      Effect.mapError(
        (cause) =>
          new OperationEncodeError({ operation: op.name, cause }),
      ),
      Effect.flatMap((encoded) =>
        withSubstrate((client) =>
          client.work
            .declare({ input: wrap(op.name, encoded) })
            .pipe(
              Effect.map(({ workId }) => OperationHandle.make(op, workId)),
            ),
        ),
      ),
    )

  const result: FiregridClientService["result"] = <Op extends Operation.Any>(
    op: Op,
    handle: OperationHandle<Op>,
  ): Effect.Effect<
    Operation.Output<Op>,
    ResultError | Operation.Error<Op>
  > => {
    const decideTerminal = (
      run: RunValue | undefined,
    ): Effect.Effect<
      Operation.Output<Op>,
      ResultError | Operation.Error<Op>
    > => {
      if (run === undefined) {
        return Effect.fail(new OperationNotFound({ handleId: handle.id }))
      }
      if (run.state === "completed") {
        return decodeOutput(op, run.result)
      }
      if (run.state === "failed") {
        return decodeError(op, run.error).pipe(
          Effect.flatMap((decoded) =>
            Effect.fail<Operation.Error<Op>>(decoded),
          ),
        )
      }
      if (run.state === "cancelled") {
        return Effect.fail(
          new OperationCancelled({
            handleId: handle.id,
            ...(run.terminalReason !== undefined
              ? { terminalReason: run.terminalReason }
              : {}),
          }),
        )
      }
      // until(isTerminalRun) excludes started/blocked; this branch
      // is structurally unreachable. Surface as OperationNotFound
      // rather than die so the public error channel stays clean.
      return Effect.fail(new OperationNotFound({ handleId: handle.id }))
    }
    return withSubstrate((client) =>
      client.work
        .observe(handle.id)
        .until(isTerminalRun)
        .pipe(Effect.flatMap(decideTerminal)),
    )
  }

  const call: FiregridClientService["call"] = (op, input) =>
    send(op, input).pipe(Effect.flatMap((handle) => result(op, handle)))

  const observe: FiregridClientService["observe"] = (op, handle) =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        const client = yield* SubstrateClient
        return client.work
          .observe(handle.id)
          .stream()
          .pipe(Stream.mapEffect((run) => mapRunToState(op, run)))
      }),
    ).pipe(Stream.provideLayer(SubstrateClientLive(cfg)))

  const emit: FiregridClientService["emit"] = (stream, event) =>
    encodeEvent(stream, event).pipe(
      Effect.flatMap((encoded) => {
        return Effect.tryPromise({
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
        })
      }),
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
        if (!isEventStreamEnvelope(envelope)) return Option.none()
        if (envelope.stream !== stream.name) return Option.none()
        return Option.some(decodeEvent(stream, envelope.event))
      }),
    )

  return { send, result, call, observe, emit, events }
}

export type FiregridClientConfig = SubstrateClientConfig

export const FiregridClientLive = (
  cfg: FiregridClientConfig,
): Layer.Layer<FiregridClient> =>
  Layer.succeed(FiregridClient, buildService(cfg))
