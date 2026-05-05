import {
  EventStream,
  isOperationEnvelope,
  Operation,
  OperationHandle,
  OPERATION_ENVELOPE_TAG,
  type OperationEnvelope,
  type ProjectionReadError,
  type ProjectionWaitTimeout,
  type RunValue,
} from "@durable-agent-substrate/substrate"
import {
  Context,
  Data,
  Effect,
  Layer,
  ParseResult,
  Schema,
  Stream,
} from "effect"
import { SubstrateClient } from "../client/service.ts"

// firegrid-operation-messaging.CLIENT_MESSAGING.1
// firegrid-operation-messaging.CLIENT_MESSAGING.2
// firegrid-operation-messaging.CLIENT_MESSAGING.3
// firegrid-operation-messaging.CLIENT_MESSAGING.4
// firegrid-operation-messaging.CLIENT_MESSAGING.6
// firegrid-operation-messaging.APP_BOUNDARY.3
// firegrid-event-streams.CLIENT_API.4
//
// FiregridClient is the typed app-facing client. It is a thin facade
// over SubstrateClient: send maps to client.work.declare,
// result/observe map to client.work.observe. Operation
// input/output/error pass through the descriptor's Schema, so the
// caller sees domain types end-to-end.
//
// EventStream emit/events are intentionally NOT exposed yet — there
// is no real lowering path in this slice. Once event-plane
// materializers land, the methods join FiregridClient with real
// implementations (no NotYetLowered placeholders on the public
// surface).

// Substrate runs carry caller input on `data`. To dispatch by
// Operation.name in runtime handlers, send wraps the encoded input
// in the shared envelope owned by `@durable-agent-substrate/substrate`
// (descriptors module) so the encode and decode sides cannot drift.
const wrap = (operation: string, payload: unknown): OperationEnvelope => ({
  _envelope: OPERATION_ENVELOPE_TAG,
  operation,
  payload,
})

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

export type SendError = OperationEncodeError

export type ResultError =
  | OperationDecodeError
  | OperationCancelled
  | OperationNotFound
  | ProjectionWaitTimeout
  | ProjectionReadError

export type ObserveError = ProjectionReadError | OperationDecodeError

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
}

export class FiregridClient extends Context.Tag("firegrid/FiregridClient")<
  FiregridClient,
  FiregridClientService
>() {}

// EventStream descriptor + type helpers are usable today; client
// emit/events lower in a later slice. Re-export the descriptor
// namespaces so app code can import a single client module for
// both descriptor + client APIs.
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
          ({ _tag: "Failed" as const, error }) as OperationState<Op>,
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

const buildService = (
  client: typeof SubstrateClient.Service,
): FiregridClientService => {
  const send: FiregridClientService["send"] = (op, input) =>
    Schema.encodeUnknown(op.input as Schema.Schema.AnyNoContext)(input).pipe(
      Effect.mapError(
        (cause) =>
          new OperationEncodeError({ operation: op.name, cause }),
      ),
      Effect.flatMap((encoded) =>
        client.work
          .declare({ input: wrap(op.name, encoded) })
          .pipe(
            Effect.map(({ workId }) => OperationHandle.make(op, workId)),
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
            Effect.fail<Operation.Error<Op>>(decoded as Operation.Error<Op>),
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
    return client.work
      .observe(handle.id)
      .until(isTerminalRun)
      .pipe(Effect.flatMap(decideTerminal))
  }

  const call: FiregridClientService["call"] = (op, input) =>
    send(op, input).pipe(Effect.flatMap((handle) => result(op, handle)))

  const observe: FiregridClientService["observe"] = (op, handle) =>
    client.work
      .observe(handle.id)
      .stream()
      .pipe(Stream.mapEffect((run) => mapRunToState(op, run)))

  return { send, result, call, observe }
}

export const FiregridClientLive: Layer.Layer<
  FiregridClient,
  never,
  SubstrateClient
> = Layer.effect(
  FiregridClient,
  Effect.gen(function* () {
    const client = yield* SubstrateClient
    return buildService(client)
  }),
)
