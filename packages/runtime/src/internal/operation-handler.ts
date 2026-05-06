import { DurableStream } from "@durable-streams/client"
/* eslint-disable @effect/no-import-from-barrel-package -- choreography-facade.CURRENT_WORK_CONTEXT.1: CurrentWorkContext is intentionally exported from the curated substrate root. */
import {
  OwnerId,
  WorkId,
  currentWorkContextLayer,
  type CurrentWorkContext,
} from "@firegrid/substrate"
/* eslint-enable @effect/no-import-from-barrel-package */
import {
  acquireSubstrateDb,
  appendChange,
  completeRunEffect,
  decodeAtBoundary,
  encodeAtBoundary,
  failRunEffect,
  isOperationEnvelope,
  snapshotFromDb,
  type Operation,
  type RunValue,
  type SubstrateStreamDB,
} from "@firegrid/substrate/kernel"
import {
  Cause,
  Data,
  Effect,
  Exit,
  Fiber,
  Option,
  Stream,
  type ParseResult,
  type Scope,
} from "effect"
import { RuntimeContext, type RuntimeContextService } from "../context.ts"
import { wakeStream } from "./wake-stream.ts"

// firegrid-operation-messaging.RUNTIME_HANDLERS.1
// firegrid-operation-messaging.RUNTIME_HANDLERS.2
// firegrid-operation-messaging.RUNTIME_HANDLERS.3
// firegrid-operation-messaging.RUNTIME_HANDLERS.4
//
// Private runtime helper: dispatch newly-started runs whose
// `data` field carries a Firegrid operation envelope to the
// caller's typed handler. v1 has no claim arbitration — a single
// runtime process per operation is the supported topology. Multi-
// process claim integration lands in a later slice; for now a
// stale handler that wakes after a peer terminalized the run will
// see the run in a non-started state and silently skip it (the
// state-machine builder rejects illegal transitions).
//
// Error policy: encode/decode failures of input/output/error
// payloads are surfaced through Effect.logError on the forked
// fiber; the fiber stays alive so subsequent runs are still
// processed. acquireDb / stream-append failures fail the fiber
// loudly (same posture as the timer/scheduledWork subscribers).

export class AcquireDbError extends Data.TaggedError("AcquireDbError")<{
  readonly cause: unknown
}> {}

class AppendEventError extends Data.TaggedError("AppendEventError")<{
  readonly cause: unknown
}> {}

type AppendableStateEvent = Parameters<typeof appendChange>[1]

const acquireDb = (cfg: RuntimeContextService) =>
  acquireSubstrateDb(
    {
      url: cfg.streamUrl,
      contentType: cfg.contentType,
    },
    (cause) => new AcquireDbError({ cause }),
  )

const appendEvent = (stream: DurableStream, event: AppendableStateEvent) =>
  appendChange(stream, event, (cause) => new AppendEventError({ cause }))

interface MatchedRun<Op extends Operation.Any> {
  readonly run: RunValue
  readonly input: Operation.Input<Op>
}

const matchStartedRun = <Op extends Operation.Any>(
  op: Op,
  run: RunValue,
): Effect.Effect<MatchedRun<Op> | undefined, ParseResult.ParseError> => {
  if (run.state !== "started") return Effect.succeed(undefined)
  if (!isOperationEnvelope(run.data)) return Effect.succeed(undefined)
  if (run.data.operation !== op.name) return Effect.succeed(undefined)
  return decodeAtBoundary(op.input, (cause) => cause)(run.data.payload).pipe(
    Effect.map((input) => ({ run, input: input as Operation.Input<Op> })),
  )
}

const currentWorkContextForRun = (
  cfg: RuntimeContextService,
  run: RunValue,
) =>
  currentWorkContextLayer({
    workId: WorkId(run.runId),
    ownerId: OwnerId(cfg.processId),
  })

interface DispatchInput<Op extends Operation.Any, E, R> {
  readonly op: Op
  readonly run: (
    input: Operation.Input<Op>,
  ) => Effect.Effect<Operation.Output<Op>, Operation.Error<Op> | E, R>
}

export const runOperationHandler = <Op extends Operation.Any, E, R>(
  input: DispatchInput<Op, E, R>,
) =>
  Effect.gen(function* () {
    const cfg = yield* RuntimeContext
    yield* Effect.forkScoped(runOperationDispatchLoop(cfg, input))
  })

const runOperationDispatchLoop = <Op extends Operation.Any, E, R>(
  cfg: RuntimeContextService,
  input: DispatchInput<Op, E, R>,
) =>
  runOperationDispatchLoopWithAcquire(cfg, input, acquireDb(cfg))

