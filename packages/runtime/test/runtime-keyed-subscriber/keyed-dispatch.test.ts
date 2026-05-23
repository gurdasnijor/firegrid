// Production tests for the Shape C subscriber-runtime helper. Pins the four
// load-bearing invariants tf-4fy3's tiny-firegrid proof identified:
//   1. Per-key serialization (max in-flight per key = 1).
//   2. Cross-key concurrency (different keys progress concurrently).
//   3. Bounded concurrency respected when configured.
//   4. Order-within-key preservation.
// Plus error propagation (handler error surfaces in the dispatcher Effect).
//
// Concurrency observations use a Deferred-based rendezvous barrier — same
// pattern that made tf-4fy3's falsifier deterministic — so the assertions do
// not depend on a sleep timing window.

import { Chunk, Deferred, Effect, Ref, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  makePerKeyMutex,
  runKeyedDispatch,
  type KeyedEvent,
} from "../../src/runtime-keyed-subscriber/index.ts"

interface ConcurrencyObservation {
  readonly activePerKey: Record<string, number>
  readonly activeKeys: number
  readonly maxInKeyConcurrency: number
  readonly maxCrossKeyConcurrency: number
}

const emptyObservation: ConcurrencyObservation = {
  activePerKey: {},
  activeKeys: 0,
  maxInKeyConcurrency: 0,
  maxCrossKeyConcurrency: 0,
}

const enter = (
  ref: Ref.Ref<ConcurrencyObservation>,
  key: string,
): Effect.Effect<void> =>
  Ref.update(ref, state => {
    const previous = state.activePerKey[key] ?? 0
    const nextCount = previous + 1
    const activeKeys = previous === 0 ? state.activeKeys + 1 : state.activeKeys
    return {
      activePerKey: { ...state.activePerKey, [key]: nextCount },
      activeKeys,
      maxInKeyConcurrency: Math.max(state.maxInKeyConcurrency, nextCount),
      maxCrossKeyConcurrency: Math.max(state.maxCrossKeyConcurrency, activeKeys),
    }
  })

const exit = (
  ref: Ref.Ref<ConcurrencyObservation>,
  key: string,
): Effect.Effect<void> =>
  Ref.update(ref, state => {
    const previous = state.activePerKey[key] ?? 0
    const nextCount = Math.max(0, previous - 1)
    const activeKeys = nextCount === 0 ? state.activeKeys - 1 : state.activeKeys
    return {
      ...state,
      activePerKey: { ...state.activePerKey, [key]: nextCount },
      activeKeys,
    }
  })

interface Rendezvous {
  readonly arrive: Effect.Effect<void>
}

const makeRendezvous = (expected: number): Effect.Effect<Rendezvous> =>
  Effect.gen(function*() {
    const count = yield* Ref.make(0)
    const gate = yield* Deferred.make<void>()
    return {
      arrive: Effect.gen(function*() {
        const arrived = yield* Ref.updateAndGet(count, current => current + 1)
        if (arrived >= expected) yield* Deferred.succeed(gate, undefined)
        // Bounded wait so a serializing path (mutex queue) never deadlocks the
        // test. The 1s timeout is the safety valve; the positive assertion
        // never relies on it.
        yield* Deferred.await(gate).pipe(Effect.timeout("1 second"), Effect.ignore)
      }),
    }
  })

const events = (
  rows: ReadonlyArray<[key: string, event: number]>,
): Stream.Stream<KeyedEvent<string, number>, never> =>
  Stream.fromIterable(rows.map(([key, event]) => ({ key, event })))

