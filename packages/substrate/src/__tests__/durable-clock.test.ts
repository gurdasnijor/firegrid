import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  Chunk,
  Duration,
  Effect,
  Fiber,
  Option,
  Schedule,
  Stream,
} from "effect"
import {
  makeDurableClockDispatcher,
  makeInMemoryDurableClockWakeupStore,
  makeDurableStreamClockWakeupStore,
  type DurableClockWakeupStore,
} from "../durable-clock/index.ts"
import { DurableStream } from "@durable-streams/client"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

const T0 = 1_700_000_000_000

const waitUntilPendingCount = (
  store: DurableClockWakeupStore,
  target: number,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    while (true) {
      const pending = yield* store.listPending()
      if (pending.length >= target) return
      yield* Effect.yieldNow()
    }
  })

describe("durable-clock-layer.CLOCK_LAYER", () => {
  it("durable-clock-layer.CLOCK_LAYER.3 — appends the durable wake-up before parking the fiber", async () => {
    const store = makeInMemoryDurableClockWakeupStore()
    const dispatcher = makeDurableClockDispatcher({
      store,
      initialDurableTimeMs: T0,
      scope: "sleep",
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.gen(function* () {
            const beforeMs = yield* Effect.clockWith(
              (clock) => clock.currentTimeMillis,
            )
            yield* Effect.sleep(Duration.minutes(5))
            const afterMs = yield* Effect.clockWith(
              (clock) => clock.currentTimeMillis,
            )
            return { beforeMs, afterMs }
          }),
        )

        yield* waitUntilPendingCount(store, 1)
        const pending = yield* store.listPending()
        expect(pending).toHaveLength(1)
        expect(pending[0]?.deadlineMs).toBe(T0 + 5 * 60_000)
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
    const snapshot = await Effect.runPromise(store.snapshot())
    expect(snapshot.every((record) => record.status === "dispatched"))
      .toBe(true)
  })

  it("durable-clock-layer.CLOCK_LAYER.5 — interrupting a live parked sleep cancels the wake-up", async () => {
    const store = makeInMemoryDurableClockWakeupStore()
    const dispatcher = makeDurableClockDispatcher({
      store,
      initialDurableTimeMs: T0,
      scope: "interrupt",
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.sleep(Duration.minutes(5)))
        yield* waitUntilPendingCount(store, 1)
        expect(dispatcher.liveCount()).toBe(1)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(dispatcher.layer)),
    )

    expect(dispatcher.liveCount()).toBe(0)
    expect(await Effect.runPromise(store.snapshot())).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ])
  })
})

describe("durable-clock-layer.EFFECT_STACK", () => {
  it("durable-clock-layer.EFFECT_STACK.1 + durable-clock-layer.EFFECT_STACK.2 — standard Effect sleep and timeout APIs use the durable Clock", async () => {
    const store = makeInMemoryDurableClockWakeupStore()
    const dispatcher = makeDurableClockDispatcher({
      store,
      initialDurableTimeMs: T0,
      scope: "timeout",
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.sleep(Duration.minutes(5)).pipe(
            Effect.timeoutOption(Duration.minutes(1)),
          ),
        )
        yield* waitUntilPendingCount(store, 2)
        const fired = yield* dispatcher.advance(60_000)
        expect(fired.map((record) => record.deadlineMs)).toEqual([
          T0 + 60_000,
        ])
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(dispatcher.layer)),
    )

    expect(Option.isNone(result)).toBe(true)
    expect(
      (await Effect.runPromise(store.snapshot())).filter(
        (record) => record.status === "cancelled",
      ),
    ).toHaveLength(1)
  })

  it("durable-clock-layer.EFFECT_STACK.3 — standard Schedule retry timing uses the durable Clock", async () => {
    const store = makeInMemoryDurableClockWakeupStore()
    const dispatcher = makeDurableClockDispatcher({
      store,
      initialDurableTimeMs: T0,
      scope: "schedule",
    })
    let attempts = 0

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.sync(() => {
            attempts += 1
            return attempts
          }).pipe(
            Effect.flatMap((attempt) =>
              attempt >= 4 ? Effect.succeed(attempt) : Effect.fail("retry"),
            ),
            Effect.retry(
              Schedule.exponential(Duration.millis(100)).pipe(
                Schedule.compose(Schedule.recurs(5)),
              ),
            ),
          ),
        )

        for (let i = 0; i < 3; i++) {
          yield* waitUntilPendingCount(store, 1)
          const pending = yield* store.listPending()
          const earliest = pending
            .map((record) => record.deadlineMs)
            .reduce((left, right) => Math.min(left, right), Infinity)
          yield* dispatcher.advance(earliest - dispatcher.nowMs())
        }

        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(dispatcher.layer)),
    )

    expect(result).toBe(4)
    expect(
      (await Effect.runPromise(store.snapshot())).map(
        (record) => record.deadlineMs - T0,
      ),
    ).toEqual([100, 300, 700])
  })

  it("durable-clock-layer.EFFECT_STACK.4 — Clock-backed Stream operators use the durable Clock", async () => {
    const store = makeInMemoryDurableClockWakeupStore()
    const dispatcher = makeDurableClockDispatcher({
      store,
      initialDurableTimeMs: T0,
      scope: "stream",
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

    expect(Chunk.toReadonlyArray(collected)).toHaveLength(3)
    expect(
      (await Effect.runPromise(store.snapshot())).map(
        (record) => record.deadlineMs - T0,
      ),
    ).toEqual([250, 500, 750])
  })
})

