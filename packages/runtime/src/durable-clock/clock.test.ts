import {
  Cause,
  type Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  type Scope,
} from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  clockLayer,
  DurableClock,
  DurableClockStoreError,
  layer as makeLayer,
  makeInMemoryDurableClockStore,
  type DurableClockStore,
  type DurableClockWakeupStatus,
} from "./durable-clock"

// ============================================================================
// Helpers
// ============================================================================

const SCOPE = "test-scope"

type Dispatcher = Context.Tag.Service<typeof DurableClock>

/**
 * Run an Effect program with a freshly-built dispatcher in scope. Provides
 * the layer once; finalizers always run.
 */
const withDispatcher = <A, E>(
  store: DurableClockStore,
  initialDurableTimeMs: number,
  body: (d: Dispatcher) => Effect.Effect<A, E, Scope.Scope | DurableClock>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.flatMap(DurableClock, body),
        makeLayer({ store, scope: SCOPE, initialDurableTimeMs }),
      ),
    ),
  )

/** Same as withDispatcher but installs the durable Clock as the Effect Clock. */
const withClockLayer = <A, E>(
  store: DurableClockStore,
  initialDurableTimeMs: number,
  body: (d: Dispatcher) => Effect.Effect<A, E, Scope.Scope | DurableClock>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.flatMap(DurableClock, body),
        clockLayer({ store, scope: SCOPE, initialDurableTimeMs }),
      ),
    ),
  )

/**
 * Poll a predicate with bounded yield retries. Cleaner than scattering loops
 * through each test. Asserts the predicate becomes true within `maxYields`.
 */
const eventually = <A>(
  effect: Effect.Effect<A>,
  predicate: (a: A) => boolean,
  maxYields = 50,
): Effect.Effect<A, DurableClockStoreError> =>
  Effect.gen(function* () {
    for (let i = 0; i < maxYields; i++) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.yieldNow()
      }
      return yield* new DurableClockStoreError({ op: "eventually", cause: new Error(`predicate not satisfied after ${maxYields} yields`) })
  })

// ============================================================================
// Status precedence (CRDT correctness)
// ============================================================================

describe("status precedence", () => {
  it.each<
    [DurableClockWakeupStatus, DurableClockWakeupStatus, DurableClockWakeupStatus]
  >([
    ["pending", "pending", "pending"],
    ["pending", "cancelled", "cancelled"],
    ["pending", "dispatched", "dispatched"],
    ["cancelled", "pending", "cancelled"],
    ["cancelled", "cancelled", "cancelled"],
    ["cancelled", "dispatched", "dispatched"],
    ["dispatched", "pending", "dispatched"],
    ["dispatched", "cancelled", "dispatched"],
    ["dispatched", "dispatched", "dispatched"],
  ])("%s + %s => %s", async (initial, applied, expected) => {
    const store = makeInMemoryDurableClockStore({
      wakeups: [
        {
          id: "w",
          scope: SCOPE,
          deadlineMs: 1000,
          appendedAtMs: 0,
          status: initial,
        },
      ],
    })
    await Effect.runPromise(store.setStatus("w", applied))
    const after = await Effect.runPromise(store.snapshot(SCOPE))
    expect(after[0]?.status).toBe(expected)
  })
})

// ============================================================================
// In-memory store
// ============================================================================

