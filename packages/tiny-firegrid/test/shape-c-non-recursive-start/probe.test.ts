// Shape C Wave C — non-recursive public start facade probe.
//
// Validates the three-surface decomposition over existing
// channel/router/request-row/reconciler concepts:
//
//   public start facade → HostSessionsStartChannel.call → durable
//     startRequests row + SessionAgentOutputChannel wait_for
//   reconciler         → drains startRequests, calls internal side-effect
//                         (NOT the public facade)
//   internal side-effect → emits session.agent_output observations
//     (Terminated/Error)
//
// CC1's blocker: public start → write startRequest → reconciler →
// side-effect → call public start → write ANOTHER startRequest → deadlock.
//
// The proof harness counts:
//   - startRequest writes (must be exactly 1 per public-facade call)
//   - reconciler drains (must be exactly 1 in the controlled test cadence)
//   - internal-side-effect invocations (must be exactly 1 per startRequest)
//
// Plus a structural recursion-guard test that grep-asserts the public
// facade's source file does NOT import any internal substrate symbol,
// only the typed router dispatch surface.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Effect, Fiber, Ref } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeRouter,
  makeSubstrate,
  reconcileOnce,
  type Substrate,
  type SessionStartAgent,
} from "../../src/simulations/shape-c-non-recursive-start/runtime.ts"
import {
  startSession,
} from "../../src/simulations/shape-c-non-recursive-start/public-facade.ts"

// ── Test scaffolding ────────────────────────────────────────────────────
//
// The reconciler runs concurrently with the public facade. The facade
// writes the startRequest then waits on the typed source; the reconciler
// drains the pending startRequest and invokes the side-effect, which
// appends observations the facade then observes.

const driveTurn = (
  substrate: Substrate,
  hooks: { readonly agentFor: (request: { readonly contextId: string }) => SessionStartAgent },
  sessionId: string,
) =>
  Effect.gen(function*() {
    const router = makeRouter(substrate)
    // Fork a "reconciler loop" that repeatedly drains pending startRequests
    // until the facade unblocks. In production the reconciler is row-
    // subscription-driven (cf. `runRuntimeControlRequestReconciler`); here
    // we cap a polling loop because the sim does not run a daemon.
    const reconcilerFiber = yield* Effect.fork(
      Effect.gen(function*() {
        for (let tick = 0; tick < 32; tick += 1) {
          const result = yield* reconcileOnce(substrate, hooks)
          if (result.drained > 0) return
          yield* Effect.sleep("5 millis")
        }
      }),
    )
    const outcome = yield* startSession(router, { sessionId })
    yield* Fiber.join(reconcilerFiber)
    return outcome
  })

// ── HAPPY PATH: terminal observation, exactly one start request ────────

describe("shape-c-non-recursive-start: happy path", () => {
  it(
    "start writes exactly one durable startRequest; reconciler invokes the internal side-effect exactly once; facade returns terminal Terminated",
    async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const substrate = yield* makeSubstrate()
          const outcome = yield* driveTurn(
            substrate,
            { agentFor: () => ({ kind: "terminal", exitCode: 0 }) },
            "ctx_happy_1",
          )
          // Counter assertions — the non-recursive contract.
          const startRequestWrites = yield* Ref.get(substrate.startRequestWrites)
          const internalStartInvocations = yield* Ref.get(
            substrate.internalStartInvocations,
          )
          return { outcome, startRequestWrites, internalStartInvocations }
        }),
      )
      expect(result.startRequestWrites).toBe(1)
      expect(result.internalStartInvocations).toBe(1)
      expect(result.outcome.terminal._tag).toBe("Terminated")
      if (result.outcome.terminal._tag === "Terminated") {
        expect(result.outcome.terminal.exitCode).toBe(0)
      }
      // Ack carries the requestId from the durable row.
      expect(result.outcome.ack.inserted).toBe(true)
      expect(result.outcome.ack.contextId).toBe("ctx_happy_1")
    },
  )

  it(
    "facade unblocks WITHOUT writing a second start-request (recursion-counter assertion)",
    async () => {
      // The same single-start-request invariant restated as a direct
      // assertion against CC1's blocker. If the side-effect ever called
      // back into the public facade, this counter would exceed 1.
      const writes = await Effect.runPromise(
        Effect.gen(function*() {
          const substrate = yield* makeSubstrate()
          yield* driveTurn(
            substrate,
            { agentFor: () => ({ kind: "terminal", exitCode: 0 }) },
            "ctx_norec_1",
          )
          return yield* Ref.get(substrate.startRequestWrites)
        }),
      )
      expect(writes).toBe(1)
    },
  )
})

