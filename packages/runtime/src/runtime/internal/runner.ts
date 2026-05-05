import {
  acquireSubstrateDb,
  snapshotFromDb,
  type CompletionValue,
  type ProjectionSnapshot,
  type SubstrateStreamDB,
} from "@durable-agent-substrate/substrate/kernel"
import {
  Cause,
  Clock,
  Data,
  Duration,
  Effect,
  Fiber,
  Stream,
  type Scope,
} from "effect"
import { RuntimeContext, type RuntimeContextService } from "../runtime-context.ts"

// firegrid-runtime-process.RUNTIME_HOT_PATH.1
//
// Private subscription/deadline-driven runner skeleton used by the
// public `Firegrid.subscribers.{timer, scheduledWork}` Layers. The
// substrate exposes single-shot scan effects; until substrate gains
// an edge-driven runner natively, the runtime owns the wake/loop
// scheduling. This module is NOT part of the public API.
//
// Hot-path discipline: the loop holds a single live SubstrateStreamDB
// for the lifetime of the scoped fiber. The initial `db.preload()`
// inside `acquireDb` establishes the no-gap snapshot boundary; every
// subsequent wake reads `snapshotFromDb(db)` from the live handle and
// hands the same snapshot to both `scan` and `nextDeadlineMs`. The
// runner does NOT call `rebuildProjection()` on each wake, and the
// caller-supplied `scan` is expected to use a snapshot-input
// substrate helper (e.g. `runTimerSubscriberFromSnapshot`) so the
// hot path is rebuild-free.
//
// Error policy (honest, transitional):
//   - openSubstrateDb / preload failures surface as a typed
//     AcquireDbError on the loop fiber.
//   - The caller-supplied scan's typed error channel is preserved
//     and propagates to the loop fiber.
// Both paths run inside Effect.forkScoped, so a failed subscriber
// fiber dies loudly via Effect.logError (the runtime's default
// logger) rather than silently exiting. There is no recovery /
// retry / status surface yet; richer error semantics land with
// Operation.handler.
//
// Coalescing semantics: an in-flight scan plus concurrent wakes
// collapse into exactly one follow-up scan. There is no fixed-
// cadence polling.

type CollectionsDb = SubstrateStreamDB

export class AcquireDbError extends Data.TaggedError("AcquireDbError")<{
  readonly cause: unknown
}> {}

const acquireDb = (cfg: RuntimeContextService) =>
  acquireSubstrateDb(
    {
      url: cfg.streamUrl,
      contentType: cfg.contentType,
    },
    (cause) => new AcquireDbError({ cause }),
  )

export const minPendingDueAtMs = (
  completions: ReadonlyMap<string, CompletionValue>,
  predicate: (c: CompletionValue) => number | undefined,
): number | undefined => {
  let min: number | undefined
  for (const c of completions.values()) {
    if (c.state !== "pending") continue
    const dueAt = predicate(c)
    if (dueAt === undefined) continue
    if (min === undefined || dueAt < min) min = dueAt
  }
  return min
}

export const subscribeCompletions = (
  db: CollectionsDb,
  onEdge: () => void,
): (() => void) => {
  const sub = db.collections.completions.subscribeChanges(onEdge)
  return () => sub.unsubscribe()
}

interface ScopedProgramInput<E> {
  readonly subscribe: (db: CollectionsDb, onEdge: () => void) => () => void
  readonly nextDeadlineMs: (snapshot: ProjectionSnapshot) => number | undefined
  // The scan reads from the live-db snapshot supplied each wake. It
  // must NOT call `rebuildProjection()` itself; the runtime holds the
  // db open for the fiber's lifetime so the initial preload is the
  // only no-gap catch-up boundary needed.
  readonly scan: (snapshot: ProjectionSnapshot) => Effect.Effect<unknown, E>
}

export const runScopedSubscriberProgram = <E>(
  input: ScopedProgramInput<E>,
) =>
  Effect.gen(function* () {
    const cfg = yield* RuntimeContext
    yield* Effect.forkScoped(runScopedSubscriberLoop(cfg, input))
  })

const runScopedSubscriberLoop = <E>(
  cfg: RuntimeContextService,
  input: ScopedProgramInput<E>,
) =>
  runScopedSubscriberLoopWithAcquire(acquireDb(cfg), input)

export const runScopedSubscriberLoopWithAcquire = <E, E2>(
  acquire: Effect.Effect<CollectionsDb, E2, Scope.Scope>,
  input: ScopedProgramInput<E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* acquire
      return yield* runScopedSubscriberLoopFromDb(db, input)
    }),
  )

export const runScopedSubscriberLoopFromDb = <E>(
  db: CollectionsDb,
  input: ScopedProgramInput<E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      let scheduleDeadline: (
        nextDue: number | undefined,
        nowMs: number,
      ) => Effect.Effect<void> = () => Effect.void

      const wakes = Stream.asyncScoped<void>(
        (emit) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              let deadlineFiber:
                | Fiber.RuntimeFiber<void, never>
                | undefined
              const clearDeadline = (): Effect.Effect<void> => {
                if (deadlineFiber === undefined) return Effect.void
                const fiber = deadlineFiber
                deadlineFiber = undefined
                return Fiber.interrupt(fiber).pipe(Effect.asVoid)
              }
              const wake = () => {
                void emit.single(undefined)
              }
              scheduleDeadline = (nextDue, nowMs) => {
                return Effect.gen(function* () {
                  yield* clearDeadline()
                  if (nextDue === undefined) return
                  const delayMs = Math.max(0, nextDue - nowMs)
                  deadlineFiber = yield* Effect.sleep(
                    Duration.millis(delayMs),
                  ).pipe(Effect.tap(() => Effect.sync(wake)), Effect.fork)
                })
              }
              const unsubscribe = input.subscribe(db, wake)
              wake()
              return () => {
                scheduleDeadline = () => Effect.void
                return clearDeadline().pipe(
                  Effect.zipRight(Effect.sync(unsubscribe)),
                )
              }
            }),
            (finalize) => finalize(),
          ),
        { bufferSize: 1, strategy: "sliding" },
      )

      return yield* wakes.pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const snapshot = snapshotFromDb(db)
            yield* input.scan(snapshot)
            const nowMs = yield* Clock.currentTimeMillis
            const nextDue = input.nextDeadlineMs(snapshot)
            yield* scheduleDeadline(nextDue, nowMs)
          }),
        ),
        Stream.runDrain,
        Effect.tapErrorCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.void
            : Effect.logError("firegrid subscriber loop failed", cause),
        ),
      )
    }),
  )
