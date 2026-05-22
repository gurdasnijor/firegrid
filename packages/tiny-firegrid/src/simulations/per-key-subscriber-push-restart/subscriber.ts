import { Deferred, type Duration, Effect, Option, Ref, type Scope, Stream } from "effect"
import {
  eventKeyFor,
  initialState,
  now,
  type PerKeyTableService,
  type StateRow,
} from "./resources.ts"

// The three subscriber-runtime shapes under test. The ONLY structural
// difference between them is how an emitted tail row is dispatched to the keyed
// handler. The substrate (events.rows()) is identical in all three.
export type SubscriberMode =
  // Single consumer fiber, Stream.runForEach. Globally serial: per-key
  // serialization holds trivially (one fiber ever), but there is ZERO cross-key
  // concurrency — every context is processed behind every other. Native to the
  // substrate; production-fatal for many concurrent sessions.
  | "global-serial"
  // Fork-per-row, NO per-key mutex. Maximally concurrent. Demonstrates that the
  // substrate push stream does NOT serialize per key on its own: two rows for
  // the same key run concurrently and double-process.
  | "unserialized-parallel"
  // Fork-per-row PLUS a per-key mutex (one Effect.Semaphore(1) per contextId).
  // This is the thin subscriber-runtime helper. Per-key serial AND cross-key
  // concurrent. Correct.
  | "per-key-router"

export interface MetricsSnapshot {
  // push: number of native tail-row emissions handled (events.rows()).
  readonly tailRowEmissions: number
  // polling guard: must stay 0. The subscriber never loops/sleeps to discover
  // rows; it only acts on a tail emission.
  readonly pollLoops: number
  // write+arm guard: must stay 0. Appending an event never signals the
  // subscriber; the substrate tail is the only wakeup.
  readonly externalArmCalls: number
  // total keyed-handler materializations (drainKey entries).
  readonly handlerInvocations: number
  // total state reloads from the durable table (== handlerInvocations; one per
  // materialization). Proves state is reconstructed from the table every time.
  readonly reloadCount: number
  // total durable state-row writes.
  readonly stateWrites: number
  // materializations that consumed ZERO new events (the cursor was already at or
  // past the frontier). After a restart, replay-then-tail re-emits every pre-crash
  // event; each re-triggers a materialization that finds nothing new and is a
  // no-op. Proves restart causes no double-process — the cursor absorbs replay.
  readonly noopMaterializations: number
  // max simultaneous handler materializations for a SINGLE key. Per-key
  // serialization holds iff this is 1.
  readonly maxInKeyConcurrency: number
  // max simultaneous distinct keys being processed. Cross-key concurrency holds
  // iff this is > 1.
  readonly maxCrossKeyConcurrency: number
}

interface MetricsState extends MetricsSnapshot {
  // live per-key active-handler counts (for the concurrency maxes).
  readonly activePerKey: Record<string, number>
  // live count of distinct keys with an active handler.
  readonly activeKeys: number
}

export interface Instrumentation {
  readonly ref: Ref.Ref<MetricsState>
}

const emptyMetricsState: MetricsState = {
  tailRowEmissions: 0,
  pollLoops: 0,
  externalArmCalls: 0,
  handlerInvocations: 0,
  reloadCount: 0,
  stateWrites: 0,
  noopMaterializations: 0,
  maxInKeyConcurrency: 0,
  maxCrossKeyConcurrency: 0,
  activePerKey: {},
  activeKeys: 0,
}

export const makeInstrumentation: Effect.Effect<Instrumentation> = Effect.gen(
  function*() {
    const ref = yield* Ref.make(emptyMetricsState)
    return { ref }
  },
)

export const resetInstrumentation = (
  instrumentation: Instrumentation,
): Effect.Effect<void> => Ref.set(instrumentation.ref, emptyMetricsState)

export const snapshotMetrics = (
  instrumentation: Instrumentation,
): Effect.Effect<MetricsSnapshot> =>
  Ref.get(instrumentation.ref).pipe(
    Effect.map((state): MetricsSnapshot => ({
      tailRowEmissions: state.tailRowEmissions,
      pollLoops: state.pollLoops,
      externalArmCalls: state.externalArmCalls,
      handlerInvocations: state.handlerInvocations,
      reloadCount: state.reloadCount,
      stateWrites: state.stateWrites,
      noopMaterializations: state.noopMaterializations,
      maxInKeyConcurrency: state.maxInKeyConcurrency,
      maxCrossKeyConcurrency: state.maxCrossKeyConcurrency,
    })),
  )

