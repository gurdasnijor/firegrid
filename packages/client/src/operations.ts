import {
  appendChange,
  EventStream,
  Operation,
  OperationHandle,
  OPERATION_ENVELOPE_TAG,
  decodeAtBoundary,
  encodeAtBoundary,
  FiregridSpanAttribute,
  FiregridSpanName,
  firegridErrorTag,
  firegridSpanAttributes,
  type OperationEnvelope,
} from "@firegrid/substrate/descriptors"
import { IdGen, IdGenLive } from "@firegrid/substrate/id-gen"
/* eslint-disable @effect/no-import-from-barrel-package -- Projection is public only from the curated substrate root; kernel imports stay banned. */
import {
  Projection,
  ProjectionLive,
  type ProjectionReadError,
  type ProjectionWaitTimeout,
  type ProjectionQuery,
} from "@firegrid/substrate"
/* eslint-enable @effect/no-import-from-barrel-package */
import type { DurableStream } from "@durable-streams/client"
import type { StateEvent } from "@durable-streams/state"
import {
  Data,
  Effect,
  Layer,
  Stream,
  type ParseResult,
} from "effect"
import {
  buildDurableStreamTransport,
  buildEventStreamService,
} from "./event-streams.ts"
import {
  FiregridClient,
  type FiregridClientConfig,
  type FiregridClientService,
  type OperationState,
} from "./service.ts"

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
// firegrid-client-api.CLIENT_SURFACE.1
// firegrid-client-api.CLIENT_SURFACE.2
// firegrid-client-api.CLIENT_SURFACE.3
// firegrid-client-api.CLIENT_SURFACE.4
// firegrid-client-api.CLIENT_SURFACE.5
// firegrid-client-api.AUTHORITY_BOUNDARY.1
// firegrid-client-api.AUTHORITY_BOUNDARY.2
// firegrid-client-api.AUTHORITY_BOUNDARY.3
//
// FiregridClient is the typed app-facing client. It appends operation
// intent and observes durable outcomes; runtime participants and
// substrate authority own handler execution, claims, completions, and
// terminal authorship. Operation input/output/error pass through the
// descriptor's Schema so the caller sees domain types end-to-end.

// Substrate runs carry caller input on `data`. To dispatch by
// Operation.name in runtime handlers, send wraps the encoded input
// in the shared envelope owned by `@firegrid/substrate`
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

export interface OperationAppendError {
  readonly _tag: "firegrid/OperationAppendError"
  readonly operation: string
  readonly cause: unknown
}

const operationAppendError = (
  operation: string,
  cause: unknown,
): OperationAppendError => ({
  _tag: "firegrid/OperationAppendError",
  operation,
  cause,
})

export type SendError = OperationEncodeError | OperationAppendError

export type ResultError =
  | OperationDecodeError
  | OperationCancelled
  | OperationNotFound
  | ProjectionWaitTimeout
  | ProjectionReadError

export type ObserveError = ProjectionReadError | OperationDecodeError
export {
  EventStreamAppendError,
  EventStreamDecodeError,
  EventStreamEncodeError,
  EventStreamReadError,
} from "./event-streams.ts"
export type { EmitError, EventsError } from "./event-streams.ts"

// ────────────────────────────────────────────────────────────────
type OperationRun = {
  readonly runId: string
  readonly state: "started" | "blocked" | "completed" | "failed" | "cancelled"
  readonly result?: unknown
  readonly error?: unknown
  readonly terminalReason?: unknown
}

const runQuery = (
  handleId: string,
): ProjectionQuery<OperationRun | undefined> => ({
  label: `firegrid.client.operation:${handleId}`,
  evaluate: (snap) =>
    Effect.succeed(snap.runs.get(handleId)),
})

const startedRunChange = (
  runId: string,
  data: OperationEnvelope,
): StateEvent => ({
  type: "durable.run",
  key: runId,
  value: {
    runId,
    state: "started",
    data,
  },
  headers: {
    operation: "insert",
  },
})

