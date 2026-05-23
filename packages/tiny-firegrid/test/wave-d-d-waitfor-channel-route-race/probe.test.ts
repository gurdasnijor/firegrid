// Wave D-D migration probe: WaitForWorkflow rewrite shape — single-source +
// N-source race + timeout, all driven by `router.dispatch wait_for` cursor-
// advance loops, NOT `Stream.runHead(RuntimeObservationStreams.X)`.
//
// See ../../src/simulations/wave-d-d-waitfor-channel-route-race/probe.ts for
// the falsification target.

import { Effect, Fiber, Option } from "effect"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  asObservation,
  asRunEvent,
  isMatch,
  isTimeout,
  lifecycleExited,
  lifecycleStarted,
  makeRouteHarness,
  matchOnRoute,
  matchOrTimeoutOnRoutes,
  sourceAgentOutputAfter,
  sourceLifecycle,
  textChunk,
  turnComplete,
  type WaitForOutcome,
} from "../../src/simulations/wave-d-d-waitfor-channel-route-race/probe.ts"

// Test-local typed assertion: vitest expect rejects mismatch; this helper
// gives the test a typed `Match` so subsequent `.raw` / `.winnerIndex`
// access is non-`any`.
const expectMatch = (
  outcome: WaitForOutcome,
): Extract<WaitForOutcome, { readonly _tag: "Match" }> => {
  expect(isMatch(outcome)).toBe(true)
  return outcome as Extract<WaitForOutcome, { readonly _tag: "Match" }>
}
const expectObservation = (raw: unknown) => {
  const obs = asObservation(raw)
  expect(obs).toBeDefined()
  return obs!
}
const expectRunEvent = (raw: unknown) => {
  const ev = asRunEvent(raw)
  expect(ev).toBeDefined()
  return ev!
}

const CHILD_A = "child_a"
const CHILD_B = "child_b"

const probeSource = readFileSync(
  resolve(
    import.meta.dirname,
    "../../src/simulations/wave-d-d-waitfor-channel-route-race/probe.ts",
  ),
  "utf8",
)
const probeImports = (() => {
  const start = probeSource.indexOf("\nimport ")
  if (start < 0) throw new Error("probe.ts has no import block")
  const end = probeSource.indexOf("\n\n// -", start)
  return probeSource.slice(start, end < 0 ? undefined : end)
})()

