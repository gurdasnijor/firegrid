import {
  deriveReadyWork,
  openSubstrateDb,
  processReadyWorkItem,
  rebuildProjection,
  runProjectionMatchSubscriber,
  runScheduledWorkSubscriber,
  runTimerSubscriber,
  snapshotFromDb,
  type CompletionValue,
  type ProjectionMatchEvaluation,
  type ProjectionMatchTrigger,
  type ProjectionSnapshot,
  type ReadyWorkItem,
  type SubscriberError,
} from "@durable-agent-substrate/substrate"
import { Cause, Clock, Duration, Effect, Layer } from "effect"
import {
  HostProgramRuntime,
  type HostProgramRuntimeService,
} from "./host-program-runtime.ts"

// launchable-substrate-host.HOST_PROCESS.2
// launchable-substrate-host.HOST_PROCESS.4
// launchable-substrate-host.HOST_PROCESS.5
// launchable-substrate-host.RUNTIME_COMPOSITION.2
// launchable-substrate-host.RUNTIME_COMPOSITION.3
// launchable-substrate-host.SERVER_RUNTIME_API.1
// launchable-substrate-host.SERVER_RUNTIME_API.2
// launchable-substrate-host.SERVER_RUNTIME_API.3
//
// HostPrograms — Layer constructors for host-managed runtime
// programs. Each helper returns a `Layer.scopedDiscard`-shaped layer
// (services-output `never`); long-running runner fibers are forked
// into the surrounding scope and torn down by Effect finalization.
// Helpers depend only on the narrow HostProgramRuntime service the
// host injects at launch time — NOT on the broader SubstrateHost
// service. Diagnostics/liveness are deferred hardening concerns and
// are not part of this graph contract.

const acquireDb = (cfg: HostProgramRuntimeService) =>
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

type CollectionsDb = ReturnType<typeof openSubstrateDb>

// Generic scoped runner skeleton shared by the helpers. Holds a
// long-lived StreamDB only for two host-local responsibilities —
// subscription-edge wakes via subscribeChanges and next-deadline
// observation via snapshotFromDb — and re-invokes the supplied
// `scan` Effect on each wake. Coalescing semantics:
// an in-flight scan plus concurrent wakes collapses into exactly
// one follow-up scan. There is no fixed-cadence polling.
const runScopedProgram = (input: {
  readonly cfg: HostProgramRuntimeService
  readonly subscribe: (db: CollectionsDb, onEdge: () => void) => () => void
  readonly nextDeadlineMs: (snapshot: ProjectionSnapshot) => number | undefined
  readonly scan: Effect.Effect<unknown, unknown>
}): Effect.Effect<void, never, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const latch = yield* Effect.makeLatch(false)

      const dbResult = yield* Effect.either(acquireDb(input.cfg))
      if (dbResult._tag === "Left") return
      const db = dbResult.right

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

const subscribeCompletions = (
  db: CollectionsDb,
  onEdge: () => void,
): (() => void) => {
  const sub = db.collections.completions.subscribeChanges(onEdge)
  return () => sub.unsubscribe()
}

const subscribeAllCollections = (
  db: CollectionsDb,
  onEdge: () => void,
): (() => void) => {
  const subs = [
    db.collections.runs.subscribeChanges(onEdge),
    db.collections.completions.subscribeChanges(onEdge),
    db.collections.claimAttempts.subscribeChanges(onEdge),
  ]
  return () => subs.forEach((s) => s.unsubscribe())
}

const minPendingDueAtMs = (
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

// HostPrograms.timerSubscriber — graph-driven equivalent of the
// Slice 5 boolean. Reuses substrate's runTimerSubscriber as the
// single-shot scan primitive; substrate is left untouched.
const timerSubscriber = (): Layer.Layer<never, never, HostProgramRuntime> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const cfg = yield* HostProgramRuntime
      yield* Effect.forkScoped(
        runScopedProgram({
          cfg,
          subscribe: subscribeCompletions,
          nextDeadlineMs: (snapshot) =>
            minPendingDueAtMs(snapshot.completions, (c) => {
              if (c.kind !== "timer") return undefined
              const data = c.data as { readonly dueAtMs?: unknown } | undefined
              return data !== undefined && typeof data.dueAtMs === "number"
                ? data.dueAtMs
                : undefined
            }),
          scan: runTimerSubscriber({
            streamUrl: cfg.streamUrl,
            contentType: cfg.contentType,
          }),
        }),
      )
    }),
  )

const scheduledWorkSubscriber = (): Layer.Layer<
  never,
  never,
  HostProgramRuntime
> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const cfg = yield* HostProgramRuntime
      yield* Effect.forkScoped(
        runScopedProgram({
          cfg,
          subscribe: subscribeCompletions,
          nextDeadlineMs: (snapshot) =>
            minPendingDueAtMs(snapshot.completions, (c) => {
              if (c.kind !== "scheduled_work") return undefined
              const data = c.data as { readonly whenMs?: unknown } | undefined
              return data !== undefined && typeof data.whenMs === "number"
                ? data.whenMs
                : undefined
            }),
          scan: runScheduledWorkSubscriber({
            streamUrl: cfg.streamUrl,
            contentType: cfg.contentType,
          }),
        }),
      )
    }),
  )

// Caller-facing evaluator type with full Effect requirement / error
// channels. The helper provides the resolved runtime to the
// substrate's evaluator slot via Effect.runtime so adapter / provider
// layers compose through Layer.provide normally.
export type GraphProjectionMatchEvaluator<E, R> = (
  snapshot: ProjectionSnapshot,
  trigger: ProjectionMatchTrigger,
  completion: CompletionValue,
) => Effect.Effect<ProjectionMatchEvaluation, E, R>

// HostPrograms.projectionMatchSubscriber — graph-driven projection-
// match runner. Caller supplies an evaluator closed over the caller-
// owned event-plane definition; substrate's
// runProjectionMatchSubscriber is the single-shot catch-up /
// terminalization primitive. Substrate is not modified.
const projectionMatchSubscriber = <E, R>(input: {
  readonly evaluate: GraphProjectionMatchEvaluator<E, R>
}): Layer.Layer<never, never, HostProgramRuntime | R> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const cfg = yield* HostProgramRuntime
      const runtime = yield* Effect.runtime<R>()
      const substrateEvaluator = (
        snapshot: ProjectionSnapshot,
        trigger: ProjectionMatchTrigger,
        completion: CompletionValue,
      ): Effect.Effect<ProjectionMatchEvaluation, unknown> =>
        input
          .evaluate(snapshot, trigger, completion)
          .pipe(Effect.provide(runtime))
      yield* Effect.forkScoped(
        runScopedProgram({
          cfg,
          subscribe: subscribeCompletions,
          nextDeadlineMs: (snapshot) =>
            minPendingDueAtMs(snapshot.completions, (c) => {
              if (c.kind !== "projection_match") return undefined
              const data = c.data as
                | { readonly deadlineAtMs?: unknown }
                | undefined
              return data !== undefined &&
                typeof data.deadlineAtMs === "number"
                ? data.deadlineAtMs
                : undefined
            }),
          scan: runProjectionMatchSubscriber({
            streamUrl: cfg.streamUrl,
            contentType: cfg.contentType,
            evaluate: substrateEvaluator,
          }),
        }),
      )
    }),
  )

// HostPrograms.operator — claim-before-side-effect operator runner
// over the ready-work projection. Wraps substrate's
// processReadyWorkItem as the single-shot claim+terminalize primitive;
// substrate is not modified. Handler's residual `R` stays in the
// layer's RIn so adapter / provider layers compose via Layer.provide.
//
// `select` is an optional filter so multiple operator helpers can
// coexist without all racing every ready-work item. Items are
// processed sequentially per scan; claim authority tolerates
// concurrent hosts so per-scan concurrency is a host-local choice
// rather than authority.
const operator = <E, R>(input: {
  readonly name: string
  readonly handler: (item: ReadyWorkItem) => Effect.Effect<unknown, E, R>
  readonly select?: (item: ReadyWorkItem) => boolean
}): Layer.Layer<never, never, HostProgramRuntime | R> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const cfg = yield* HostProgramRuntime
      const ownerId = `${cfg.processId}:operator:${input.name}`
      const select = input.select ?? (() => true)
      const runtime = yield* Effect.runtime<R>()

      const scanOnce = Effect.tryPromise({
        try: () =>
          rebuildProjection({
            url: cfg.streamUrl,
            contentType: cfg.contentType,
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.flatMap((snap) => {
          const ready = deriveReadyWork(snap)
          const items: Array<ReadyWorkItem> = []
          for (const item of ready.readyWork.values()) {
            if (select(item)) items.push(item)
          }
          return Effect.forEach(
            items,
            (item) =>
              processReadyWorkItem({
                streamUrl: cfg.streamUrl,
                contentType: cfg.contentType,
                ownerId,
                item,
                handler: (i) => input.handler(i).pipe(Effect.provide(runtime)),
              }).pipe(Effect.either),
            { discard: true },
          )
        }),
        Effect.catchAll(() => Effect.void),
      )

      yield* Effect.forkScoped(
        runScopedProgram({
          cfg,
          subscribe: subscribeAllCollections,
          // No deadline source for ready-work; scans are wholly
          // edge-driven. Parks on latch.await until a relevant
          // collection change opens it.
          nextDeadlineMs: () => undefined,
          scan: scanOnce,
        }),
      )
    }),
  )

export const HostPrograms = {
  timerSubscriber,
  scheduledWorkSubscriber,
  projectionMatchSubscriber,
  operator,
} as const
