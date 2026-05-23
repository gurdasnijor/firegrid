// Wave D-A Shape (b) — loop-body proof.
//
// 6 hypothesis tests across the test matrix in FINDING.md:
//
//   1. Sequence-keyed dedup drops first input  (falsification baseline)
//   2. Identity-keyed dedup delivers first input  (GREEN target)
//   3. Restart idempotency: replay drops second delivery
//   4. Output sequence-cursor preserved
//   5. Interleaving under per-key serialization
//   6. Cross-key concurrency
//
// Each test composes:
//   substrate + handler + runKeyedDispatch on a forked fiber
//   → append rows to SubscriptionRefs
//   → wait for assertion conditions (handlerInvocations counter)
//   → interrupt the dispatcher fiber
//   → assert ledger + counters
//
// Mirrors the `shape-c-non-recursive-start/probe.test.ts` driver pattern.

import { Effect, Fiber, Ref } from "effect"
import { describe, expect, it } from "vitest"
import {
  appendInput,
  appendOutput,
  identityKeyedHandler,
  loadState,
  makeLegacyStateRef,
  makeSubstrate,
  runShapeBSubscriber,
  runShapeBSubscriberMulti,
  sequenceKeyedHandler,
} from "../../src/simulations/wave-d-a-shape-b-input-identity-dedup/index.ts"

// ── Driver utilities ──────────────────────────────────────────────────────

/**
 * Wait for `predicate(counter)` to hold by polling the substrate counter.
 * Bounded so a stuck condition fails the test instead of hanging.
 */
const waitForCounter = (
  ref: Ref.Ref<number>,
  predicate: (n: number) => boolean,
  budget: { readonly attempts: number; readonly intervalMs: number } = {
    attempts: 100,
    intervalMs: 5,
  },
): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    for (let tick = 0; tick < budget.attempts; tick += 1) {
      const value = yield* Ref.get(ref)
      if (predicate(value)) return value
      yield* Effect.sleep(`${budget.intervalMs} millis`)
    }
    return yield* Effect.fail(
      new Error(`waitForCounter: predicate did not hold after ${budget.attempts} ticks`),
    )
  })

// ── TEST 1 — falsification baseline (sequence-keyed drops first input) ───

describe("wave-d-a shape-b: sequence-keyed dedup (falsification baseline)", () => {
  it("drops the first input on a fresh subscriber because RuntimeIngressInputRow.sequence is undefined", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const substrate = yield* makeSubstrate()
        const legacyStates = yield* makeLegacyStateRef()
        const fiber = yield* Effect.fork(
          runShapeBSubscriber(substrate, "ctx-1", sequenceKeyedHandler(substrate, legacyStates)),
        )
        // Append one input with no sequence (intent-derived row shape).
        yield* appendInput(substrate, {
          inputId: "i-1",
          contextId: "ctx-1",
          kind: "message",
          payload: "hello",
        })
        // The handler IS invoked (the dispatcher delivers); the gate skips it.
        yield* waitForCounter(substrate.handlerInvocations, (n) => n >= 1)
        yield* Fiber.interrupt(fiber)
        return {
          invocations: yield* Ref.get(substrate.handlerInvocations),
          dispatches: yield* Ref.get(substrate.handlerDispatches),
          skips: yield* Ref.get(substrate.handlerSkips),
        }
      }),
    )
    // Handler ran once but the action was Skipped (sequence-keyed gate
    // matched the cursor floor) — the input was effectively dropped.
    expect(result.invocations).toBe(1)
    expect(result.dispatches).toBe(0)
    expect(result.skips).toBe(1)
  })
})

// ── TEST 2 — GREEN target (identity-keyed delivers first input) ─────────