describe("Wave D-D — WaitForWorkflow channel-route race migration shape", () => {
  describe("no-new-primitive gate (structural × 3)", () => {
    it("does NOT import RuntimeObservationStreams / streams subpath / CallerFact*", () => {
      expect(probeImports).not.toMatch(/RuntimeObservationStreams/)
      expect(probeImports).not.toMatch(/RuntimeObservationStreamsLive/)
      expect(probeImports).not.toMatch(/CallerOwnedFactStreams/)
      expect(probeImports).not.toMatch(/CallerFactObservationSource/)
      expect(probeImports).not.toMatch(/@firegrid\/runtime\/streams/)
    })

    it("does NOT import WaitForWorkflow / wait-router (we're proving the rewrite shape)", () => {
      expect(probeImports).not.toMatch(/\bWaitForWorkflow\b/)
      expect(probeImports).not.toMatch(/\bWaitForWorkflowLayer\b/)
      expect(probeImports).not.toMatch(/\bwait-router\b/)
    })

    it("reuses ONLY @firegrid/runtime/channels for the route dispatch surface", () => {
      const runtimeImports = [
        ...probeImports.matchAll(/from\s+["'](@firegrid\/runtime[^"']*)["']/g),
      ].map(match => match[1])
      expect(new Set(runtimeImports)).toEqual(new Set(["@firegrid/runtime/channels"]))
    })
  })

  describe("Invariant 1 — single-source filter correctness", () => {
    it("advances cursor on non-matching observations, settles on first match (TurnComplete)", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* makeRouteHarness
          yield* harness.emitAgentOutput(CHILD_A, textChunk(CHILD_A, 0, "a"))
          yield* harness.emitAgentOutput(CHILD_A, textChunk(CHILD_A, 1, "b"))
          yield* harness.emitAgentOutput(CHILD_A, turnComplete(CHILD_A, 2))

          const raw = yield* matchOnRoute(
            harness.router,
            sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete"),
          )
          const obs = expectObservation(raw)
          expect(obs.sequence).toBe(2)
          expect(obs._tag).toBe("TurnComplete")
        }),
      ))

    it("parks at the frontier until the matching arrival, then settles (subscribe-after-cursor)", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* makeRouteHarness
          yield* harness.emitAgentOutput(CHILD_A, textChunk(CHILD_A, 0, "pre"))

          const fiber = yield* Effect.fork(
            matchOnRoute(
              harness.router,
              sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete"),
            ),
          )
          yield* Effect.sleep("25 millis")
          // No match yet: blocked-pending.
          expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true)

          yield* harness.emitAgentOutput(CHILD_A, turnComplete(CHILD_A, 1))
          const woken = yield* Fiber.join(fiber)
          expect(expectObservation(woken).sequence).toBe(1)
        }),
      ))
  })

  describe("Invariant 2 — N-source race correctness (wait_for_any shape)", () => {
    it("returns the winning source's match + index; losing sources do not deliver duplicates", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* makeRouteHarness
          // Two sources: child_a TurnComplete, child_b TurnComplete.
          // Producer emits the match on child_b first → winner index 1.
          yield* harness.emitAgentOutput(CHILD_B, turnComplete(CHILD_B, 0))
          // (child_a emits no terminal — should NOT race-fire.)

          const outcome = yield* matchOrTimeoutOnRoutes(harness.router, [
            sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete"),
            sourceAgentOutputAfter(CHILD_B, -1, "TurnComplete"),
          ])
          const match = expectMatch(outcome)
          expect(match.winnerIndex).toBe(1)
          const obs = expectObservation(match.raw)
          expect(obs.sessionId).toBe(CHILD_B)
        }),
      ))

    it("races AgentOutput against Lifecycle (heterogeneous channel targets in one race)", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* makeRouteHarness

          // Lifecycle emits started first (skipped by terminal route seek).
          yield* harness.emitLifecycle(CHILD_A, lifecycleStarted(CHILD_A))
          yield* Effect.sleep("5 millis")
          // Then AgentOutput emits the TurnComplete → wins.
          yield* harness.emitAgentOutput(CHILD_A, turnComplete(CHILD_A, 0))

          const outcome = yield* matchOrTimeoutOnRoutes(harness.router, [
            sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete"),
            sourceLifecycle(CHILD_A),
          ])
          const match = expectMatch(outcome)
          expect(match.winnerIndex).toBe(0)
          expect(expectObservation(match.raw)._tag).toBe("TurnComplete")
        }),
      ))

    it("Lifecycle wins when its terminal arrives first; AgentOutput non-matches are advanced through", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* makeRouteHarness

          // AgentOutput emits non-matching rows; Lifecycle emits terminal exited.
          yield* harness.emitAgentOutput(CHILD_A, textChunk(CHILD_A, 0, "x"))
          yield* harness.emitAgentOutput(CHILD_A, textChunk(CHILD_A, 1, "y"))
          yield* harness.emitLifecycle(CHILD_A, lifecycleStarted(CHILD_A))
          yield* harness.emitLifecycle(CHILD_A, lifecycleExited(CHILD_A, 0))

          const outcome = yield* matchOrTimeoutOnRoutes(harness.router, [
            sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete"),
            sourceLifecycle(CHILD_A),
          ])
          const match = expectMatch(outcome)
          expect(match.winnerIndex).toBe(1)
          const ev = expectRunEvent(match.raw)
          expect(ev.status).toBe("exited")
        }),
      ))
  })

  describe("Invariant 3 — restart safety (Activity re-run after host crash)", () => {
    it("interrupting the in-flight race AND re-issuing it re-finds the SAME match (snapshot-first, no stale duplicate)", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* makeRouteHarness

          // Pre-crash: non-matching observation only.
          yield* harness.emitAgentOutput(CHILD_A, textChunk(CHILD_A, 0, "pre-crash"))

          // Arm the race; before any match arrives, interrupt the fiber
          // (mimicking the host process dying with an in-flight Activity).
          const inFlight = yield* Effect.fork(
            matchOrTimeoutOnRoutes(harness.router, [
              sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete"),
            ]),
          )
          yield* Effect.sleep("10 millis")
          yield* Fiber.interrupt(inFlight)

          // Post-crash: matching arrival. Re-run the same Activity body.
          yield* harness.emitAgentOutput(CHILD_A, turnComplete(CHILD_A, 1))
          const outcome = yield* matchOrTimeoutOnRoutes(harness.router, [
            sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete"),
          ])
          const match = expectMatch(outcome)
          expect(match.winnerIndex).toBe(0)
          expect(expectObservation(match.raw).sequence).toBe(1)
        }),
      ))

    it("restart-replay over a settled wait does not produce a duplicate match (cursor-advance idempotent over snapshots)", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* makeRouteHarness
          yield* harness.emitAgentOutput(CHILD_A, turnComplete(CHILD_A, 0))

          // First run: settles immediately on the snapshot.
          const first = yield* matchOrTimeoutOnRoutes(harness.router, [
            sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete"),
          ])
          const firstMatch = expectMatch(first)
          expect(expectObservation(firstMatch.raw).sequence).toBe(0)

          // Restart replay: re-running the SAME Activity body re-finds the
          // SAME row from the snapshot. (The production cutover wraps this
          // in `Activity.make` whose journal returns the cached outcome on
          // replay; the underlying body is shown here to be idempotent.)
          const second = yield* matchOrTimeoutOnRoutes(harness.router, [
            sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete"),
          ])
          const secondMatch = expectMatch(second)
          expect(expectObservation(secondMatch.raw).sequence).toBe(0)
        }),
      ))
  })

  describe("Invariant 4 — timeout race (Effect.race vs Effect.sleep)", () => {
    it("no matching arrival within timeoutMs → Timeout outcome", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* makeRouteHarness
          yield* harness.emitAgentOutput(CHILD_A, textChunk(CHILD_A, 0, "no-match"))

          const outcome = yield* matchOrTimeoutOnRoutes(
            harness.router,
            [sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete")],
            25,
          )
          expect(isTimeout(outcome)).toBe(true)
        }),
      ))

    it("matching arrival within timeoutMs → Match wins the race", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* makeRouteHarness
          yield* harness.emitAgentOutput(CHILD_A, turnComplete(CHILD_A, 0))

          const outcome = yield* matchOrTimeoutOnRoutes(
            harness.router,
            [sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete")],
            // Wide enough that the match clearly wins.
            5000,
          )
          const match = expectMatch(outcome)
          expect(expectObservation(match.raw).sequence).toBe(0)
        }),
      ))

    it("Timeout wins over a slow, non-matching producer (deterministic timeout outcome)", () =>
      Effect.runPromise(
        Effect.gen(function*() {
          const harness = yield* makeRouteHarness
          // Producer never emits a matching row in the test window.
          const outcome = yield* matchOrTimeoutOnRoutes(
            harness.router,
            [
              sourceAgentOutputAfter(CHILD_A, -1, "TurnComplete"),
              sourceLifecycle(CHILD_A),
            ],
            10,
          )
          expect(isTimeout(outcome)).toBe(true)
        }),
      ))
  })
})