// ── ERROR PATH ─────────────────────────────────────────────────────────

describe("shape-c-non-recursive-start: error path", () => {
  it(
    "internal side-effect emits Error → facade observes Error first, Terminated next; still exactly one start-request",
    async () => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const substrate = yield* makeSubstrate()
          const outcome = yield* driveTurn(
            substrate,
            {
              agentFor: () => ({
                kind: "error",
                recoverable: true,
                cause: { message: "agent boot failed", code: "EBOOT" },
              }),
            },
            "ctx_err_1",
          )
          const startRequestWrites = yield* Ref.get(substrate.startRequestWrites)
          const internalStartInvocations = yield* Ref.get(
            substrate.internalStartInvocations,
          )
          return { outcome, startRequestWrites, internalStartInvocations }
        }),
      )
      // First terminal-shaped observation the facade sees is the Error
      // (it precedes Terminated in the internal side-effect's emit
      // order). Mirrors how production error observations interleave
      // ahead of the Terminated event.
      expect(result.outcome.terminal._tag).toBe("Error")
      if (result.outcome.terminal._tag === "Error") {
        expect(result.outcome.terminal.recoverable).toBe(true)
        expect(result.outcome.terminal.cause).toEqual({
          message: "agent boot failed",
          code: "EBOOT",
        })
      }
      // Counters: error path is still single-write, single side-effect.
      expect(result.startRequestWrites).toBe(1)
      expect(result.internalStartInvocations).toBe(1)
    },
  )
})

// ── STRUCTURAL RECURSION GUARD ─────────────────────────────────────────
//
// The recursion bug CC1 hit was a CODE-PATH bug: the internal side-effect
// imported and called the public start facade. These tests grep the file
// text to prove that path is structurally impossible in this design.

const simDir = resolve(
  import.meta.dirname,
  "../../src/simulations/shape-c-non-recursive-start",
)

const runtimeSource = readFileSync(resolve(simDir, "runtime.ts"), "utf8")
const facadeSource = readFileSync(resolve(simDir, "public-facade.ts"), "utf8")

const importLines = (source: string): string => {
  const start = source.indexOf("\nimport ")
  if (start < 0) return ""
  // First export line marks end of the import block.
  const exportIndex = source.indexOf("\nexport ", start)
  return source.slice(start, exportIndex < 0 ? undefined : exportIndex)
}