describe("in-memory store", () => {
  it("appendWakeup is idempotent on id collision", async () => {
    const store = makeInMemoryDurableClockStore()
    const args = { id: "dup", scope: SCOPE, deadlineMs: 1000, appendedAtMs: 0 }
    const a = await Effect.runPromise(store.appendWakeup(args))
    const b = await Effect.runPromise(
      store.appendWakeup({ ...args, deadlineMs: 9999 }),
    )
    expect(a).toEqual(b)
    expect(a.deadlineMs).toBe(1000)
    expect(await Effect.runPromise(store.snapshot(SCOPE))).toHaveLength(1)
  })

  it("putTick is monotonic — never moves nowMs backwards", async () => {
    const store = makeInMemoryDurableClockStore()
    await Effect.runPromise(
      store.putTick({ scope: SCOPE, nowMs: 100, appendedAtMs: 100 }),
    )
    await Effect.runPromise(
      store.putTick({ scope: SCOPE, nowMs: 50, appendedAtMs: 50 }),
    )
    const tick = await Effect.runPromise(store.latestTick(SCOPE))
    expect(tick?.nowMs).toBe(100)
  })

  it("setStatus on unknown id is a no-op", async () => {
    const store = makeInMemoryDurableClockStore()
    await expect(
      Effect.runPromise(store.setStatus("ghost", "dispatched")),
    ).resolves.toBeUndefined()
  })

  it("snapshot filters by scope", async () => {
    const store = makeInMemoryDurableClockStore()
    await Effect.runPromise(
      store.appendWakeup({
        id: "a",
        scope: "A",
        deadlineMs: 1,
        appendedAtMs: 0,
      }),
    )
    await Effect.runPromise(
      store.appendWakeup({
        id: "b",
        scope: "B",
        deadlineMs: 1,
        appendedAtMs: 0,
      }),
    )
    expect(
      (await Effect.runPromise(store.snapshot("A"))).map((r) => r.id),
    ).toEqual(["a"])
  })

  it("onChange notifies on append and on effective setStatus only", async () => {
    const store = makeInMemoryDurableClockStore()
    const handler = vi.fn()
    const unsub = store.onChange(handler)

    await Effect.runPromise(
      store.appendWakeup({
        id: "x",
        scope: SCOPE,
        deadlineMs: 1,
        appendedAtMs: 0,
      }),
    )
    expect(handler).toHaveBeenCalledTimes(1)

    await Effect.runPromise(store.setStatus("x", "dispatched"))
    expect(handler).toHaveBeenCalledTimes(2)

    // Lower-precedence write is merged out — no notification.
    await Effect.runPromise(store.setStatus("x", "cancelled"))
    expect(handler).toHaveBeenCalledTimes(2)

    unsub()
    await Effect.runPromise(
      store.appendWakeup({
        id: "y",
        scope: SCOPE,
        deadlineMs: 1,
        appendedAtMs: 0,
      }),
    )
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it("seeded ticks and wakeups are honored", async () => {
    const store = makeInMemoryDurableClockStore({
      ticks: [{ scope: SCOPE, nowMs: 5000, appendedAtMs: 5000 }],
      wakeups: [
        {
          id: "seed",
          scope: SCOPE,
          deadlineMs: 100,
          appendedAtMs: 0,
          status: "pending",
        },
      ],
    })
    expect((await Effect.runPromise(store.latestTick(SCOPE)))?.nowMs).toBe(5000)
    expect(await Effect.runPromise(store.snapshot(SCOPE))).toHaveLength(1)
  })
})

// ============================================================================
// Dispatcher: advance / tick / fireDue
// ============================================================================

describe("dispatcher", () => {
  it("seeds the durable tick on first construction", async () => {
    const store = makeInMemoryDurableClockStore()
    await withDispatcher(store, 1000, () => Effect.void)
    const tick = await Effect.runPromise(store.latestTick(SCOPE))
    expect(tick).toEqual({ scope: SCOPE, nowMs: 1000, appendedAtMs: 1000 })
  })

  it("recovers nowMs from the durable tick on second construction", async () => {
    const store = makeInMemoryDurableClockStore()
    await withDispatcher(store, 1000, (d) => d.advance(500))
    // initialDurableTimeMs is intentionally wrong on the second boot — we
    // want to prove recovery uses the log, not the constructor argument.
    const recovered = await withDispatcher(store, 0, (d) => d.nowMs)
    expect(recovered).toBe(1500)
  })

  it("advance(0) does not move time", async () => {
    const store = makeInMemoryDurableClockStore()
    const result = await withDispatcher(store, 500, (d) =>
      Effect.gen(function* () {
        const before = yield* d.nowMs
        const fired = yield* d.advance(0)
        const after = yield* d.nowMs
        return { before, after, fired }
      }),
    )
    expect(result.before).toBe(500)
    expect(result.after).toBe(500)
    expect(result.fired).toEqual([])
    expect((await Effect.runPromise(store.latestTick(SCOPE)))?.nowMs).toBe(500)
  })

  it("advance(0) calls fireDue on wakeups that became due since last check", async () => {
    const store = makeInMemoryDurableClockStore()
    await withDispatcher(store, 500, (d) =>
      Effect.gen(function* () {
        // Append a wakeup whose deadline is already past. Either the
        // reactive fiber dispatches it via onChange, or our explicit
        // advance(0) does — both are correct. The test asserts the
        // observable contract: the record reaches `dispatched`.
        yield* store.appendWakeup({
          id: "late",
          scope: SCOPE,
          deadlineMs: 100,
          appendedAtMs: 0,
        })
        yield* d.advance(0)
        yield* eventually(
          store.snapshot(SCOPE),
          (snap) => snap.find((r) => r.id === "late")?.status === "dispatched",
        )
      }),
    )
  })

  it("advance with negative delta is a no-op for time advancement", async () => {
    const store = makeInMemoryDurableClockStore()
    await withDispatcher(store, 1000, (d) =>
      Effect.gen(function* () {
        yield* d.advance(-500)
        const now = yield* d.nowMs
        expect(now).toBe(1000)
      }),
    )
  })

  it("fireDue dispatches due wakeups in deadline order, leaves future and out-of-scope alone", async () => {
    const store = makeInMemoryDurableClockStore({
      wakeups: [
        { id: "z", scope: SCOPE, deadlineMs: 300, appendedAtMs: 0, status: "pending" },
        { id: "a", scope: SCOPE, deadlineMs: 100, appendedAtMs: 0, status: "pending" },
        { id: "m", scope: SCOPE, deadlineMs: 200, appendedAtMs: 0, status: "pending" },
        { id: "future", scope: SCOPE, deadlineMs: 9999, appendedAtMs: 0, status: "pending" },
        { id: "other", scope: "elsewhere", deadlineMs: 1, appendedAtMs: 0, status: "pending" },
      ],
    })
    // Track setStatus(dispatched) call order to verify deadline ordering.
    const dispatchOrder: string[] = []
    const tracked: DurableClockStore = {
      ...store,
      setStatus: (id, status) => {
        if (status === "dispatched") dispatchOrder.push(id)
        return store.setStatus(id, status)
      },
    }
    // Recovery fireDue runs during layer construction — that's the call we
    // want to observe. By the time withDispatcher's body runs, dispatch has
    // already happened.
    await withDispatcher(tracked, 500, () => Effect.void)

    expect(dispatchOrder).toEqual(["a", "m", "z"])

    const after = await Effect.runPromise(store.snapshot(SCOPE))
    expect(after.find((r) => r.id === "future")?.status).toBe("pending")
    const otherSnap = await Effect.runPromise(store.snapshot("elsewhere"))
    expect(otherSnap[0]?.status).toBe("pending")
  })

  it("fireDue is idempotent — rerunning after a dispatch fires nothing", async () => {
    const store = makeInMemoryDurableClockStore()
    await withDispatcher(store, 100, (d) =>
      Effect.gen(function* () {
        // Append after construction so recovery doesn't race us. Wait for
        // it to be dispatched (either by reactive fiber or our explicit
        // tick), then verify a second tick is a no-op.
        yield* store.appendWakeup({
          id: "a",
          scope: SCOPE,
          deadlineMs: 50,
          appendedAtMs: 0,
        })
        yield* d.tick
        yield* eventually(
          store.snapshot(SCOPE),
          (snap) => snap[0]?.status === "dispatched",
        )
        const second = yield* d.tick
        expect(second).toHaveLength(0)
      }),
    )
  })

  it("recovery on boot fires wakeups whose deadline is already past", async () => {
    const store = makeInMemoryDurableClockStore({
      ticks: [{ scope: SCOPE, nowMs: 1000, appendedAtMs: 1000 }],
      wakeups: [
        { id: "stale", scope: SCOPE, deadlineMs: 500, appendedAtMs: 0, status: "pending" },
      ],
    })
    await withDispatcher(store, 0, () => Effect.void)
    const after = await Effect.runPromise(store.snapshot(SCOPE))
    expect(after[0]?.status).toBe("dispatched")
  })

  it("recovery does not write to already-dispatched wakeups", async () => {
    const store = makeInMemoryDurableClockStore({
      ticks: [{ scope: SCOPE, nowMs: 1000, appendedAtMs: 1000 }],
      wakeups: [
        {
          id: "done",
          scope: SCOPE,
          deadlineMs: 500,
          appendedAtMs: 0,
          status: "dispatched",
        },
      ],
    })
    let setStatusCalls = 0
    const tracked: DurableClockStore = {
      ...store,
      setStatus: (id, status) => {
        setStatusCalls++
        return store.setStatus(id, status)
      },
    }
    await withDispatcher(tracked, 0, () => Effect.void)
    expect(setStatusCalls).toBe(0)
  })
})

// ============================================================================
// Sleep semantics
// ============================================================================

describe("sleep", () => {
  it("Effect.sleep wakes when the durable clock advances past the deadline", async () => {
    const store = makeInMemoryDurableClockStore()
    await withClockLayer(store, 0, (d) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.sleep(Duration.millis(500)))
        yield* Effect.yieldNow()
        const status1 = yield* Fiber.poll(fiber)
        expect(Option.isNone(status1)).toBe(true)

        yield* d.advance(500)
        yield* Fiber.join(fiber)
      }),
    )
  })

  it("Clock.currentTimeMillis under clockLayer returns the durable nowMs", async () => {
    const store = makeInMemoryDurableClockStore()
    const observed = await withClockLayer(store, 7_500, (d) =>
      Effect.gen(function* () {
        const before = yield* Effect.flatMap(
          Effect.clock,
          (c) => c.currentTimeMillis,
        )
        yield* d.advance(2_500)
        const after = yield* Effect.flatMap(
          Effect.clock,
          (c) => c.currentTimeMillis,
        )
        return { before, after }
      }),
    )
    expect(observed).toEqual({ before: 7_500, after: 10_000 })
  })

  it("a single advance can wake multiple fibers in deadline order", async () => {
    const store = makeInMemoryDurableClockStore()
    const wokeAt: Array<string> = []
    await withClockLayer(store, 0, (d) =>
      Effect.gen(function* () {
        const f1 = yield* Effect.fork(
          Effect.sleep(Duration.millis(300)).pipe(
            Effect.tap(() => Effect.sync(() => wokeAt.push("300"))),
          ),
        )
        const f2 = yield* Effect.fork(
          Effect.sleep(Duration.millis(100)).pipe(
            Effect.tap(() => Effect.sync(() => wokeAt.push("100"))),
          ),
        )
        const f3 = yield* Effect.fork(
          Effect.sleep(Duration.millis(200)).pipe(
            Effect.tap(() => Effect.sync(() => wokeAt.push("200"))),
          ),
        )
        // Let all three register before we start advancing.
        yield* Effect.yieldNow()

        yield* d.advance(150)
        yield* Fiber.join(f2)
        expect(wokeAt).toEqual(["100"])

        yield* d.advance(100) // now at 250
        yield* Fiber.join(f3)
        expect(wokeAt).toEqual(["100", "200"])

        yield* d.advance(100) // now at 350
        yield* Fiber.join(f1)
        expect(wokeAt).toEqual(["100", "200", "300"])
      }),
    )
  })

  it("zero-duration sleep returns immediately, recorded as dispatched", async () => {
    const store = makeInMemoryDurableClockStore()
    await withClockLayer(store, 100, () => Effect.sleep(Duration.zero))
    const snap = await Effect.runPromise(store.snapshot(SCOPE))
    expect(snap).toHaveLength(1)
    expect(snap[0]?.status).toBe("dispatched")
    expect(snap[0]?.deadlineMs).toBe(100)
  })

  it("sleep deadline that passes between append and await still completes cleanly", async () => {
    // Race window: after appendWakeup, the dispatcher's reactive fiber may
    // see the new pending record. If the deadline is at-or-before nowMs by
    // then, fireDue dispatches it immediately. The sleep's re-read of
    // snapshot must observe the terminal status and short-circuit instead
    // of awaiting a deferred that no one will resolve.
    const store = makeInMemoryDurableClockStore()
    await withClockLayer(store, 0, (d) =>
      Effect.gen(function* () {
        // Pre-advance so the next sleep(50) is in the recent past.
        const fiber = yield* Effect.fork(Effect.sleep(Duration.millis(50)))
        yield* Effect.yieldNow()
        // Advance well past so the wakeup is solidly due.
        yield* d.advance(10_000)
        // Must complete; if it hangs, the test times out.
        yield* Fiber.join(fiber)
      }),
    )
  })
})