const isTerminalRun = (run: OperationRun | undefined): boolean =>
  run !== undefined &&
  (run.state === "completed" ||
    run.state === "failed" ||
    run.state === "cancelled")

// ────────────────────────────────────────────────────────────────
// Service

// Re-export descriptor namespaces so app code can import a single
// client module for operation messaging and EventStream APIs.
export { EventStream, Operation, OperationHandle }

// ────────────────────────────────────────────────────────────────
// Live wiring

const decodeOutput = <Op extends Operation.Any>(
  op: Op,
  raw: unknown,
): Effect.Effect<Operation.Output<Op>, OperationDecodeError> =>
  decodeAtBoundary(
    op.output,
    (cause) =>
      new OperationDecodeError({
        operation: op.name,
        field: "output",
        cause,
      }),
  )(raw) as Effect.Effect<Operation.Output<Op>, OperationDecodeError>

const decodeError = <Op extends Operation.Any>(
  op: Op,
  raw: unknown,
): Effect.Effect<Operation.Error<Op>, OperationDecodeError> =>
  decodeAtBoundary(
    op.error,
    (cause) =>
      new OperationDecodeError({
        operation: op.name,
        field: "error",
        cause,
      }),
  )(raw) as Effect.Effect<Operation.Error<Op>, OperationDecodeError>

const mapRunToState = <Op extends Operation.Any>(
  op: Op,
  run: OperationRun | undefined,
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

const operationHandleSpanAttributes = <Op extends Operation.Any>(
  op: Op,
  handle: OperationHandle<Op>,
) =>
  firegridSpanAttributes({
    [FiregridSpanAttribute.operationDescriptor]: op.name,
    [FiregridSpanAttribute.operationHandleId]: handle.id,
    [FiregridSpanAttribute.runId]: handle.id,
  })

const buildFiregridClientService = (
  projection: Projection["Type"],
  durable: DurableStream,
  idGen: IdGen["Type"],
  eventStreams: ReturnType<typeof buildEventStreamService>,
): FiregridClientService => {
  const send: FiregridClientService["send"] = (op, input) =>
    encodeAtBoundary(
      op.input,
      (cause) =>
        new OperationEncodeError({ operation: op.name, cause }),
    )(input).pipe(
      Effect.flatMap((encoded) =>
        idGen.nextId.pipe(
          Effect.flatMap((handleId) =>
            appendChange(
              durable,
              startedRunChange(handleId, wrap(op.name, encoded)),
              (cause) => operationAppendError(op.name, cause),
            ).pipe(
              Effect.as(OperationHandle.make(op, handleId)),
            ),
          ),
        ),
      ),
      Effect.tap((handle) =>
        Effect.annotateCurrentSpan({
          [FiregridSpanAttribute.operationHandleId]: handle.id,
          [FiregridSpanAttribute.runId]: handle.id,
        }),
      ),
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan({
          [FiregridSpanAttribute.errorTag]: firegridErrorTag(error),
        }),
      ),
      Effect.withSpan(FiregridSpanName.clientOperationSend, {
        kind: "client",
        attributes: firegridSpanAttributes({
          [FiregridSpanAttribute.operationDescriptor]: op.name,
        }),
      }),
    )

  const result: FiregridClientService["result"] = <Op extends Operation.Any>(
    op: Op,
    handle: OperationHandle<Op>,
  ): Effect.Effect<
    Operation.Output<Op>,
    ResultError | Operation.Error<Op>
  > => {
    const decideTerminal = (
      run: OperationRun | undefined,
    ): Effect.Effect<
      Operation.Output<Op>,
      ResultError | Operation.Error<Op>
    > => {
      if (run === undefined) {
        return Effect.annotateCurrentSpan({
          [FiregridSpanAttribute.status]: "not_found",
        }).pipe(
          Effect.zipRight(
            Effect.fail(new OperationNotFound({ handleId: handle.id })),
          ),
        )
      }
      if (run.state === "completed") {
        return decodeOutput(op, run.result).pipe(
          Effect.tap(() =>
            Effect.annotateCurrentSpan({
              [FiregridSpanAttribute.status]: "completed",
            }),
          ),
        )
      }
      if (run.state === "failed") {
        return decodeError(op, run.error).pipe(
          Effect.tap(() =>
            Effect.annotateCurrentSpan({
              [FiregridSpanAttribute.status]: "failed",
            }),
          ),
          Effect.flatMap((decoded) =>
            Effect.fail<Operation.Error<Op>>(decoded),
          ),
        )
      }
      if (run.state === "cancelled") {
        return Effect.annotateCurrentSpan({
          [FiregridSpanAttribute.status]: "cancelled",
        }).pipe(
          Effect.zipRight(
            Effect.fail(
              new OperationCancelled({
                handleId: handle.id,
                ...(run.terminalReason !== undefined
                  ? { terminalReason: run.terminalReason }
                  : {}),
              }),
            ),
          ),
        )
      }
      // until(isTerminalRun) excludes started/blocked; this branch
      // is structurally unreachable. Surface as OperationNotFound
      // rather than die so the public error channel stays clean.
      return Effect.annotateCurrentSpan({
        [FiregridSpanAttribute.status]: run.state,
      }).pipe(
        Effect.zipRight(
          Effect.fail(new OperationNotFound({ handleId: handle.id })),
        ),
      )
    }
    return projection
      .until(runQuery(handle.id), isTerminalRun)
      .pipe(
        Effect.flatMap(decideTerminal),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan({
            [FiregridSpanAttribute.errorTag]: firegridErrorTag(error),
          }),
        ),
        Effect.withSpan(FiregridSpanName.clientOperationResult, {
          kind: "client",
          attributes: operationHandleSpanAttributes(op, handle),
        }),
      )
  }

  const call: FiregridClientService["call"] = (op, input) =>
    send(op, input).pipe(Effect.flatMap((handle) => result(op, handle)))

  const observe: FiregridClientService["observe"] = (op, handle) =>
    projection
      .stream(runQuery(handle.id))
      .pipe(
        Stream.mapEffect((run) =>
          mapRunToState(op, run).pipe(
            Effect.tap((state) =>
              Effect.annotateCurrentSpan({
                [FiregridSpanAttribute.status]: state._tag,
              }),
            ),
            Effect.tapError((error) =>
              Effect.annotateCurrentSpan({
                [FiregridSpanAttribute.errorTag]: firegridErrorTag(error),
              }),
            ),
          ),
        ),
        Stream.withSpan(FiregridSpanName.clientOperationObserve, {
          kind: "client",
          attributes: operationHandleSpanAttributes(op, handle),
        }),
      )

  return { ...eventStreams, send, result, call, observe }
}

