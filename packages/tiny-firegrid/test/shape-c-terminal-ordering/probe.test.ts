// Shape C Wave C — terminal-completion ordering probe.
//
// Reproduces CC1's ordering gap and proves the existing
// `SessionLifecycleChannel` + `RuntimeRunEvent` durable row primitives
// close it.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Effect, Fiber, SubscriptionRef } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeRouter,
  makeSubstrate,
  reconcileOnce,
  type InternalHostStartHooks,
  type Substrate,
} from "../../src/simulations/shape-c-terminal-ordering/runtime.ts"
import {
  startSessionViaAgentOutput,
  startSessionViaLifecycle,
} from "../../src/simulations/shape-c-terminal-ordering/public-facade.ts"

// ── Scaffolding ────────────────────────────────────────────────────────

const SETTLEMENT_GAP_MS = 25

// `driveTurn` accepts an optional `capture` step that runs immediately
// AFTER the facade resolves and BEFORE the reconciler fiber is joined.
// The race CC1 reproduces is exactly that window: facade-return on raw
// agent_output happens before the durable runs.exited write settles.
// Capturing at that point is what makes the race visible.
const driveTurn = <Outcome, Captured>(
  substrate: Substrate,
  hooks: InternalHostStartHooks,
  drive: (router: ReturnType<typeof makeRouter>) => Effect.Effect<Outcome, Error>,
  capture: (substrate: Substrate) => Effect.Effect<Captured>,
) =>
  Effect.gen(function*() {
    const router = makeRouter(substrate)
    const reconcilerFiber = yield* Effect.fork(
      Effect.gen(function*() {
        for (let tick = 0; tick < 64; tick += 1) {
          const result = yield* reconcileOnce(substrate, hooks)
          if (result.drained > 0) return
          yield* Effect.sleep("3 millis")
        }
      }),
    )
    const outcome = yield* drive(router)
    // Snapshot the substrate at facade-return. This is the test's
    // observation point — the window between the facade's wait_for
    // resolving and any further internal writes settling.
    const captured = yield* capture(substrate)
    yield* Fiber.join(reconcilerFiber)
    return { outcome, captured }
  })

// ── 1. THE BUG (agent_output observation point races runs.exited) ──────

describe("shape-c-terminal-ordering: the bug — observing session.agent_output _tag:Terminated is racy", () => {
  it(
    "facade returns on agent_output Terminated BEFORE durable runs.exited row is present",
    async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const substrate = yield* makeSubstrate()
          return yield* driveTurn(
            substrate,
            { exitCode: 0, settlementDelayMs: SETTLEMENT_GAP_MS },
            (router) =>
              startSessionViaAgentOutput(router, { sessionId: "ctx_race_1" }),
            (s) => SubscriptionRef.get(s.runs),
          )
        }),
      )
      // The facade saw the agent_output Terminated event.
      expect(result.outcome.observed._tag).toBe("Terminated")
      // But the durable terminal fact was NOT yet present — the gap.
      expect(result.captured).toEqual([])
    },
  )
})

// ── 2. THE FIX (lifecycle observation point IS the durable terminal fact)

describe("shape-c-terminal-ordering: the fix — observing session.lifecycle binds to the durable runs.exited row", () => {
  it(
    "facade returns ONLY after the durable runs.exited row exists; no race",
    async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const substrate = yield* makeSubstrate()
          return yield* driveTurn(
            substrate,
            { exitCode: 0, settlementDelayMs: SETTLEMENT_GAP_MS },
            (router) =>
              startSessionViaLifecycle(router, { sessionId: "ctx_lifecycle_1" }),
            (s) => SubscriptionRef.get(s.runs),
          )
        }),
      )
      expect(result.outcome.observed.status).toBe("exited")
      expect(result.outcome.observed.exitCode).toBe(0)
      expect(result.captured.length).toBe(1)
      expect(result.captured[0]?.status).toBe("exited")
      expect(result.captured[0]?.contextId).toBe("ctx_lifecycle_1")
    },
  )

  it(
    "lifecycle observation point ignores the agent_output Terminated event entirely (no codec-derived synthesis)",
    async () => {
      // Even when an agent_output Terminated event lands first, the
      // lifecycle observation point fires AFTER the durable runs row
      // appears. Tests this by inspecting outputs + runs at completion.
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const substrate = yield* makeSubstrate()
          return yield* driveTurn(
            substrate,
            { exitCode: 0, settlementDelayMs: SETTLEMENT_GAP_MS },
            (router) =>
              startSessionViaLifecycle(router, { sessionId: "ctx_lifecycle_2" }),
            (s) => SubscriptionRef.get(s.outputs),
          )
        }),
      )
      // agent_output Terminated is present (the codec did emit it), but
      // it is NOT what the facade returned. The terminal contract is
      // the durable run-event row.
      expect(result.captured.some((row) => row.observation._tag === "Terminated")).toBe(
        true,
      )
      // Facade returned a RuntimeRunEvent (status field), not an
      // agent_output observation (_tag field).
      expect("status" in result.outcome.observed).toBe(true)
      expect(result.outcome.observed.status).toBe("exited")
    },
  )

  it(
    "lifecycle terminal fact survives observation cadence — facade can wait_for after runs.exited has already landed",
    async () => {
      // Snapshot-first ingress contract (cf. cannon C6 typed source +
      // cursor + match). The lifecycle route tails the durable runs
      // table — if the row is already there, observation matches
      // immediately. This proves the route is not a one-shot signal
      // but a durable-row tail.
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const substrate = yield* makeSubstrate()
          // Pre-seed: the runs.exited row already exists before the
          // facade starts waiting.
          yield* SubscriptionRef.update(substrate.runs, (rows) => [
            ...rows,
            {
              contextId: "ctx_lifecycle_late_1",
              activityAttempt: 1,
              status: "exited" as const,
              at: new Date(0).toISOString(),
              exitCode: 0,
            },
          ])
          const router = makeRouter(substrate)
          const observed = yield* router.dispatch.waitForLifecycle({
            sessionId: "ctx_lifecycle_late_1",
            afterStatuses: ["exited", "failed"],
          })
          return observed
        }),
      )
      expect(result.status).toBe("exited")
    },
  )
})

