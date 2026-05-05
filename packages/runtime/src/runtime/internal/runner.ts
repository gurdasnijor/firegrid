import {
  openSubstrateDb,
  snapshotFromDb,
  type CompletionValue,
  type ProjectionSnapshot,
} from "@durable-agent-substrate/substrate"
import { Cause, Clock, Data, Duration, Effect } from "effect"
import { RuntimeContext, type RuntimeContextService } from "../runtime-context.ts"

// Private subscription/deadline-driven runner skeleton used by the
// public `Firegrid.subscribers.{timer, scheduledWork}` Layers. The
// substrate exposes single-shot scan effects; until substrate gains
// an edge-driven runner natively, the runtime owns the wake/loop
// scheduling. This module is NOT part of the public API.
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

type CollectionsDb = ReturnType<typeof openSubstrateDb>

export class AcquireDbError extends Data.TaggedError("AcquireDbError")<{
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

export interface ScopedProgramInput<E> {
  readonly subscribe: (db: CollectionsDb, onEdge: () => void) => () => void
  readonly nextDeadlineMs: (snapshot: ProjectionSnapshot) => number | undefined
  readonly scan: Effect.Effect<unknown, E>
}

export const runScopedSubscriberProgram = <E>(
  input: ScopedProgramInput<E>,
) =>
  Effect.gen(function* () {
    const cfg = yield* RuntimeContext
    yield* Effect.forkScoped(runLoop(cfg, input))
  })

const runLoop = <E>(
  cfg: RuntimeContextService,
  input: ScopedProgramInput<E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const latch = yield* Effect.makeLatch(false)
      const db = yield* acquireDb(cfg)
      const unsubscribe = input.subscribe(db, () => latch.unsafeOpen())
      yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()))

      const step = Effect.gen(function* () {
        yield* input.scan
        const snapshot = snapshotFromDb(db)
        const nowMs = yield* Clock.currentTimeMillis
        const nextDue = input.nextDeadlineMs(snapshot)
        const wait =
          nextDue === undefined
            ? latch.await
            : Effect.race(
                latch.await,
                Effect.sleep(Duration.millis(Math.max(0, nextDue - nowMs))),
              )
        yield* wait
        yield* latch.close
      })

      return yield* Effect.forever(step).pipe(
        Effect.tapErrorCause((cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.void
            : Effect.logError("firegrid subscriber loop failed", cause),
        ),
      )
    }),
  )
