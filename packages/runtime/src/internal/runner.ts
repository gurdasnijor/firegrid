import {
  acquireSubstrateDb,
  snapshotFromDb,
  type CompletionValue,
  type ProjectionSnapshot,
  type SubstrateStreamDB,
} from "@firegrid/substrate/kernel"
import {
  Cause,
  Clock,
  Data,
  Duration,
  Effect,
  Queue,
  Stream,
  type Scope,
} from "effect"
import { RuntimeContext, type RuntimeContextService } from "../context.ts"

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

interface DeadlineSchedule {
  readonly nextDue: number | undefined
  readonly nowMs: number
}

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

const deadlineWakeStream = (
  schedules: Queue.Dequeue<DeadlineSchedule>,
): Stream.Stream<void> =>
  Stream.fromQueue(schedules).pipe(
    Stream.flatMap(
      ({ nextDue, nowMs }) => {
        if (nextDue === undefined) return Stream.empty
        const delayMs = Math.max(0, nextDue - nowMs)
        return Stream.fromEffect(Effect.sleep(Duration.millis(delayMs)))
      },
      { concurrency: 1, switch: true, bufferSize: 1 },
    ),
  )

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
      const wakeEvents = yield* Queue.sliding<void>(1)
      const deadlineSchedules = yield* Queue.sliding<DeadlineSchedule>(1)
      yield* Effect.addFinalizer(() =>
        Queue.shutdown(wakeEvents).pipe(
          Effect.zipRight(Queue.shutdown(deadlineSchedules)),
        ),
      )
      const wake = () => {
        void wakeEvents.unsafeOffer(undefined)
      }
      const scheduleDeadline = (
        nextDue: number | undefined,
        nowMs: number,
      ) =>
        Queue.offer(deadlineSchedules, { nextDue, nowMs }).pipe(Effect.asVoid)

      yield* deadlineWakeStream(deadlineSchedules).pipe(
        Stream.runForEach(() => Effect.sync(wake)),
        Effect.forkScoped,
      )
      yield* Effect.acquireRelease(
        Effect.sync(() => input.subscribe(db, wake)),
        (unsubscribe) => Effect.sync(unsubscribe),
      )
      wake()
      // firegrid-remediation-hardening.EFFECT_CONSISTENCY.3
      // Subscription and deadline edges both mean "re-read the live
      // snapshot"; a single sliding queue preserves coalescing across
      // both wake sources while a scan is in flight.
      const wakes = Stream.fromQueue(wakeEvents)

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