const bump = (
  instrumentation: Instrumentation,
  key: keyof MetricsSnapshot,
  by = 1,
): Effect.Effect<void> =>
  Ref.update(instrumentation.ref, state => ({
    ...state,
    [key]: state[key] + by,
  }))

// Concurrency accounting: mark a key's handler entered, recompute the in-key and
// cross-key maxima.
const enterKey = (
  instrumentation: Instrumentation,
  contextId: string,
): Effect.Effect<void> =>
  Ref.update(instrumentation.ref, state => {
    const previous = state.activePerKey[contextId] ?? 0
    const nextCount = previous + 1
    const activeKeys = previous === 0 ? state.activeKeys + 1 : state.activeKeys
    return {
      ...state,
      activePerKey: { ...state.activePerKey, [contextId]: nextCount },
      activeKeys,
      maxInKeyConcurrency: Math.max(state.maxInKeyConcurrency, nextCount),
      maxCrossKeyConcurrency: Math.max(state.maxCrossKeyConcurrency, activeKeys),
    }
  })

const exitKey = (
  instrumentation: Instrumentation,
  contextId: string,
): Effect.Effect<void> =>
  Ref.update(instrumentation.ref, state => {
    const previous = state.activePerKey[contextId] ?? 0
    const nextCount = Math.max(0, previous - 1)
    const activeKeys = nextCount === 0 ? state.activeKeys - 1 : state.activeKeys
    return {
      ...state,
      activePerKey: { ...state.activePerKey, [contextId]: nextCount },
      activeKeys,
    }
  })

const reloadState = (
  table: PerKeyTableService,
  instrumentation: Instrumentation,
  contextId: string,
): Effect.Effect<StateRow, unknown> =>
  table.state.get(contextId).pipe(
    Effect.map(Option.getOrElse(() => initialState(contextId))),
    Effect.map((state): StateRow => ({
      ...state,
      reloadCount: state.reloadCount + 1,
    })),
    Effect.tap(() => bump(instrumentation, "reloadCount")),
    Effect.withSpan("firegrid.tf4fy3.state.reload", {
      kind: "internal",
      attributes: {
        "firegrid.tf4fy3.context_id": contextId,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.4",
      },
    }),
  )

// A rendezvous barrier: handlers block inside the critical region until
// `expected` of them have arrived, then all proceed together. This makes the
// concurrency observations DETERMINISTIC rather than dependent on a sleep
// window — if `expected` handlers can be in the critical region at once, they
// provably will be (the gate only opens when the last expected arrival lands).
// The timeout is a safety valve so a mode that serializes MORE than `expected`
// (e.g. the per-key mutex admitting only one) never deadlocks; it is never
// relied upon for the positive (overlap-observed) result.
export interface Rendezvous {
  readonly arrive: Effect.Effect<void>
}

export const makeRendezvous = (
  expected: number,
  timeout: Duration.DurationInput = "2 seconds",
): Effect.Effect<Rendezvous> =>
  Effect.gen(function*() {
    const count = yield* Ref.make(0)
    const gate = yield* Deferred.make<void>()
    return {
      arrive: Effect.gen(function*() {
        const arrived = yield* Ref.updateAndGet(count, current => current + 1)
        if (arrived >= expected) yield* Deferred.succeed(gate, undefined)
        yield* Deferred.await(gate).pipe(Effect.timeout(timeout), Effect.ignore)
      }),
    }
  })

const noRendezvous: Rendezvous = { arrive: Effect.void }