describe("wave-d-a shape-b: identity-keyed dedup (GREEN target)", () => {
  it("delivers the first input on a fresh subscriber; processedInputIds records the inputId", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const substrate = yield* makeSubstrate()
        const fiber = yield* Effect.fork(
          runShapeBSubscriber(substrate, "ctx-1", identityKeyedHandler(substrate)),
        )
        yield* appendInput(substrate, {
          inputId: "i-1",
          contextId: "ctx-1",
          kind: "message",
          payload: "hello",
        })
        yield* waitForCounter(substrate.handlerDispatches, (n) => n >= 1)
        yield* Fiber.interrupt(fiber)
        return {
          invocations: yield* Ref.get(substrate.handlerInvocations),
          dispatches: yield* Ref.get(substrate.handlerDispatches),
          skips: yield* Ref.get(substrate.handlerSkips),
          state: yield* loadState(substrate, "ctx-1"),
        }
      }),
    )
    expect(result.invocations).toBe(1)
    expect(result.dispatches).toBe(1)
    expect(result.skips).toBe(0)
    expect(result.state.processedInputIds).toEqual(["i-1"])
    expect(result.state.dispatchedActionIds).toEqual(["dispatched-input-i-1"])
  })
})

// ── TEST 3 — restart idempotency ────────────────────────────────────────

describe("wave-d-a shape-b: restart idempotency", () => {
  it("redelivers the same input across a fresh subscriber materialization without re-dispatching", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const substrate = yield* makeSubstrate()

        // First subscriber: dispatches the input, saves state.
        const fiber1 = yield* Effect.fork(
          runShapeBSubscriber(substrate, "ctx-1", identityKeyedHandler(substrate)),
        )
        yield* appendInput(substrate, {
          inputId: "i-1",
          contextId: "ctx-1",
          kind: "message",
          payload: "hello",
        })
        yield* waitForCounter(substrate.handlerDispatches, (n) => n >= 1)
        yield* Fiber.interrupt(fiber1)

        // "Restart": a fresh subscriber on the same substrate. The input
        // is redelivered from the durable log; state loaded fresh from the
        // store still contains processedInputIds: ["i-1"] ⇒ skip.
        const fiber2 = yield* Effect.fork(
          runShapeBSubscriber(substrate, "ctx-1", identityKeyedHandler(substrate)),
        )
        // The second subscriber observes the input redelivered (history
        // replay on stream attach). Wait for the SECOND invocation.
        yield* waitForCounter(substrate.handlerInvocations, (n) => n >= 2)
        yield* Fiber.interrupt(fiber2)

        return {
          invocations: yield* Ref.get(substrate.handlerInvocations),
          dispatches: yield* Ref.get(substrate.handlerDispatches),
          skips: yield* Ref.get(substrate.handlerSkips),
          state: yield* loadState(substrate, "ctx-1"),
        }
      }),
    )
    expect(result.invocations).toBe(2)
    expect(result.dispatches).toBe(1)
    expect(result.skips).toBe(1)
    // Ledger still contains exactly one dispatched action — restart did
    // not double-count.
    expect(result.state.dispatchedActionIds).toEqual(["dispatched-input-i-1"])
  })
})

// ── TEST 4 — output sequence cursor preserved ─────────────────────────

describe("wave-d-a shape-b: output sequence-cursor", () => {
  it("skips outputs at or below lastProcessedOutputSequence; dispatches strictly-after outputs", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const substrate = yield* makeSubstrate()
        const fiber = yield* Effect.fork(
          runShapeBSubscriber(substrate, "ctx-1", identityKeyedHandler(substrate)),
        )
        // Three outputs in ascending sequence: 0, 1, 2.
        yield* appendOutput(substrate, {
          contextId: "ctx-1",
          sequence: 0,
          kind: "text",
          payload: "a",
        })
        yield* appendOutput(substrate, {
          contextId: "ctx-1",
          sequence: 1,
          kind: "text",
          payload: "b",
        })
        yield* appendOutput(substrate, {
          contextId: "ctx-1",
          sequence: 2,
          kind: "text",
          payload: "c",
        })
        yield* waitForCounter(substrate.handlerDispatches, (n) => n >= 3)
        yield* Fiber.interrupt(fiber)
        return {
          dispatches: yield* Ref.get(substrate.handlerDispatches),
          state: yield* loadState(substrate, "ctx-1"),
        }
      }),
    )
    expect(result.dispatches).toBe(3)
    expect(result.state.lastProcessedOutputSequence).toBe(2)
    expect(result.state.dispatchedActionIds).toEqual([
      "dispatched-output-ctx-1-0",
      "dispatched-output-ctx-1-1",
      "dispatched-output-ctx-1-2",
    ])
  })
})