describe("durable-clock-layer.RESTART_BOUNDARY", () => {
  it("durable-clock-layer.RESTART_BOUNDARY.1 + durable-clock-layer.RESTART_BOUNDARY.2 — a recreated dispatcher can dispatch rehydrated wake-ups but cannot resume dead fibers", async () => {
    const storeA = makeInMemoryDurableClockWakeupStore()
    const dispatcherA = makeDurableClockDispatcher({
      store: storeA,
      initialDurableTimeMs: T0,
      scope: "restart",
    })

    const { pendingAtDeath, snapshotAtDeath } = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.fork(Effect.sleep(Duration.minutes(10)))
        yield* waitUntilPendingCount(storeA, 1)
        return {
          pendingAtDeath: yield* storeA.listPending(),
          snapshotAtDeath: yield* storeA.snapshot(),
        }
      }).pipe(Effect.provide(dispatcherA.layer)),
    )

    expect(pendingAtDeath).toHaveLength(1)
    expect(snapshotAtDeath[0]?.status).toBe("pending")

    // durable-clock-layer.WAKEUP_STORE.3
    // durable-clock-layer.RESTART_BOUNDARY.3
    const storeB = makeInMemoryDurableClockWakeupStore(snapshotAtDeath)
    const dispatcherB = makeDurableClockDispatcher({
      store: storeB,
      initialDurableTimeMs: T0,
      scope: "restart",
    })
    expect(dispatcherB.liveCount()).toBe(0)

    const fired = await Effect.runPromise(dispatcherB.advance(10 * 60_000))
    expect(fired).toHaveLength(1)
    expect(fired[0]?.id).toBe(pendingAtDeath[0]?.id)
    expect((await Effect.runPromise(storeB.snapshot()))[0]?.status).toBe(
      "dispatched",
    )
    expect(dispatcherB.liveCount()).toBe(0)
  })

  it("durable-clock-layer.WAKEUP_STORE.5 + durable-clock-layer.WAKEUP_STORE.6 + durable-clock-layer.WAKEUP_STORE.7 + durable-clock-layer.RESTART_BOUNDARY.4 — Durable Streams-backed stores restart from the stream URL without in-memory snapshots", async () => {
    const streamUrl = freshStreamUrl("durable-clock-restart")
    await DurableStream.create({ url: streamUrl, contentType: "application/json" })
    const storeA = makeDurableStreamClockWakeupStore({ streamUrl })
    let storeB: DurableClockWakeupStore | undefined

    try {
      const pendingBeforeRestart = await Effect.runPromise(
        Effect.gen(function* () {
          yield* storeA.appendWakeup({
            id: "restart-stream:wakeup:1",
            scope: "restart-stream",
            appendedAtMs: T0,
            deadlineMs: T0 + 10 * 60_000,
          })
          return yield* storeA.listPending()
        }),
      )

      expect(pendingBeforeRestart).toHaveLength(1)
      expect(pendingBeforeRestart[0]?.status).toBe("pending")
      storeA.close()

      storeB = makeDurableStreamClockWakeupStore({ streamUrl })
      const dispatcherB = makeDurableClockDispatcher({
        store: storeB,
        initialDurableTimeMs: T0,
        scope: "restart-stream",
      })
      expect(dispatcherB.liveCount()).toBe(0)

      const fired = await Effect.runPromise(dispatcherB.advance(10 * 60_000))
      expect(fired).toHaveLength(1)
      expect(fired[0]?.id).toBe(pendingBeforeRestart[0]?.id)

      const pendingAfterDispatch = await Effect.runPromise(storeB.listPending())
      expect(pendingAfterDispatch).toHaveLength(0)
    } finally {
      storeA.close()
      storeB?.close()
    }
  })
})