// ============================================================================
// Cancellation
// ============================================================================

describe("cancellation", () => {
  it("interrupting a sleeping fiber durably cancels the wakeup", async () => {
    const store = makeInMemoryDurableClockStore()
    await withClockLayer(store, 0, () =>
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.sleep(Duration.millis(60_000)))
        yield* Effect.yieldNow()
        yield* Fiber.interrupt(fiber)
      }),
    )
    const snap = await Effect.runPromise(store.snapshot(SCOPE))
    expect(snap).toHaveLength(1)
    expect(snap[0]?.status).toBe("cancelled")
  })

  it("setStatus(cancelled) on an already-dispatched record is merged out (CRDT)", async () => {
    // This is the property that prevents the original implementation's
    // onInterrupt-after-dispatch bug from corrupting state.
    const store = makeInMemoryDurableClockStore({
      wakeups: [
        {
          id: "done",
          scope: SCOPE,
          deadlineMs: 1,
          appendedAtMs: 0,
          status: "dispatched",
        },
      ],
    })
    await Effect.runPromise(store.setStatus("done", "cancelled"))
    const snap = await Effect.runPromise(store.snapshot(SCOPE))
    expect(snap[0]?.status).toBe("dispatched")
  })

  it("durable append is uninterruptible — interrupt during sleep still produces a record", async () => {
    const store = makeInMemoryDurableClockStore()
    let appendCount = 0
    const wrapped: DurableClockStore = {
      ...store,
      appendWakeup: (args) =>
        Effect.gen(function* () {
          appendCount++
          return yield* store.appendWakeup(args)
        }),
    }
    await withClockLayer(wrapped, 0, () =>
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.sleep(Duration.millis(60_000)))
        yield* Effect.yieldNow()
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(appendCount).toBe(1)
    const snap = await Effect.runPromise(store.snapshot(SCOPE))
    expect(snap[0]?.status).toBe("cancelled")
  })

  it("interrupt of an effect surrounding an already-completed sleep does not write cancelled", async () => {
    // The sleep wakes (live entry deleted by fireDue), then we interrupt
    // its surrounding fiber while it's parked in Effect.never. The sleep's
    // onInterrupt handler runs; live.delete(id) returns false; setStatus
    // is skipped.
    const store = makeInMemoryDurableClockStore()
    let cancelAttempts = 0
    const wrapped: DurableClockStore = {
      ...store,
      setStatus: (id, status) => {
        if (status === "cancelled") cancelAttempts++
        return store.setStatus(id, status)
      },
    }
    await withClockLayer(wrapped, 0, (d) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.sleep(Duration.millis(50)).pipe(
            Effect.flatMap(() => Effect.never),
          ),
        )
        yield* Effect.yieldNow()
        yield* d.advance(100)
        // Give fireDue + onInterrupt time to settle.
        yield* eventually(
          store.snapshot(SCOPE),
          (snap) => snap[0]?.status === "dispatched",
        )
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(cancelAttempts).toBe(0)
    const snap = await Effect.runPromise(store.snapshot(SCOPE))
    expect(snap[0]?.status).toBe("dispatched")
  })
})

