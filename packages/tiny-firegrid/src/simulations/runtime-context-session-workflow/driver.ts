import { Console, Effect } from "effect"
import { rcswRuntime, type RcswProbeResult } from "./host.ts"

interface RcswVerdict {
  readonly verdict: "GREEN"
  readonly probeA: RcswProbeResult
  readonly probeB: RcswProbeResult
  readonly probeC: RcswProbeResult
}

const assertInvariant = (
  condition: boolean,
  message: string,
  detail: unknown,
) =>
  condition
    ? Effect.void
    : Effect.fail(new Error(
      `rcsw invariant failed: ${message}; ${JSON.stringify(detail)}`,
    ))

// Per-(contextId, activityAttempt) Workflow.make with idempotencyKey + an
// Activity-memoized spawn must:
//   A. consume an input appended BEFORE execute (no live-tail-lost-row),
//   B. collapse concurrent executes to ONE execution and ONE spawn,
//   C. consume inputs delivered AFTER execute (kernel write+arm) in append
//      order, each via one Activity send, spawn STILL == 1.
export const runtimeContextSessionWorkflowDriver: Effect.Effect<RcswVerdict, unknown> =
  Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => rcswRuntime)

    const probeA = yield* runtime.runProbeA
    yield* Console.log(`[rcsw] probe A: ${probeA.notes.join(" | ")}`)
    yield* assertInvariant(
      probeA.recording.spawns.length === 1,
      "probe A: spawn count != 1",
      probeA.recording.spawns,
    )
    yield* assertInvariant(
      probeA.recording.sends.length === 1
        && probeA.recording.sends[0]!.inputId === "input-A0"
        && probeA.recording.sends[0]!.value === "early",
      "probe A: did not consume pre-existing input",
      probeA.recording.sends,
    )
    yield* assertInvariant(
      probeA.inputsConsumed === 1,
      "probe A: workflow finalResult.inputsConsumed != 1",
      probeA.inputsConsumed,
    )

    const probeB = yield* runtime.runProbeB
    yield* Console.log(`[rcsw] probe B: ${probeB.notes.join(" | ")}`)
    yield* assertInvariant(
      probeB.recording.spawns.length === 1,
      "probe B: dual-spawn race — concurrent executes spawned more than one session",
      probeB.recording.spawns,
    )
    yield* assertInvariant(
      probeB.recording.sends.length === 1
        && probeB.recording.sends[0]!.inputId === "input-B0",
      "probe B: shared input was sent more than once OR not at all",
      probeB.recording.sends,
    )
    yield* assertInvariant(
      probeB.inputsConsumed === 1,
      "probe B: workflow inputsConsumed != 1 (idempotencyKey did not collapse)",
      probeB.inputsConsumed,
    )

    const probeC = yield* runtime.runProbeC
    yield* Console.log(`[rcsw] probe C: ${probeC.notes.join(" | ")}`)
    yield* assertInvariant(
      probeC.recording.spawns.length === 1,
      "probe C: spawn fired more than once across resume/reconstruct",
      probeC.recording.spawns,
    )
    yield* assertInvariant(
      probeC.recording.sends.length === 3,
      "probe C: send count != 3 (expected one send per appended input)",
      probeC.recording.sends,
    )
    yield* assertInvariant(
      probeC.recording.sends.map((s) => s.inputId).join(",") === "C-0,C-1,C-2",
      "probe C: send order does not match append order",
      probeC.recording.sends,
    )
    yield* assertInvariant(
      probeC.inputsConsumed === 3,
      "probe C: workflow inputsConsumed != 3",
      probeC.inputsConsumed,
    )

    return { verdict: "GREEN" as const, probeA, probeB, probeC }
  }).pipe(Effect.withSpan("firegrid.rcsw.driver"))
