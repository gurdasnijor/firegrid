// Durable Clock dispatch/resume spike.
//
// Acceptance from the dispatch (verbatim, condensed):
//   1. Clock.sleep records a durable wake-up, parks the fiber, dispatcher
//      resumes when due.
//   2. Effect.sleep, Effect.timeout, Schedule.exponential, and at least one
//      Clock-backed Stream operator work unchanged under the Layer.
//   3. Restart: pending wake-up records survive dispatcher/layer teardown
//      and a recreated dispatcher can discover due wake-ups.
//   4. No Effect Scheduler override.
//   5. No Firegrid wait/sleep/timeout wrappers in test (pure Effect APIs).
//   6. Do not test Effect or durable-streams behavior.
//
// We test only the Firegrid Clock substitution + dispatch boundary.

import { describe, expect, it } from "vitest"
import {
  Chunk,
  Duration,
  Effect,
  Fiber,
  Option,
  Schedule,
  Stream,
} from "effect"
import { makeDurableClockDispatcher } from "../durable-clock.ts"
import { makeInMemoryWakeupStore } from "../wakeup-store.ts"

const T0 = 1_700_000_000_000

const waitUntilPendingCount = (
  store: ReturnType<typeof makeInMemoryWakeupStore>,
  target: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      const pending = yield* store.listPending()
      if (pending.length >= target) return
      yield* Effect.yieldNow()
    }
  })

describe("A. Live-process substitution under a custom durable Clock layer", () => {
  it("Effect.sleep parks the fiber and resumes when the dispatcher advances past the deadline", async () => {
    const store = makeInMemoryWakeupStore()
    const dispatcher = makeDurableClockDispatcher({
      store,
      initialDurableTimeMs: T0,
      scope: "test-1",
    })

    const program = Effect.gen(function* () {
      const beforeMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      yield* Effect.sleep(Duration.minutes(5))
      const afterMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      return { beforeMs, afterMs }
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(program)
        yield* waitUntilPendingCount(store, 1)
        // Durable record is committed BEFORE we permit time to advance —
        // the emit-then-wait bar.
        const pendingBefore = yield* store.listPending()
        expect(pendingBefore).toHaveLength(1)
        expect(pendingBefore[0]?.deadlineMs).toBe(T0 + 5 * 60_000)
        expect(dispatcher.liveCount()).toBe(1)

        const fired = yield* dispatcher.advance(5 * 60_000)
        expect(fired).toHaveLength(1)
        expect(fired[0]?.status).toBe("dispatched")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(dispatcher.layer)),
    )

    expect(result).toEqual({
      beforeMs: T0,
      afterMs: T0 + 5 * 60_000,
    })
    expect(store.snapshot().every((r) => r.status === "dispatched")).toBe(true)
  })

  it("Effect.timeout races against Clock.sleep through the same custom Clock", async () => {
    const store = makeInMemoryWakeupStore()
    const dispatcher = makeDurableClockDispatcher({
      store,
      initialDurableTimeMs: T0,
      scope: "test-2",
    })

    const slow = Effect.gen(function* () {
      yield* Effect.sleep(Duration.minutes(5))
      return "slow-completed"
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          slow.pipe(Effect.timeoutOption(Duration.minutes(1))),
        )
        // timeout adds a second sleep racing the inner sleep, so we
        // expect TWO durable wake-up records.
        yield* waitUntilPendingCount(store, 2)
        expect(dispatcher.liveCount()).toBe(2)

        // Advance exactly to the timeout deadline. Only the timeout
        // wake-up should fire; the 5-minute sleep is still pending.
        const fired = yield* dispatcher.advance(1 * 60_000)
        const dispatchedDeadlines = fired
          .map((r) => r.deadlineMs)
          .sort((a, b) => a - b)
        expect(dispatchedDeadlines).toEqual([T0 + 1 * 60_000])

        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(dispatcher.layer)),
    )

    // Effect.timeout returns Option.none when the timeout wins.
    expect(Option.isNone(result)).toBe(true)
    // The losing 5-minute sleep should have been cancelled when the
    // timeout fiber interrupted it.
    const cancelled = store.snapshot().filter((r) => r.status === "cancelled")
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]?.deadlineMs).toBe(T0 + 5 * 60_000)
  })

  it("Effect.retry under Schedule.exponential records one durable wake-up per retry interval", async () => {
    const store = makeInMemoryWakeupStore()
    const dispatcher = makeDurableClockDispatcher({
      store,
      initialDurableTimeMs: T0,
      scope: "test-3",
    })

    let attempts = 0
    const failing = Effect.sync(() => {
      attempts += 1
      return attempts
    }).pipe(
      Effect.flatMap((n) => (n >= 4 ? Effect.succeed(n) : Effect.fail("nope"))),
    )

    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          failing.pipe(
            Effect.retry(
              Schedule.exponential(Duration.millis(100)).pipe(
                Schedule.compose(Schedule.recurs(5)),
              ),
            ),
          ),
        )

        // Drive the schedule: advance enough to fire each retry sleep
        // in turn (100, 200, 400 — 3 retries to reach attempt 4).
        const driver = Effect.gen(function* () {
          for (let i = 0; i < 3; i++) {
            yield* waitUntilPendingCount(store, 1)
            const pending = yield* store.listPending()
            const earliest = pending
              .map((r) => r.deadlineMs)
              .reduce((a, b) => Math.min(a, b), Infinity)
            yield* dispatcher.advance(earliest - dispatcher.nowMs())
          }
        })
        yield* driver

        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(dispatcher.layer)),
    )

    expect(collected).toBe(4)
    const all = store.snapshot()
    // Three exponential intervals were recorded as durable wake-ups.
    expect(all.map((r) => r.deadlineMs - T0)).toEqual([100, 300, 700])
    expect(all.every((r) => r.status === "dispatched")).toBe(true)
  })

  it("Stream.fromSchedule consumes Clock-backed ticks through the same Layer", async () => {
    const store = makeInMemoryWakeupStore()
    const dispatcher = makeDurableClockDispatcher({
      store,
      initialDurableTimeMs: T0,
      scope: "test-4",
    })

    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Stream.fromSchedule(Schedule.spaced(Duration.millis(250))).pipe(
            Stream.take(3),
            Stream.runCollect,
          ),
        )

        for (let i = 0; i < 3; i++) {
          yield* waitUntilPendingCount(store, 1)
          yield* dispatcher.advance(250)
        }
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(dispatcher.layer)),
    )

    const items = Chunk.toReadonlyArray(collected)
    expect(items).toHaveLength(3)
    const deadlines = store
      .snapshot()
      .filter((r) => r.status === "dispatched")
      .map((r) => r.deadlineMs - T0)
    expect(deadlines).toEqual([250, 500, 750])
  })
})