// The keyed per-event subscriber. It materializes for a key, reloads the durable
// state row, point-reads forward from the cursor applying the transition
// function to each fact, writes the next state, and returns. There is no
// long-lived body: between events the entity is the durable `state` row.
//
// An optional rendezvous inside the critical region makes a same-key (or
// cross-key) overlap deterministically observable, so a missing/ present per-key
// mutex shows up as maxInKeyConcurrency 2 vs 1 with no reliance on scheduler
// timing.
const drainKey = (
  table: PerKeyTableService,
  instrumentation: Instrumentation,
  rendezvous: Rendezvous,
  contextId: string,
): Effect.Effect<void, unknown> =>
  Effect.acquireUseRelease(
    enterKey(instrumentation, contextId).pipe(
      Effect.zipRight(bump(instrumentation, "handlerInvocations")),
    ),
    () =>
      Effect.gen(function*() {
        let state = yield* reloadState(table, instrumentation, contextId)
        // Block until the expected number of concurrent materializations have
        // entered the critical region (or the safety timeout fires). This is
        // where a serialization failure becomes observable: if the substrate
        // admits two same-key handlers, both reach here before either exits.
        yield* rendezvous.arrive
        let consumed = 0
        while (true) {
          const sequence = state.lastProcessedSequence + 1
          const next = yield* table.events.get(eventKeyFor(contextId, sequence))
          if (Option.isNone(next)) break
          consumed = consumed + 1
          state = {
            ...state,
            lastProcessedSequence: sequence,
            fold: state.fold + next.value.value,
            consumedSequences: [...state.consumedSequences, sequence],
          }
        }
        yield* table.state.upsert({ ...state, updatedAt: now() })
        yield* bump(instrumentation, "stateWrites")
        if (consumed === 0) yield* bump(instrumentation, "noopMaterializations")
        yield* Effect.annotateCurrentSpan({
          "firegrid.tf4fy3.context_id": contextId,
          "firegrid.tf4fy3.cursor": state.lastProcessedSequence,
          "firegrid.tf4fy3.fold": state.fold,
          "firegrid.tf4fy3.reload_count": state.reloadCount,
        })
      }),
    () => exitKey(instrumentation, contextId),
  ).pipe(
    Effect.withSpan("firegrid.tf4fy3.subscriber.drain_key", {
      kind: "internal",
      attributes: {
        "firegrid.workflow.name": "TinyPerKeySubscriber",
        "firegrid.tf4fy3.context_id": contextId,
        "firegrid-workflow-driven-runtime.ACID":
          "PHASE_0_TARGET_REFERENCE.4",
      },
    }),
  )

// A per-key mutex registry: one Effect.Semaphore(1) per contextId, created on
// first sight. THIS is the entire "thin subscriber-runtime helper" that the B
// verdict names. Everything else is substrate-native.
interface PerKeyMutex {
  readonly withKey: <A, E, R>(
    contextId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

const makePerKeyMutex: Effect.Effect<PerKeyMutex> = Effect.gen(function*() {
  const registry = yield* Ref.make<Record<string, Effect.Semaphore>>({})
  const semaphoreFor = (contextId: string): Effect.Effect<Effect.Semaphore> =>
    Effect.gen(function*() {
      const existing = (yield* Ref.get(registry))[contextId]
      if (existing !== undefined) return existing
      const created = yield* Effect.makeSemaphore(1)
      yield* Ref.update(registry, current =>
        current[contextId] !== undefined
          ? current
          : { ...current, [contextId]: created })
      return (yield* Ref.get(registry))[contextId]!
    })
  return {
    withKey: (contextId, effect) =>
      semaphoreFor(contextId).pipe(
        Effect.flatMap(semaphore => semaphore.withPermits(1)(effect)),
      ),
  }
})

// Run a subscriber generation. Tails events.rows() (replay-then-tail: it sees
// the rows already in the durable log AND every future append), filters to the
// keys this generation owns, and dispatches per mode. This effect never returns
// on its own — it is forked into the generation scope, and scope close = crash.
export const runSubscriber = (
  table: PerKeyTableService,
  instrumentation: Instrumentation,
  mode: SubscriberMode,
  ownsContext: (contextId: string) => boolean,
  rendezvous: Rendezvous = noRendezvous,
): Effect.Effect<void, unknown, Scope.Scope> =>
  Effect.gen(function*() {
    const mutex = yield* makePerKeyMutex
    const owned = table.events.rows().pipe(
      Stream.filter(row => ownsContext(row.contextId)),
      Stream.tap(() => bump(instrumentation, "tailRowEmissions")),
    )
    switch (mode) {
      case "global-serial":
        return yield* owned.pipe(
          Stream.runForEach(row =>
            drainKey(table, instrumentation, rendezvous, row.contextId)),
        )
      case "unserialized-parallel":
        return yield* owned.pipe(
          Stream.runForEach(row =>
            drainKey(table, instrumentation, rendezvous, row.contextId).pipe(
              Effect.forkScoped,
              Effect.asVoid,
            )),
        )
      case "per-key-router":
        return yield* owned.pipe(
          Stream.runForEach(row =>
            mutex.withKey(
              row.contextId,
              drainKey(table, instrumentation, rendezvous, row.contextId),
            ).pipe(Effect.forkScoped, Effect.asVoid)),
        )
    }
  }).pipe(
    Effect.withSpan("firegrid.tf4fy3.subscriber.run", {
      kind: "internal",
      attributes: {
        "firegrid.tf4fy3.mode": mode,
        "firegrid-workflow-driven-runtime.ACID":
          "BOUNDARIES.7-1,PHASE_0_TARGET_REFERENCE.4",
      },
    }),
  )