// ============================================================================
// Reactive dispatch — wakeups appended by external writers
// ============================================================================

describe("reactive dispatch", () => {
  it("a now-due wakeup appended externally gets dispatched without explicit tick()", async () => {
    const store = makeInMemoryDurableClockStore()
    await withDispatcher(store, 0, (d) =>
      Effect.gen(function* () {
        yield* d.advance(1000)
        // Bypass the dispatcher entirely — simulating a peer writer.
        yield* store.appendWakeup({
          id: "external",
          scope: SCOPE,
          deadlineMs: 500,
          appendedAtMs: 0,
        })
        yield* eventually(
          store.snapshot(SCOPE),
          (snap) => snap.find((r) => r.id === "external")?.status === "dispatched",
        )
      }),
    )
  })

  it("an externally-appended future wakeup stays pending until time advances", async () => {
    const store = makeInMemoryDurableClockStore()
    await withDispatcher(store, 0, (d) =>
      Effect.gen(function* () {
        yield* store.appendWakeup({
          id: "future",
          scope: SCOPE,
          deadlineMs: 5000,
          appendedAtMs: 0,
        })
        // Reactive fire runs but finds nothing due. Yield enough times for
        // the queue to drain.
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow()
        const before = yield* store.snapshot(SCOPE)
        expect(before[0]?.status).toBe("pending")

        yield* d.advance(10_000)
        const after = yield* store.snapshot(SCOPE)
        expect(after[0]?.status).toBe("dispatched")
      }),
    )
  })
})