// ── 3. STRUCTURAL CANNON-C7 GUARD ───────────────────────────────────────

const simDir = resolve(
  import.meta.dirname,
  "../../src/simulations/shape-c-terminal-ordering",
)
const facadeSource = readFileSync(resolve(simDir, "public-facade.ts"), "utf8")
const runtimeSource = readFileSync(resolve(simDir, "runtime.ts"), "utf8")

describe("shape-c-terminal-ordering: structural cannon-C7 guard", () => {
  it(
    "the RIGHT-SHAPE facade entry-point dispatches lifecycle, not agent_output, for terminal",
    () => {
      // Body of startSessionViaLifecycle should reach waitForLifecycle —
      // structural check on the export.
      const startVia = facadeSource.indexOf("export const startSessionViaLifecycle")
      const nextExport = facadeSource.indexOf("\nexport ", startVia + 1)
      const body = facadeSource.slice(
        startVia,
        nextExport < 0 ? undefined : nextExport,
      )
      expect(body).toMatch(/dispatch\.waitForLifecycle\(/)
      expect(body).not.toMatch(/dispatch\.waitForAgentOutput\(/)
    },
  )

  it(
    "the facade does NOT synthesize a terminal `Done` tag from raw observation (C7)",
    () => {
      // Cannon C7 forbids edge-local construction of `{ _tag: \"Done\" }`
      // from raw observation. We assert no such literal exists in
      // either facade path.
      expect(facadeSource).not.toMatch(/_tag\s*:\s*"Done"/)
      // Negative: also no synthesis based on raw `TurnComplete`. Sim
      // doesn't have TurnComplete (collapsed into Terminated for
      // brevity), but the rule still translates: the wrong-shape
      // facade is the agent_output observer; the right-shape facade
      // is the lifecycle observer.
    },
  )

  it(
    "the lifecycle route streams the durable runs table (not the codec output stream)",
    () => {
      // runtime.ts's makeSessionLifecycleRoute pulls from `substrate.runs.changes`,
      // not `substrate.outputs.changes`. This is the structural reason
      // the ordering gap closes — the observation source IS the durable
      // terminal fact.
      const lifecycleRouteStart = runtimeSource.indexOf(
        "export const makeSessionLifecycleRoute",
      )
      const nextExport = runtimeSource.indexOf("\nexport ", lifecycleRouteStart + 1)
      const body = runtimeSource.slice(
        lifecycleRouteStart,
        nextExport < 0 ? undefined : nextExport,
      )
      expect(body).toMatch(/substrate\.runs\.changes/)
      expect(body).not.toMatch(/substrate\.outputs\.changes/)
    },
  )

  it(
    "the agent_output route streams the codec output (separate primitive from runs)",
    () => {
      // The two streams are independent — the gap is the time between
      // a codec write and a durable runs.exited write.
      const agentOutputRouteStart = runtimeSource.indexOf(
        "export const makeSessionAgentOutputRoute",
      )
      const nextExport = runtimeSource.indexOf(
        "\nexport ",
        agentOutputRouteStart + 1,
      )
      const body = runtimeSource.slice(
        agentOutputRouteStart,
        nextExport < 0 ? undefined : nextExport,
      )
      expect(body).toMatch(/substrate\.outputs\.changes/)
      expect(body).not.toMatch(/substrate\.runs\.changes/)
    },
  )
})

// ── 4. PRODUCTION SYMBOL MAPPING ───────────────────────────────────────

describe("shape-c-terminal-ordering: production symbol mapping", () => {
  it(
    "documents the existing production primitives the FINDING.md names",
    () => {
      const finding = readFileSync(resolve(simDir, "FINDING.md"), "utf8")
      // Existing production handles the verdict rests on:
      expect(finding).toContain("RuntimeRunEventSchema")
      expect(finding).toContain("SessionLifecycleChannel")
      expect(finding).toContain("RuntimeRunAppendAndGet")
      expect(finding).toContain("recordExited")
      // Cannon reference:
      expect(finding).toContain("C7")
      // Verdict + the production change the FINDING prescribes:
      expect(finding).toContain("Verdict: GREEN")
      expect(finding).toContain("session.lifecycle")
    },
  )
})
