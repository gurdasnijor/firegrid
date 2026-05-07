import { createStateSchema, createStreamDB } from "@durable-streams/state"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Queue,
  Schema,
} from "effect"

// ============================================================================
// Schemas
// ============================================================================
//
// Two row types in the log:
//
//   1. `firegrid.clock.tick`   — durable wall-clock advancement.
//                                 The latest tick row defines `nowMs` after
//                                 replay. This makes the clock fully durable;
//                                 nothing about "what time is it" lives in
//                                 process memory.
//
//   2. `firegrid.clock.wakeup` — a scheduled wakeup with a terminal status
//                                 transition CRDT. Status precedence on
//                                 replay: dispatched > cancelled > pending.
//                                 Two concurrent writers cannot corrupt each
//                                 other.
//
// Both are append-only; we never mutate-in-place on the durable side. The
// in-memory collection projection is what gets mutated, and the log is the
// source of truth.

const ClockTickRowType = "firegrid.clock.tick" as const
const ClockWakeupRowType = "firegrid.clock.wakeup" as const

const WakeupStatusSchema = Schema.Literal("pending", "dispatched", "cancelled")
export type DurableClockWakeupStatus = Schema.Schema.Type<
  typeof WakeupStatusSchema
>

const DurableClockTickRecordSchema = Schema.Struct({
  scope: Schema.String,
  nowMs: Schema.Number,
  appendedAtMs: Schema.Number,
})
export type DurableClockTickRecord = Schema.Schema.Type<
  typeof DurableClockTickRecordSchema
>

const DurableClockWakeupRecordSchema = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  deadlineMs: Schema.Number,
  appendedAtMs: Schema.Number,
  status: WakeupStatusSchema,
})
export type DurableClockWakeupRecord = Schema.Schema.Type<
  typeof DurableClockWakeupRecordSchema
>

const clockState = createStateSchema({
  ticks: {
    type: ClockTickRowType,
    primaryKey: "scope",
    schema: Schema.standardSchemaV1(DurableClockTickRecordSchema),
  },
  wakeups: {
    type: ClockWakeupRowType,
    primaryKey: "id",
    schema: Schema.standardSchemaV1(DurableClockWakeupRecordSchema),
  },
})

// Status precedence for terminal-state CRDT. A `dispatched` write always wins
// over a `cancelled` write regardless of arrival order, because once a sleep
// has been observed-as-completed by the runtime, treating it as cancelled
// would be a correctness violation.
const STATUS_RANK: Record<DurableClockWakeupStatus, number> = {
  pending: 0,
  cancelled: 1,
  dispatched: 2,
}

const mergeStatus = (
  a: DurableClockWakeupStatus,
  b: DurableClockWakeupStatus,
): DurableClockWakeupStatus => (STATUS_RANK[a] >= STATUS_RANK[b] ? a : b)

// ============================================================================
// Errors
// ============================================================================

export class DurableClockStoreError extends Schema.TaggedError<DurableClockStoreError>()(
  "DurableClockStoreError",
  {
    op: Schema.String,
    cause: Schema.Defect,
  },
) {}

// ============================================================================
// Store
// ============================================================================

export interface DurableClockAppendWakeupArgs {
  readonly id: string
  readonly scope: string
  readonly deadlineMs: number
  readonly appendedAtMs: number
}

/**
 * Persistent state for a durable clock. Every operation is idempotent under
 * replay: re-applying a status transition that already reached a terminal
 * state is a no-op (the merge function discards lower-rank writes).
 *
 * Reads (`latestTick`, `snapshot`) project from a local materialized view
 * of the durable log and are therefore infallible — they only require that
 * the store has finished its initial preload, which the constructor
 * enforces.
 */
export interface DurableClockStore {
  readonly putTick: (
    record: DurableClockTickRecord,
  ) => Effect.Effect<void, DurableClockStoreError>
  readonly latestTick: (
    scope: string,
  ) => Effect.Effect<DurableClockTickRecord | undefined>
  readonly appendWakeup: (
    args: DurableClockAppendWakeupArgs,
  ) => Effect.Effect<DurableClockWakeupRecord, DurableClockStoreError>
  readonly setStatus: (
    id: string,
    status: DurableClockWakeupStatus,
  ) => Effect.Effect<void, DurableClockStoreError>
  readonly snapshot: (
    scope: string,
  ) => Effect.Effect<ReadonlyArray<DurableClockWakeupRecord>>
  /**
   * Subscribe to wakeup-collection changes. The callback fires after each
   * committed batch, allowing the dispatcher to react to external writes
   * (e.g. wakeups appended by a sibling process sharing the stream).
   * Returns an unsubscribe handle.
   */
  readonly onChange: (handler: () => void) => () => void
  readonly close: Effect.Effect<void>
}