// firegrid-client-api.STREAM_CONFIGURATION.1
// firegrid-client-api.STREAM_CONFIGURATION.2
// firegrid-client-api.STREAM_CONFIGURATION.3
// firegrid-remediation-hardening.EFFECT_CONSISTENCY.1
// firegrid-remediation-hardening.EFFECT_CONSISTENCY.5
// FiregridClientLive receives transport configuration explicitly and
// installs a scoped Projection once for result/observe flows. The root
// client has no runtime process identity, handler graph, subscriber
// graph, claim owner, or wait-primitive configuration.
export const FiregridClientLive = (
  cfg: FiregridClientConfig,
): Layer.Layer<FiregridClient, ProjectionReadError> => {
  const inner = Layer.effect(
    FiregridClient,
    Effect.gen(function* () {
      const projection = yield* Projection
      const idGen = yield* IdGen
      const durable = buildDurableStreamTransport(cfg)
      const eventStreams = buildEventStreamService(cfg, idGen)
      return buildFiregridClientService(projection, durable, idGen, eventStreams)
    }),
  )

  return inner.pipe(
    Layer.provide(ProjectionLive({
      streamUrl: cfg.streamUrl,
      ...(cfg.contentType !== undefined ? { contentType: cfg.contentType } : {}),
    })),
    Layer.provide(IdGenLive),
  )
}

export {
  FiregridClient,
}

export type {
  FiregridClientConfig,
  FiregridClientService,
  OperationState,
} from "./service.ts"