export const runOperationDispatchLoopWithAcquire = <
  Op extends Operation.Any,
  E,
  R,
  E2,
>(
  cfg: RuntimeContextService,
  input: DispatchInput<Op, E, R>,
  acquire: Effect.Effect<SubstrateStreamDB, E2, Scope.Scope>,
): Effect.Effect<
  void,
  E2,
  Exclude<Exclude<R, CurrentWorkContext>, Scope.Scope>
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* acquire
      const stream = new DurableStream({
        url: cfg.streamUrl,
        contentType: cfg.contentType,
      })

      const processRun = (run: RunValue) =>
        Effect.gen(function* () {
          const matched = yield* matchStartedRun(input.op, run).pipe(
            Effect.catchTag("ParseError", (cause) =>
              Effect.logError(
                `firegrid handler ${input.op.name}: input decode failed for run ${run.runId}`,
                cause,
              ).pipe(Effect.as(undefined)),
            ),
          )
          if (matched === undefined) return

          const handlerFiber = yield* Effect.fork(
            input.run(matched.input).pipe(
              Effect.provide(currentWorkContextForRun(cfg, matched.run)),
            ),
          )
          const exit = yield* Fiber.await(handlerFiber)

          yield* Exit.match(exit, {
            onSuccess: (value) =>
              Effect.gen(function* () {
                const encoded: unknown = yield* encodeAtBoundary(
                  input.op.output,
                  (cause) => cause,
                )(value).pipe(
                  Effect.catchTag("ParseError", (cause) =>
                    Effect.logError(
                      `firegrid handler ${input.op.name}: output encode failed for run ${matched.run.runId}`,
                      cause,
                    ).pipe(Effect.as(undefined)),
                  ),
                )
                if (encoded === undefined) return
                yield* completeRunEffect(matched.run, { result: encoded }).pipe(
                  Effect.flatMap((event) => appendEvent(stream, event)),
                  Effect.catchTags({
                    AppendEventError: (cause) =>
                      Effect.logError(
                        `firegrid handler ${input.op.name}: completeRun append failed for run ${matched.run.runId}`,
                        cause,
                      ),
                    IllegalRunTransition: (cause) =>
                      Effect.logError(
                        `firegrid handler ${input.op.name}: completeRun transition rejected for run ${matched.run.runId}`,
                        cause,
                      ),
                  }),
                )
              }),
            onFailure: (cause) =>
              Effect.gen(function* () {
                // Failure cause -> encode failure error (if typed) or surface the cause.
                if (Cause.isInterruptedOnly(cause)) return
                const errorPayload = Option.getOrElse(
                  Cause.failureOption(cause),
                  () => cause,
                )
                // ParseError captures both "schema cannot encode" and "no
                // typed error declared" cases (the default Schema.Never
                // rejects every payload), and we fall back to
                // `Cause.pretty(cause)` so a failure event always lands.
                const encodedError: unknown = yield* encodeAtBoundary(
                  input.op.error,
                  (cause) => cause,
                )(errorPayload as Operation.Error<Op>).pipe(
                  Effect.catchTag("ParseError", () =>
                    Effect.succeed(Cause.pretty(cause)),
                  ),
                )
                yield* failRunEffect(matched.run, { error: encodedError }).pipe(
                  Effect.flatMap((event) => appendEvent(stream, event)),
                  Effect.catchTags({
                    AppendEventError: (appendCause) =>
                      Effect.logError(
                        `firegrid handler ${input.op.name}: failRun append failed for run ${matched.run.runId}`,
                        appendCause,
                      ),
                    IllegalRunTransition: (appendCause) =>
                      Effect.logError(
                        `firegrid handler ${input.op.name}: failRun transition rejected for run ${matched.run.runId}`,
                        appendCause,
                      ),
                  }),
                )
              }),
          })
        })

      const wakes = wakeStream((wake) =>
        Effect.sync(() => {
          const sub = db.collections.runs.subscribeChanges(wake)
          wake()
          return Effect.sync(() => sub.unsubscribe())
        }),
      )

      return yield* wakes.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const snapshot = snapshotFromDb(db)
            for (const run of snapshot.runs.values()) {
              if (run.state !== "started") continue
              if (!isOperationEnvelope(run.data)) continue
              if (run.data.operation !== input.op.name) continue
              yield* processRun(run)
            }
          }),
        ),
        Stream.runDrain,
        Effect.tapErrorCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.void
            : Effect.logError(
                `firegrid handler ${input.op.name}: dispatch loop failed`,
                cause,
              ),
        ),
      )
    }),
  )