// ----------------------------------------------------------------------------
// In-memory store (for tests / TestClock-style use)
// ----------------------------------------------------------------------------

export const makeInMemoryDurableClockStore = (
  seed: {
    readonly ticks?: ReadonlyArray<DurableClockTickRecord>
    readonly wakeups?: ReadonlyArray<DurableClockWakeupRecord>
  } = {},
): DurableClockStore => {
  const ticks = new Map<string, DurableClockTickRecord>()
  for (const tick of seed.ticks ?? []) ticks.set(tick.scope, tick)

  const wakeups = new Map<string, DurableClockWakeupRecord>()
  for (const w of seed.wakeups ?? []) wakeups.set(w.id, w)

  const subscribers = new Set<() => void>()
  const notify = () => {
    for (const s of subscribers) s()
  }

  return {
    putTick: (record) =>
      Effect.sync(() => {
        const existing = ticks.get(record.scope)
        // Monotonic merge: never let `nowMs` go backwards.
        if (existing === undefined || record.nowMs > existing.nowMs) {
          ticks.set(record.scope, record)
        }
      }),
    latestTick: (scope) => Effect.sync(() => ticks.get(scope)),
    appendWakeup: (args) =>
      Effect.sync(() => {
        const record: DurableClockWakeupRecord = {
          ...args,
          status: "pending",
        }
        // Idempotent on id collision (e.g. caller retried with same UUID).
        const existing = wakeups.get(args.id)
        if (existing === undefined) wakeups.set(args.id, record)
        notify()
        return existing ?? record
      }),
    setStatus: (id, status) =>
      Effect.sync(() => {
        const existing = wakeups.get(id)
        if (existing === undefined) return
        const merged = mergeStatus(existing.status, status)
        if (merged !== existing.status) {
          wakeups.set(id, { ...existing, status: merged })
          notify()
        }
      }),
    snapshot: (scope) =>
      Effect.sync(() =>
        Array.from(wakeups.values()).filter((w) => w.scope === scope),
      ),
    onChange: (handler) => {
      subscribers.add(handler)
      return () => {
        subscribers.delete(handler)
      }
    },
    close: Effect.void,
  }
}

// ----------------------------------------------------------------------------
// Stream-backed store
// ----------------------------------------------------------------------------

export interface DurableStreamClockStoreConfig {
  readonly streamUrl: string
  readonly contentType?: string
  readonly awaitTxIdTimeoutMs?: number
}

