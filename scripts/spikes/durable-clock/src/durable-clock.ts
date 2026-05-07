// Spike-only durable Clock + dispatcher.
//
// What this is: a custom Effect Clock that records every Clock.sleep(...)
// as a durable wake-up record before parking the calling fiber, plus a
// dispatcher that fires due wake-ups against an explicit "durable time"
// the test (or production loop) advances.
//
// What this is NOT:
//   - a Scheduler override; we do not touch Effect's Scheduler.
//   - a Firegrid public wait/sleep/timeout API.
//   - a substrate change. Lives entirely in scripts/spikes/.
//
// Reference shape: Effect's TestClock — Deferred per sleep, advanced via
// an out-of-band time pointer. The novelty here is that the per-sleep
// (id, deadline) is also appended to a durable record store BEFORE the
// fiber is permitted to observe Pending, and on dispatcher teardown the
// store survives.

import { Clock, Deferred, Duration, Effect, Layer } from "effect"
import type { WakeupRecord, WakeupStore } from "./wakeup-store.ts"

interface Pending {
  readonly id: string
  readonly deadlineMs: number
  readonly deferred: Deferred.Deferred<void>
}

export interface DurableClockDispatcher {
  /** Read durable wall-time-equivalent in milliseconds. */
  readonly nowMs: () => number
  /**
   * Advance durable time and fire any pending callbacks (in-process)
   * + mark every due durable record dispatched. Returns the records that
   * were dispatched on this call.
   */
  readonly advance: (deltaMs: number) => Effect.Effect<ReadonlyArray<WakeupRecord>>
  /** Fire any due in-process callbacks at the current durable time. */
  readonly tick: () => Effect.Effect<ReadonlyArray<WakeupRecord>>
  /** Pending in-process callbacks (fibers parked under this dispatcher). */
  readonly liveCount: () => number
  /** The Effect Clock layer this dispatcher provides. */
  readonly layer: Layer.Layer<never>
}

export const makeDurableClockDispatcher = (args: {
  readonly store: WakeupStore
  readonly initialDurableTimeMs: number
  readonly scope: string
}): DurableClockDispatcher => {
  let nowMs = args.initialDurableTimeMs
  const live = new Map<string, Pending>()
  let counter = 0
  const nextId = (): string => `${args.scope}:wakeup:${++counter}`

  const fireDue: Effect.Effect<ReadonlyArray<WakeupRecord>> = Effect.gen(
    function* () {
      const due = yield* args.store.listDue(nowMs)
      const fired: WakeupRecord[] = []
      for (const record of due) {
        yield* args.store.markDispatched(record.id)
        fired.push({ ...record, status: "dispatched" })
        const pending = live.get(record.id)
        if (pending !== undefined) {
          live.delete(record.id)
          yield* Deferred.succeed(pending.deferred, void 0 as void)
        }
        // If pending is undefined, the in-memory continuation has been
        // torn down. The durable record IS marked dispatched so a
        // higher-level runtime can re-dispatch the logical work — that
        // higher-level primitive is intentionally OUT of scope for a
        // Clock layer.
      }
      return fired as ReadonlyArray<WakeupRecord>
    },
  )

  const sleep = (duration: Duration.Duration): Effect.Effect<void> =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<void>()
      const id = nextId()
      const deadlineMs = nowMs + Duration.toMillis(duration)
      // Emit-then-wait: the durable wake-up record is appended BEFORE
      // any caller can observe the fiber as Pending.
      yield* args.store.appendWakeup({
        id,
        scope: args.scope,
        deadlineMs,
        appendedAtMs: nowMs,
      })
      live.set(id, { id, deadlineMs, deferred })
      if (deadlineMs <= nowMs) {
        yield* args.store.markDispatched(id)
        live.delete(id)
        return
      }
      yield* Effect.onInterrupt(
        Deferred.await(deferred),
        () =>
          Effect.gen(function* () {
            const stillLive = live.delete(id)
            if (stillLive) {
              yield* args.store.cancel(id)
            }
          }),
      )
    })

  const clockImpl: Clock.Clock = {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => nowMs,
    unsafeCurrentTimeNanos: () => BigInt(Math.floor(nowMs * 1_000_000)),
    currentTimeMillis: Effect.sync(() => nowMs),
    currentTimeNanos: Effect.sync(() => BigInt(Math.floor(nowMs * 1_000_000))),
    sleep,
  }

  return {
    nowMs: () => nowMs,
    advance: (deltaMs) =>
      Effect.gen(function* () {
        nowMs += deltaMs
        return yield* fireDue
      }),
    tick: () => fireDue,
    liveCount: () => live.size,
    layer: Layer.setClock(clockImpl),
  }
}