// ── TEST 5 — interleaving under per-key serialization ───────────────────

describe("wave-d-a shape-b: input/output interleaving", () => {
  it("dispatches interleaved inputs and outputs FIFO on a single contextId; per-key mutex serializes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const substrate = yield* makeSubstrate()
        const fiber = yield* Effect.fork(
          runShapeBSubscriber(substrate, "ctx-1", identityKeyedHandler(substrate)),
        )
        yield* appendInput(substrate, {
          inputId: "i-1",
          contextId: "ctx-1",
          kind: "message",
          payload: "hello",
        })
        yield* appendOutput(substrate, {
          contextId: "ctx-1",
          sequence: 0,
          kind: "text",
          payload: "ack",
        })
        yield* appendInput(substrate, {
          inputId: "i-2",
          contextId: "ctx-1",
          kind: "message",
          payload: "world",
        })
        yield* waitForCounter(substrate.handlerDispatches, (n) => n >= 3)
        yield* Fiber.interrupt(fiber)
        return {
          dispatches: yield* Ref.get(substrate.handlerDispatches),
          state: yield* loadState(substrate, "ctx-1"),
        }
      }),
    )
    expect(result.dispatches).toBe(3)
    // Ledger contains the three actions; the order may be {i-1, o-0, i-2}
    // or {o-0, i-1, i-2} depending on Stream.merge race timing, but the
    // SET is fixed and both inputs + the output are present.
    expect(new Set(result.state.dispatchedActionIds)).toEqual(
      new Set([
        "dispatched-input-i-1",
        "dispatched-input-i-2",
        "dispatched-output-ctx-1-0",
      ]),
    )
    expect(result.state.processedInputIds).toEqual(
      expect.arrayContaining(["i-1", "i-2"]),
    )
    expect(result.state.lastProcessedOutputSequence).toBe(0)
  })
})

// ── TEST 6 — cross-key concurrency ──────────────────────────────────────

describe("wave-d-a shape-b: cross-key concurrency", () => {
  it("dispatches handlers for distinct contextIds in parallel (no per-key starvation)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const substrate = yield* makeSubstrate()
        const fiber = yield* Effect.fork(
          runShapeBSubscriberMulti(
            substrate,
            ["ctx-a", "ctx-b"],
            identityKeyedHandler(substrate),
          ),
        )
        yield* appendInput(substrate, {
          inputId: "i-a-1",
          contextId: "ctx-a",
          kind: "message",
          payload: "hello",
        })
        yield* appendInput(substrate, {
          inputId: "i-b-1",
          contextId: "ctx-b",
          kind: "message",
          payload: "world",
        })
        yield* waitForCounter(substrate.handlerDispatches, (n) => n >= 2)
        yield* Fiber.interrupt(fiber)
        return {
          dispatches: yield* Ref.get(substrate.handlerDispatches),
          stateA: yield* loadState(substrate, "ctx-a"),
          stateB: yield* loadState(substrate, "ctx-b"),
        }
      }),
    )
    expect(result.dispatches).toBe(2)
    expect(result.stateA.processedInputIds).toEqual(["i-a-1"])
    expect(result.stateB.processedInputIds).toEqual(["i-b-1"])
  })
})