export const makeDurableStreamClockStore = (
  config: DurableStreamClockStoreConfig,
): Effect.Effect<DurableClockStore, DurableClockStoreError> =>
  Effect.gen(function* () {
    const db = createStreamDB({
      streamOptions: {
        url: config.streamUrl,
        contentType: config.contentType ?? "application/json",
      },
      state: clockState,
      // The optimistic action contract from stream-db is:
      //   onMutate    — synchronous local-collection mutation (always wins
      //                 the UI race; reconciled when the durable write echoes
      //                 back through the log).
      //   mutationFn  — the durable side: append to the log, then await the
      //                 txid round-trip so the caller observes a consistent
      //                 in-memory state on resolution.
      //
      // Because `onMutate` is synchronous and runs in the local collection,
      // the dispatcher can read collection state immediately after `await
      // transaction.isPersisted.promise` and trust it.
      actions: ({ db, stream }) => ({
        putTick: {
          onMutate: (record: DurableClockTickRecord) => {
            const existing = db.collections.ticks.get(record.scope)
            if (existing === undefined) {
              db.collections.ticks.insert(record)
            } else if (record.nowMs > existing.nowMs) {
              db.collections.ticks.update(record.scope, (draft) => {
                draft.nowMs = record.nowMs
                draft.appendedAtMs = record.appendedAtMs
              })
            }
          },
          mutationFn: async (record: DurableClockTickRecord) => {
            const existing = db.collections.ticks.get(record.scope)
            // Skip durable write if the local view already has a newer tick;
            // this happens during replay-after-restart when our seed value
            // is older than what the log already contains.
            if (existing !== undefined && existing.nowMs >= record.nowMs) {
              return
            }
            const txid = globalThis.crypto.randomUUID()
            await stream.append(
              JSON.stringify(
                clockState.ticks.upsert({
                  value: record,
                  headers: { txid },
                }),
              ),
            )
            await db.utils.awaitTxId(txid, config.awaitTxIdTimeoutMs)
          },
        },
        appendWakeup: {
          onMutate: (record: DurableClockWakeupRecord) => {
            // Idempotent on wakeup id (UUID minted by the caller). Calling
            // `insert` twice with the same key would throw, so we branch.
            if (db.collections.wakeups.get(record.id) === undefined) {
              db.collections.wakeups.insert(record)
            }
          },
          mutationFn: async (record: DurableClockWakeupRecord) => {
            const txid = globalThis.crypto.randomUUID()
            await stream.append(
              JSON.stringify(
                clockState.wakeups.upsert({
                  value: record,
                  headers: { txid },
                }),
              ),
            )
            await db.utils.awaitTxId(txid, config.awaitTxIdTimeoutMs)
          },
        },
        setWakeupStatus: {
          onMutate: (params: {
            readonly id: string
            readonly status: DurableClockWakeupStatus
          }) => {
            const current = db.collections.wakeups.get(params.id)
            if (current === undefined) return
            const merged = mergeStatus(current.status, params.status)
            if (merged === current.status) return
            db.collections.wakeups.update(params.id, (draft) => {
              draft.status = merged
            })
          },
          mutationFn: async (params: {
            readonly id: string
            readonly status: DurableClockWakeupStatus
          }) => {
            const current = db.collections.wakeups.get(params.id)
            if (current === undefined) return
            const merged = mergeStatus(current.status, params.status)
            if (merged === current.status) return
            const txid = globalThis.crypto.randomUUID()
            await stream.append(
              JSON.stringify(
                clockState.wakeups.upsert({
                  value: { ...current, status: merged },
                  headers: { txid },
                }),
              ),
            )
            await db.utils.awaitTxId(txid, config.awaitTxIdTimeoutMs)
          },
        },
      }),
    })

    yield* Effect.tryPromise({
      try: () => db.preload(),
      catch: (cause) =>
        new DurableClockStoreError({ op: "preload", cause }),
    })

    const subscribers = new Set<() => void>()
    // Subscribe once to the wakeups collection; fan out to dispatcher
    // subscribers. This makes the store reactive to external writers sharing
    // the same durable log.
    const collectionSubscription = db.collections.wakeups.subscribeChanges(
      () => {
        for (const s of subscribers) {
          try {
            s()
          } catch {
            // Subscribers must not throw past the store boundary.
          }
        }
      },
    )

    return {
      putTick: (record) =>
        Effect.tryPromise({
          try: async () => {
            await db.actions.putTick(record).isPersisted.promise
          },
          catch: (cause) =>
            new DurableClockStoreError({ op: "putTick", cause }),
        }),
      latestTick: (scope) =>
        Effect.sync(() => db.collections.ticks.get(scope)),
      appendWakeup: (args) => {
        const record: DurableClockWakeupRecord = { ...args, status: "pending" }
        return Effect.tryPromise({
          try: async () => {
            await db.actions.appendWakeup(record).isPersisted.promise
            return db.collections.wakeups.get(record.id) ?? record
          },
          catch: (cause) =>
            new DurableClockStoreError({ op: "appendWakeup", cause }),
        })
      },
      setStatus: (id, status) =>
        Effect.tryPromise({
          try: async () => {
            await db.actions.setWakeupStatus({ id, status }).isPersisted
              .promise
          },
          catch: (cause) =>
            new DurableClockStoreError({ op: "setStatus", cause }),
        }),
      snapshot: (scope) =>
        Effect.sync(() =>
          Array.from(db.collections.wakeups.state.values()).filter(
            (w) => w.scope === scope,
          ),
        ),
      onChange: (handler) => {
        subscribers.add(handler)
        return () => {
          subscribers.delete(handler)
        }
      },
      close: Effect.sync(() => {
        collectionSubscription.unsubscribe()
        subscribers.clear()
        db.close()
      }),
    }
  })

// ============================================================================
// Dispatcher
// ============================================================================

export interface DurableClockDispatcher {
  readonly nowMs: Effect.Effect<number>
  /** The Effect Clock backed by this dispatcher. Pass to `Layer.setClock`. */
  readonly clock: Clock.Clock
  /** Advance durable wall-clock by deltaMs, persist, and fire any due wakeups. */
  readonly advance: (
    deltaMs: number,
  ) => Effect.Effect<
    ReadonlyArray<DurableClockWakeupRecord>,
    DurableClockStoreError
  >
  /** Re-evaluate at current `nowMs` (no time advancement). */
  readonly tick: Effect.Effect<
    ReadonlyArray<DurableClockWakeupRecord>,
    DurableClockStoreError
  >
}