// ============================================================================
// Lifecycle / finalization
// ============================================================================

describe("lifecycle", () => {
  it("scope close interrupts outstanding sleeps without writing cancelled", async () => {
    const store = makeInMemoryDurableClockStore()
    let cancelAttempts = 0
    const wrapped: DurableClockStore = {
      ...store,
      setStatus: (id, status) => {
        if (status === "cancelled") cancelAttempts++
        return store.setStatus(id, status)
      },
    }
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.provide(
            Effect.gen(function* () {
              const fiber = yield* Effect.fork(
                Effect.sleep(Duration.millis(60_000)),
              )
              yield* Effect.yieldNow()
              return fiber
            }),
            clockLayer({
              store: wrapped,
              scope: SCOPE,
              initialDurableTimeMs: 0,
            }),
          ),
        ),
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(cancelAttempts).toBe(0)
    // The pending row remains; recovery on next boot decides its fate.
    const snap = await Effect.runPromise(store.snapshot(SCOPE))
    expect(snap).toHaveLength(1)
    expect(snap[0]?.status).toBe("pending")
  })

  it("two scopes against distinct store-scopes do not interfere", async () => {
    const store = makeInMemoryDurableClockStore()
    const program = (scope: string, advanceBy: number) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.provide(
            Effect.flatMap(DurableClock, (d) =>
              Effect.flatMap(d.advance(advanceBy), () => d.nowMs),
            ),
            makeLayer({ store, scope, initialDurableTimeMs: 0 }),
          ),
        ),
      )
    expect(await program("A", 100)).toBe(100)
    expect(await program("B", 500)).toBe(500)
    // Independent durable state per scope.
    expect((await Effect.runPromise(store.latestTick("A")))?.nowMs).toBe(100)
    expect((await Effect.runPromise(store.latestTick("B")))?.nowMs).toBe(500)
  })

  it("store.close is idempotent", async () => {
    const store = makeInMemoryDurableClockStore()
    await Effect.runPromise(store.close)
    await expect(Effect.runPromise(store.close)).resolves.toBeUndefined()
  })
})

