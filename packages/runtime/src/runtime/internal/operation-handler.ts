import { DurableStream } from "@durable-streams/client"
import {
  completeRun,
  failRun,
  isOperationEnvelope,
  Operation,
  openSubstrateDb,
  snapshotFromDb,
  type RunValue,
} from "@durable-agent-substrate/substrate"
import { Cause, Data, Effect, ParseResult, Schema } from "effect"
import { RuntimeContext, type RuntimeContextService } from "../runtime-context.ts"

// firegrid-operation-messaging.RUNTIME_HANDLERS.1
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

class AcquireDbError extends Data.TaggedError("AcquireDbError")<{
  readonly cause: unknown
}> {}

class AppendEventError extends Data.TaggedError("AppendEventError")<{
  readonly cause: unknown
}> {}

const acquireDb = (cfg: RuntimeContextService) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const db = openSubstrateDb({
          url: cfg.streamUrl,
          contentType: cfg.contentType,
        })
        await db.preload()
        return db
      },
      catch: (cause) => new AcquireDbError({ cause }),
    }),
    (db) => Effect.sync(() => db.close()),
  )

const appendEvent = (stream: DurableStream, event: unknown) =>
  Effect.tryPromise({
    try: () => stream.append(JSON.stringify(event)),
    catch: (cause) => new AppendEventError({ cause }),
  })

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
  return Schema.decodeUnknown(op.input as Schema.Schema.AnyNoContext)(
    run.data.payload,
  ).pipe(Effect.map((input) => ({ run, input: input as Operation.Input<Op> })))
}

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
    yield* Effect.forkScoped(runDispatchLoop(cfg, input))
  })

const runDispatchLoop = <Op extends Operation.Any, E, R>(
  cfg: RuntimeContextService,
  input: DispatchInput<Op, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const latch = yield* Effect.makeLatch(false)
      const db = yield* acquireDb(cfg)
      const stream = new DurableStream({
        url: cfg.streamUrl,
        contentType: cfg.contentType,
      })

      const sub = db.collections.runs.subscribeChanges(() =>
        latch.unsafeOpen(),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => sub.unsubscribe()))

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

          const exit = yield* Effect.exit(input.run(matched.input))
          if (exit._tag === "Success") {
            const encoded: unknown = yield* Schema.encodeUnknown(
              input.op.output as Schema.Schema.AnyNoContext,
            )(exit.value).pipe(
              Effect.catchTag("ParseError", (cause) =>
                Effect.logError(
                  `firegrid handler ${input.op.name}: output encode failed for run ${matched.run.runId}`,
                  cause,
                ).pipe(Effect.as(undefined)),
              ),
            )
            if (encoded === undefined) return
            yield* Effect.try({
              try: () => completeRun(matched.run, { result: encoded }),
              catch: (cause) => cause,
            }).pipe(
              Effect.flatMap((event) => appendEvent(stream, event)),
              Effect.catchAll((cause) =>
                Effect.logError(
                  `firegrid handler ${input.op.name}: completeRun append failed for run ${matched.run.runId}`,
                  cause,
                ),
              ),
            )
            return
          }
          // Failure cause → encode failure error (if typed) or surface the cause.
          const cause = exit.cause
          if (Cause.isInterruptedOnly(cause)) return
          const failure = Cause.failureOption(cause)
          const errorPayload = failure._tag === "Some" ? failure.value : cause
          // op.error is `Schema.Schema.All`, which Effect documents as
          // including `Schema<never, …>`-style branches. `encodeUnknown`
          // is typed against `Schema.Schema.AnyNoContext` (the never-excluded
          // alias), so we cast at the call boundary. ParseError
          // captures both "schema cannot encode" and "no typed error
          // declared" cases (the default Schema.Never rejects every
          // payload), and we fall back to `Cause.pretty(cause)` so a
          // failure event always lands.
          const encodedError: unknown = yield* Schema.encodeUnknown(
            input.op.error as Schema.Schema.AnyNoContext,
          )(errorPayload).pipe(
            Effect.catchTag("ParseError", () =>
              Effect.succeed(Cause.pretty(cause)),
            ),
          )
          yield* Effect.try({
            try: () => failRun(matched.run, { error: encodedError }),
            catch: (cause) => cause,
          }).pipe(
            Effect.flatMap((event) => appendEvent(stream, event)),
            Effect.catchAll((appendCause) =>
              Effect.logError(
                `firegrid handler ${input.op.name}: failRun append failed for run ${matched.run.runId}`,
                appendCause,
              ),
            ),
          )
        })

      const step = Effect.gen(function* () {
        const snapshot = snapshotFromDb(db)
        for (const run of snapshot.runs.values()) {
          if (run.state !== "started") continue
          if (!isOperationEnvelope(run.data)) continue
          if (run.data.operation !== input.op.name) continue
          yield* processRun(run)
        }
        yield* latch.await
        yield* latch.close
      })

      return yield* Effect.forever(step).pipe(
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