// Service tag so callers inside Effect computations can grab the dispatcher
// (e.g. to call `advance` from a test) without threading it through closures.
export class DurableClock extends Context.Tag("firegrid/DurableClock")<
  DurableClock,
  DurableClockDispatcher
>() {}

export interface DurableClockConfig {
  readonly store: DurableClockStore
  readonly scope: string
  /**
   * Time to use if the log has no prior tick for this scope. Subsequent
   * boots ignore this and use the durable value.
   */
  readonly initialDurableTimeMs: number
}

/**
 * Layer-as-deployable-unit: construct the dispatcher, install it as the
 * Effect Clock, and expose it as a service. Uses `Layer.scoped` so that
 * shutdown is wired to the surrounding scope — when the layer's scope
 * closes, every outstanding sleep is interrupted and the change subscription
 * is torn down.
 */
export const layer = (
  config: DurableClockConfig,
): Layer.Layer<DurableClock, DurableClockStoreError> =>
  Layer.scoped(
    DurableClock,
    Effect.gen(function* () {
      const { store, scope } = config

      // ---- recover durable time from the log -------------------------------
      const persisted = yield* store.latestTick(scope)
      let nowMs = persisted?.nowMs ?? config.initialDurableTimeMs

      // If we're starting fresh (no tick row yet), seed one so subsequent
      // boots have a durable anchor. This is the only place we accept the
      // `initialDurableTimeMs` argument as authoritative.
      if (persisted === undefined) {
        yield* store.putTick({
          scope,
          nowMs,
          appendedAtMs: nowMs,
        })
      }

      // ---- in-memory live wakeups -----------------------------------------
      //
      // `live` is keyed by wakeup id (UUID) and holds the Deferred that the
      // sleeping fiber is parked on. The map is *re-derivable* from the log:
      // if a wakeup record exists with status=pending and we have no live
      // entry for it, we just don't have a fiber waiting on it locally
      // (perhaps it was scheduled by another process). Dispatch still marks
      // it dispatched durably; the absent local fiber is a no-op.
      const live = new Map<string, Deferred.Deferred<void>>()

      // ---- core dispatch loop ---------------------------------------------
      //
      // Idempotent: safe to call repeatedly. Reads a snapshot, picks every
      // pending record whose deadline ≤ nowMs, and transitions each to
      // dispatched in deadline order. Local deferreds are resolved inside
      // the same effect *after* the durable transition succeeds — so a
      // crash between durable-dispatch and local-wakeup just means the
      // sleep observes "already dispatched" on next replay.
      const fireDue: Effect.Effect<
        ReadonlyArray<DurableClockWakeupRecord>,
        DurableClockStoreError
      > = Effect.gen(function* () {
        const all = yield* store.snapshot(scope)
        const due = all
          .filter((r) => r.status === "pending" && r.deadlineMs <= nowMs)
          .sort((a, b) => a.deadlineMs - b.deadlineMs)

        return yield* Effect.forEach(
          due,
          (record) =>
            Effect.gen(function* () {
              yield* store.setStatus(record.id, "dispatched")
              const deferred = live.get(record.id)
              if (deferred !== undefined) {
                live.delete(record.id)
                yield* Deferred.succeed(deferred, void 0)
              }
              return { ...record, status: "dispatched" as const }
            }),
          { discard: false },
        )
      })

      // ---- reactive: respond to external appends --------------------------
      //
      // A bounded sliding queue acts as a "dirty bit" with backpressure:
      // every store change enqueues a unit, the drain fiber consumes one and
      // re-runs `fireDue`. Sliding(1) collapses bursts so we don't queue up
      // redundant fires. Errors during react are logged, never thrown — a
      // transient store hiccup must not kill the dispatcher fiber.
      const reactQueue = yield* Queue.sliding<void>(1)

      const unsubscribe = store.onChange(() => {
        // unsafeOffer is fire-and-forget and lock-free; safe from anywhere.
        Queue.unsafeOffer(reactQueue, void 0)
      })

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Queue.take(reactQueue)
            yield* fireDue.pipe(
              Effect.catchAll((e) =>
                Effect.logWarning("durable-clock react failed").pipe(
                  Effect.annotateLogs({ cause: String(e.cause) }),
                ),
              ),
            )
          }),
        ),
      )

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe()
          // Snapshot and clear `live` *before* interrupting so that each
          // sleeping fiber's onInterrupt sees `live.delete(id) === false`
          // and skips the now-pointless setStatus(cancelled) round-trip.
          // (The store may already be closing.)
          const stragglers = Array.from(live.values())
          live.clear()
          for (const deferred of stragglers) {
            Effect.runSync(Deferred.interrupt(deferred))
          }
        }),
      )

      // ---- sleep ---------------------------------------------------------
      const sleep = (duration: Duration.Duration): Effect.Effect<void> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const deltaMs = Duration.toMillis(duration)
            const id = globalThis.crypto.randomUUID()
            const deadlineMs = nowMs + deltaMs

            // Fast path: already due. Append the wakeup as already-dispatched
            // (so the durable record exists for audit) and return without
            // ever creating a Deferred.
            if (deltaMs <= 0) {
              yield* store
                .appendWakeup({ id, scope, deadlineMs, appendedAtMs: nowMs })
                .pipe(Effect.orDie)
              yield* store.setStatus(id, "dispatched").pipe(Effect.orDie)
              return
            }

            // Register the local waiter *before* the durable append. This
            // closes the race where `fireDue` runs between append and
            // registration: if the dispatcher transitions the record to
            // dispatched before we register, our subsequent check below
            // observes the terminal status and we skip the await entirely.
            const deferred = yield* Deferred.make<void>()
            live.set(id, deferred)

            yield* store
              .appendWakeup({ id, scope, deadlineMs, appendedAtMs: nowMs })
              .pipe(Effect.orDie)

            // Re-read after the append: another fiber (or this dispatcher
            // reacting to our own onChange) might have already advanced it
            // past pending.
            const records = yield* store.snapshot(scope)
            const current = records.find((r) => r.id === id)
            if (current !== undefined && current.status !== "pending") {
              live.delete(id)
              return
            }

            yield* restore(Deferred.await(deferred)).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  // Only attempt cancel if we still own the live entry. If
                  // `fireDue` already removed it, the durable record is in
                  // a terminal state and `setStatus(cancelled)` would be
                  // merged-out by the CRDT anyway — we skip the round-trip
                  // when we can.
                  const stillLive = live.delete(id)
                  if (stillLive) {
                    yield* store.setStatus(id, "cancelled").pipe(Effect.orDie)
                  }
                }),
              ),
            )
          }),
        )

      // ---- Effect Clock implementation ------------------------------------
      const clock: Clock.Clock = {
        [Clock.ClockTypeId]: Clock.ClockTypeId,
        unsafeCurrentTimeMillis: () => nowMs,
        unsafeCurrentTimeNanos: () =>
          BigInt(Math.floor(nowMs)) * 1_000_000n,
        currentTimeMillis: Effect.sync(() => nowMs),
        currentTimeNanos: Effect.sync(
          () => BigInt(Math.floor(nowMs)) * 1_000_000n,
        ),
        sleep,
      }

      const dispatcher: DurableClockDispatcher = {
        nowMs: Effect.sync(() => nowMs),
        clock,
        advance: (deltaMs) =>
          Effect.gen(function* () {
            if (deltaMs <= 0) return yield* fireDue
            nowMs += deltaMs
            yield* store.putTick({ scope, nowMs, appendedAtMs: nowMs })
            return yield* fireDue
          }),
        tick: fireDue,
      }

      // Recovery: on boot, fire anything that was already due against the
      // recovered `nowMs`. This handles the case where the process crashed
      // after `advance` persisted a tick but before its `fireDue` completed.
      yield* fireDue.pipe(
        Effect.catchAll((e) =>
          Effect.logWarning("durable-clock recovery fireDue failed").pipe(
            Effect.annotateLogs({ cause: String(e.cause) }),
          ),
        ),
      )

      return dispatcher
    }),
  )

/**
 * Layer that installs the durable clock as the Effect Clock for everything
 * downstream. Use this when you want `Effect.sleep` calls in your
 * application to be durable.
 *
 *   const program = pipe(
 *     Effect.sleep("5 seconds"),  // durable!
 *     Effect.provide(clockLayer({ store, scope: "my-app", initialDurableTimeMs: 0 })),
 *   )
 */
export const clockLayer = (
  config: DurableClockConfig,
): Layer.Layer<DurableClock, DurableClockStoreError> => {
  const base = layer(config)
  const installClock = Layer.unwrapEffect(
    Effect.map(DurableClock, (dispatcher) => Layer.setClock(dispatcher.clock)),
  )
  return Layer.provideMerge(installClock, base)
}