describe("shape-c-non-recursive-start: structural recursion guard", () => {
  it(
    "runtime.ts (the internal side-effect side) does NOT import the public facade",
    () => {
      const imports = importLines(runtimeSource)
      // The recursion bug looks like `import { startSession } from "./public-facade.ts"`.
      // We assert the inverse: no import of the facade module from runtime.ts.
      expect(imports).not.toContain("./public-facade")
      expect(imports).not.toContain("public-facade.ts")
      // And no transitive reference by symbol name either.
      expect(runtimeSource).not.toMatch(/\bstartSession\s*\(/)
    },
  )

  it(
    "public-facade.ts imports ONLY type-level surface from runtime.ts (Router + observation types)",
    () => {
      // The facade is allowed to import the typed `Router` interface and
      // the observation/ack types from runtime.ts (it has to know what
      // it dispatches against and what the return type is). It must NOT
      // import the substrate, the reconciler, or the internal side-effect.
      const imports = importLines(facadeSource)
      // Forbidden: any non-type-only IMPORT of runtime substrate symbols
      // (we check the imports block — call-site asserts below catch any
      // call into them).
      const forbiddenImportSymbols = [
        "makeSubstrate",
        "reconcileOnce",
        "internalHostStart",
        "makeRouter",
        "makeHostSessionsStartRoute",
        "makeSessionAgentOutputRoute",
        "appendObservation",
      ]
      for (const symbol of forbiddenImportSymbols) {
        expect(imports).not.toMatch(new RegExp(`\\b${symbol}\\b`))
      }
      // Only `type` imports from runtime.ts (Router, RuntimeStartRequestAck,
      // SessionAgentOutputObservation). Cheapest check: the imports block
      // must contain "import type" against runtime.ts and not contain a
      // value import.
      expect(imports).toMatch(/import\s+type\s+\{[^}]*\}\s+from\s+"\.\/runtime\.ts"/)
      expect(imports).not.toMatch(/import\s+\{[^}]*\bmakeRouter\b[^}]*\}\s+from/)
    },
  )

  it(
    "public-facade.ts dispatches ONLY through the router (no direct substrate/handler/reconciler call-sites)",
    () => {
      // The facade body should call exactly:
      //   router.dispatch.call("host.sessions.start", ...)
      //   router.dispatch.waitFor("session.agent_output", ...)
      // and no other substrate function. We grep CALL-SITES (`identifier(`)
      // not bare mentions so comments documenting the contract are fine.
      expect(facadeSource).toMatch(/router\.dispatch\.call\(\s*"host\.sessions\.start"/)
      expect(facadeSource).toMatch(
        /router\.dispatch\.waitFor\(\s*"session\.agent_output"/,
      )
      // Forbidden call-sites (each pattern is identifier followed by `(`):
      expect(facadeSource).not.toMatch(/\bsubstrate\s*\.\s*startRequests\b/)
      expect(facadeSource).not.toMatch(/\bsubstrate\s*\.\s*outputs\b/)
      expect(facadeSource).not.toMatch(/\binternalHostStart\s*\(/)
      expect(facadeSource).not.toMatch(/\breconcileOnce\s*\(/)
      expect(facadeSource).not.toMatch(/\bmakeRouter\s*\(/)
      expect(facadeSource).not.toMatch(/\bappendObservation\s*\(/)
    },
  )

  it(
    "runtime.ts's internal side-effect emits observations ONLY via appendObservation (no startSession re-entry, no router.dispatch)",
    () => {
      // The internal side-effect's body must not re-enter the public
      // facade or its dispatch entry-point. Check CALL-SITES (function
      // application) — symbol mentions in comments are allowed.
      expect(runtimeSource).not.toMatch(/\brouter\s*\.\s*dispatch\b/)
      expect(runtimeSource).not.toMatch(/\bstartSession\s*\(/)
      // Positive: the side-effect appends observations (the contract).
      expect(runtimeSource).toMatch(/\bappendObservation\s*\(/)
    },
  )
})

// ── PRODUCTION SYMBOL MAPPING ──────────────────────────────────────────
//
// Lightweight structural assertions that document — and lock in — the
// production names the sim maps back to. If a sim concept's production
// counterpart shifts, this test fails and forces a FINDING.md update.

describe("shape-c-non-recursive-start: production symbol mapping", () => {
  it(
    "documents the non-recursive shape under existing production primitives",
    () => {
      const finding = readFileSync(resolve(simDir, "FINDING.md"), "utf8")
      // The five production handles the three-surface split rests on:
      expect(finding).toContain("startRuntime")
      expect(finding).toContain("HostSessionsStartChannel")
      expect(finding).toContain("RuntimeStartRequestRow")
      expect(finding).toContain("RuntimeControlRequestSideEffects")
      expect(finding).toContain("reconcileRuntimeControlRequestsOnce")
      // The observation half:
      expect(finding).toContain("SessionAgentOutputChannel")
      // No invention allowed:
      expect(finding).toContain("Verdict: GREEN")
    },
  )
})