describe("B. Restart boundary: durable records survive dispatcher/layer teardown", () => {
  it("a recreated dispatcher can discover and dispatch a wake-up that was registered before teardown", async () => {
    const store = makeInMemoryWakeupStore()
    const dispatcherA = makeDurableClockDispatcher({
      store,
      initialDurableTimeMs: T0,
      scope: "restart",
    })

    // Phase 1: register a sleep, snapshot the durable store WHILE the
    // fiber is parked, then let the live runtime tear itself down. We
    // take the snapshot inside the live scope because real "process
    // death" means whatever durable rows existed at the moment of
    // death; cleanup paths never run. A graceful interrupt would mark
    // the row cancelled — which is the wrong baseline for restart.
    const { snapshotAtParkedMoment, pendingAtParkedMoment } =
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.fork(
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.minutes(10))
              return "phaseA-resumed"
            }),
          )
          yield* waitUntilPendingCount(store, 1)
          const pending = yield* store.listPending()
          return {
            snapshotAtParkedMoment: store.snapshot(),
            pendingAtParkedMoment: pending,
          }
        }).pipe(Effect.provide(dispatcherA.layer)),
      )

    expect(pendingAtParkedMoment).toHaveLength(1)
    expect(pendingAtParkedMoment[0]?.scope).toBe("restart")
    expect(pendingAtParkedMoment[0]?.deadlineMs).toBe(T0 + 10 * 60_000)
    expect(snapshotAtParkedMoment).toHaveLength(1)
    expect(snapshotAtParkedMoment[0]?.status).toBe("pending")

    // Build a brand-new dispatcher backed by the SAME records the old
    // dispatcher had committed. This simulates: process dies, restart,
    // store rehydrated from durable medium.
    const restartedStore = makeInMemoryWakeupStore(snapshotAtParkedMoment)
    const dispatcherB = makeDurableClockDispatcher({
      store: restartedStore,
      initialDurableTimeMs: T0,
      scope: "restart",
    })

    expect(dispatcherB.liveCount()).toBe(0) // no in-memory continuations

    // Phase 2: the restarted dispatcher advances past the deadline.
    // It should observe the rehydrated wake-up as due and mark it
    // dispatched durably — even though there is no parked fiber to
    // wake.
    const fired = await Effect.runPromise(
      dispatcherB.advance(10 * 60_000),
    )
    expect(fired).toHaveLength(1)
    expect(fired[0]?.id).toBe(pendingAtParkedMoment[0]?.id)
    expect(fired[0]?.status).toBe("dispatched")

    // KEY FINDING (encoded as an assertion): the durable record was
    // promoted to dispatched, but no fiber resumed because no fiber
    // exists. A Clock layer alone cannot re-dispatch the suspended
    // logical work — that requires a runtime-owned re-dispatch /
    // checkpoint primitive that turns "wake-up dispatched" into "the
    // work that was sleeping resumes from durable state."
    expect(dispatcherB.liveCount()).toBe(0)
    const finalPending = await Effect.runPromise(restartedStore.listPending())
    expect(finalPending).toHaveLength(0)
  })
})