describe("runKeyedDispatch", () => {
  it("serializes same-key handlers (maxInKey = 1)", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const obs = yield* Ref.make(emptyObservation)
      const rendezvous = yield* makeRendezvous(2)
      yield* runKeyedDispatch({
        source: events([["A", 1], ["A", 2], ["A", 3]]),
        handle: (key, _event) =>
          Effect.acquireUseRelease(
            enter(obs, key),
            () => rendezvous.arrive,
            () => exit(obs, key),
          ),
      })
      const final = yield* Ref.get(obs)
      expect(final.maxInKeyConcurrency).toBe(1)
    }))
  })

  it("runs different keys concurrently (maxCrossKey > 1)", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const obs = yield* Ref.make(emptyObservation)
      const rendezvous = yield* makeRendezvous(3)
      yield* runKeyedDispatch({
        source: events([
          ["A", 1], ["B", 1], ["C", 1],
          ["A", 2], ["B", 2], ["C", 2],
        ]),
        handle: (key, _event) =>
          Effect.acquireUseRelease(
            enter(obs, key),
            () => rendezvous.arrive,
            () => exit(obs, key),
          ),
      })
      const final = yield* Ref.get(obs)
      expect(final.maxInKeyConcurrency).toBe(1)
      expect(final.maxCrossKeyConcurrency).toBe(3)
    }))
  })

  it("respects bounded concurrency", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const obs = yield* Ref.make(emptyObservation)
      const rendezvous = yield* makeRendezvous(2)
      yield* runKeyedDispatch({
        source: events([["A", 1], ["B", 1], ["C", 1], ["D", 1]]),
        concurrency: 2,
        handle: (key, _event) =>
          Effect.acquireUseRelease(
            enter(obs, key),
            () => rendezvous.arrive,
            () => exit(obs, key),
          ),
      })
      const final = yield* Ref.get(obs)
      expect(final.maxInKeyConcurrency).toBe(1)
      expect(final.maxCrossKeyConcurrency).toBeLessThanOrEqual(2)
      // Should reach the cap, otherwise we did not actually exercise the bound.
      expect(final.maxCrossKeyConcurrency).toBeGreaterThanOrEqual(2)
    }))
  })

  it("preserves source order within a key", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const seen = yield* Ref.make<Record<string, ReadonlyArray<number>>>({})
      yield* runKeyedDispatch({
        source: events([
          ["A", 1], ["B", 1], ["A", 2], ["B", 2], ["A", 3], ["B", 3],
        ]),
        handle: (key, event) =>
          Ref.update(seen, current => ({
            ...current,
            [key]: [...(current[key] ?? []), event],
          })),
      })
      const final = yield* Ref.get(seen)
      expect(final["A"]).toEqual([1, 2, 3])
      expect(final["B"]).toEqual([1, 2, 3])
    }))
  })

  it("propagates handler errors", async () => {
    const exit = await Effect.runPromiseExit(
      runKeyedDispatch<string, number, string, never>({
        source: events([["A", 1], ["A", 2]]),
        handle: (_key, event) =>
          event === 2 ? Effect.fail("boom" as const) : Effect.void,
      }),
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("makePerKeyMutex", () => {
  it("serializes same key, isolates across keys", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const mutex = yield* makePerKeyMutex<string>()
      const seq = yield* Ref.make<ReadonlyArray<string>>([])
      const stamp = (label: string) =>
        Ref.update(seq, current => [...current, label])
      const order = yield* Effect.all(
        [
          mutex.withKey(
            "A",
            stamp("A1-start").pipe(Effect.zipRight(stamp("A1-end"))),
          ),
          mutex.withKey(
            "A",
            stamp("A2-start").pipe(Effect.zipRight(stamp("A2-end"))),
          ),
          mutex.withKey(
            "B",
            stamp("B1-start").pipe(Effect.zipRight(stamp("B1-end"))),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.zipRight(Ref.get(seq)))
      // Same key cannot interleave: between any "Ai-start" and "Ai-end" no
      // other "Aj-start" appears.
      const positions = (label: string): number => order.indexOf(label)
      expect(positions("A1-end")).toBeLessThan(positions("A2-start"))
      // Different keys are not constrained, just present.
      expect(order).toEqual(expect.arrayContaining(["B1-start", "B1-end"]))
      // The final length is 6.
      expect(Chunk.fromIterable(order).pipe(Chunk.size)).toBe(6)
    }))
  })
})