// ============================================================================
// Error propagation
// ============================================================================

describe("error handling", () => {
  it("a failing putTick during construction surfaces as DurableClockStoreError", async () => {
    const store = makeInMemoryDurableClockStore()
    const failing: DurableClockStore = {
      ...store,
      putTick: () =>
        Effect.fail(
          new DurableClockStoreError({
            op: "putTick",
            cause: new Error("disk full"),
          }),
        ),
    }
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.provide(
            Effect.flatMap(DurableClock, () => Effect.void),
            makeLayer({ store: failing, scope: SCOPE, initialDurableTimeMs: 0 }),
          ),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause)
      expect(Option.isSome(failure)).toBe(true)
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(DurableClockStoreError)
        expect(failure.value.op).toBe("putTick")
      }
    }
  })

  it("a transient setStatus failure does not kill the dispatcher's reactive fiber", async () => {
    const store = makeInMemoryDurableClockStore()
    let nextStatusFails = false
    const flaky: DurableClockStore = {
      ...store,
      setStatus: (id, status) => {
        if (nextStatusFails) {
          nextStatusFails = false
          return Effect.fail(
            new DurableClockStoreError({
              op: "setStatus",
              cause: new Error("transient"),
            }),
          )
        }
        return store.setStatus(id, status)
      },
    }
    await withClockLayer(flaky, 0, (d) =>
      Effect.gen(function* () {
        yield* d.advance(1000)

        nextStatusFails = true
        yield* store.appendWakeup({
          id: "flaky",
          scope: SCOPE,
          deadlineMs: 100,
          appendedAtMs: 0,
        })
        // Let the reactive fiber attempt and fail.
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow()

        // Trigger another change event; the fiber must still be alive and
        // process this one. fireDue retries the still-pending flaky record
        // with the gate now closed.
        yield* store.appendWakeup({
          id: "ok",
          scope: SCOPE,
          deadlineMs: 100,
          appendedAtMs: 0,
        })
        yield* eventually(store.snapshot(SCOPE), (snap) => {
          const f = snap.find((r) => r.id === "flaky")
          const o = snap.find((r) => r.id === "ok")
          return f?.status === "dispatched" && o?.status === "dispatched"
        })
      }),
    )
  })
})
