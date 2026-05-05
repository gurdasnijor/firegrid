import {
  openSubstrateDb,
  snapshotFromDb,
  type CompletionValue,
  type ProjectionSnapshot,
} from "@durable-agent-substrate/substrate"
import { Cause, Clock, Duration, Effect } from "effect"
import { RuntimeContext, type RuntimeContextService } from "../runtime-context.ts"

// Private subscription/deadline-driven runner skeleton used by the
// public `Firegrid.subscribers.{timer, scheduledWork}` Layers.
// Necessary complexity: the substrate exposes single-shot scan
// functions; until substrate gains an edge-driven runner natively,
// the runtime owns the wake/loop scheduling. This module is NOT
// part of the public API.
//
// Coalescing semantics: an in-flight scan plus concurrent wakes
// collapses into exactly one follow-up scan. There is no fixed-
// cadence polling.
//
// Errors: scan failures and acquireDb failures used to be silently
// swallowed. They now surface through the typed error channel of
// the returned Effect so the caller-supplied scan can decide
// whether the runner should stop.

type CollectionsDb = ReturnType<typeof openSubstrateDb>

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
      catch: (cause) => cause,
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
): Effect.Effect<void, never, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const latch = yield* Effect.makeLatch(false)

      const db = yield* acquireDb(cfg).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      )
      if (db === undefined) return

      const unsubscribe = input.subscribe(db, () => latch.unsafeOpen())
      yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()))

      const loop: Effect.Effect<void, never, never> = Effect.gen(function* () {
        while (true) {
          const result = yield* Effect.either(input.scan)
          if (result._tag === "Left") return
          const snapshot = snapshotFromDb(db)
          const nowMs = yield* Clock.currentTimeMillis
          const nextDue = input.nextDeadlineMs(snapshot)
          const wakeRace =
            nextDue === undefined
              ? latch.await
              : Effect.race(
                  latch.await,
                  Effect.sleep(Duration.millis(Math.max(0, nextDue - nowMs))),
                )
          yield* wakeRace
          yield* latch.close
        }
      })

      yield* Effect.catchAllCause(loop, (cause) =>
        Cause.isInterruptedOnly(cause) ? Effect.void : Effect.void,
      )
    }),
  )
