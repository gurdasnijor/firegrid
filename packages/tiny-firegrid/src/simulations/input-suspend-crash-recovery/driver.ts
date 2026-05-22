import { Console, Effect } from "effect"
import {
  type ClockProbeResult,
  type ProbeResult,
  s1Runtime,
} from "./host.ts"

interface S1Verdict {
  readonly verdict: "GREEN"
  readonly probeA: ProbeResult
  readonly probeB: ProbeResult
  readonly probeC: ClockProbeResult
}

const assertInvariant = (
  condition: boolean,
  message: string,
  detail: unknown,
) =>
  condition
    ? Effect.void
    : Effect.fail(new Error(
      `S1 input-suspend-crash-recovery invariant failed: ${message}; ${
        JSON.stringify(detail)
      }`,
    ))

export const inputSuspendCrashRecoveryDriver:
  Effect.Effect<S1Verdict, unknown> = Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => s1Runtime)

    const probeA = yield* runtime.runProbeA
    const probeB = yield* runtime.runProbeB
    const probeC = yield* runtime.runProbeC

    // === Probe A assertions: the lost-wakeup gap ===
    yield* assertInvariant(
      probeA.afterRestart.executionExists && probeA.afterRestart.suspended === true,
      "probe A: execution row did not survive reconstruction as suspended",
      probeA.afterRestart,
    )
    yield* assertInvariant(
      !probeA.afterRestart.processed && !probeA.afterRestart.hasFinalResult,
      "probe A FALSIFIED gap: reconstruction processed the input without a resume",
      probeA.afterRestart,
    )
    yield* assertInvariant(
      probeA.afterRedrive.processed &&
        probeA.afterRedrive.hasFinalResult &&
        probeA.redriveValue === "delivered-by-A" &&
        probeA.afterRedrive.processedValue === "delivered-by-A",
      "probe A: replaying the lost resume did not recover the parked body",
      probeA,
    )

    // === Probe B assertions: no restart re-arm sweep ===
    yield* assertInvariant(
      !probeB.afterRestart.processed && !probeB.afterRestart.hasFinalResult,
      "probe B FALSIFIED gap: reconstruction alone re-armed the parked body",
      probeB.afterRestart,
    )
    yield* assertInvariant(
      probeB.afterRedrive.processed &&
        probeB.afterRedrive.hasFinalResult &&
        probeB.redriveValue === "delivered-by-B",
      "probe B: a single external re-drive did not recover the parked body",
      probeB,
    )

    // === Probe C assertions: clock auto-recovery contrast ===
    yield* assertInvariant(
      probeC.suspendedBeforeCrash && probeC.pendingClockWakeupBeforeCrash === 1,
      "probe C: clock body did not park with a pending wakeup before crash",
      probeC,
    )
    yield* assertInvariant(
      probeC.autoCompletedAfterRestart,
      "probe C: clock wakeup did NOT auto-fire on reconstruction (contrast broken)",
      probeC,
    )

    const verdict: S1Verdict = { verdict: "GREEN", probeA, probeB, probeC }

    yield* Effect.annotateCurrentSpan({
      "firegrid.s1.verdict": verdict.verdict,
      "firegrid.s1.probe_a.gap_confirmed": !probeA.afterRestart.processed,
      "firegrid.s1.probe_a.recovered_by_resume": probeA.afterRedrive.processed,
      "firegrid.s1.probe_b.no_rearm_on_reconstruction": !probeB.afterRestart.processed,
      "firegrid.s1.probe_b.recovered_by_redrive": probeB.afterRedrive.processed,
      "firegrid.s1.probe_c.clock_auto_recovers": probeC.autoCompletedAfterRestart,
    })

    yield* Console.log(
      [
        `S1 input-suspend-crash-recovery: ${verdict.verdict}`,
        "",
        "  axis-2 durability gap — EMPIRICALLY CONFIRMED (CC3 inference holds):",
        "  Probe A (crash between write & resume):",
        `    before crash:  parked=${probeA.beforeCrash.suspended} deferreds=${probeA.beforeCrash.deferredCount}`,
        `    after restart: processed=${probeA.afterRestart.processed} (input durable, body NEVER ran) <- GAP`,
        `    after resume:  processed=${probeA.afterRedrive.processed} value=${probeA.redriveValue} <- recovered`,
        "  Probe B (restart while parked, input present):",
        `    after restart: processed=${probeB.afterRestart.processed} (reconstruction alone did NOT re-arm) <- GAP`,
        `    after redrive: processed=${probeB.afterRedrive.processed} value=${probeB.redriveValue} <- recovered`,
        "  Probe C (clock contrast control):",
        `    clock parked with pending wakeup=${probeC.pendingClockWakeupBeforeCrash}`,
        `    after restart (NO resume): auto-completed=${probeC.autoCompletedAfterRestart} <- engine DOES recover clocks`,
        "",
        "  => table-wait suspensions need an explicit re-drive on restart that",
        "     clocks already get via recoverPendingClockWakeups. The fix is the",
        "     symmetric mechanism: a restart pending-suspension recovery sweep",
        "     and/or a kernel-owned writer that owns write+arm as one step.",
      ].join("\n"),
    )

    return verdict
  }).pipe(
    Effect.withSpan("firegrid.s1.verdict", {
      kind: "internal",
      attributes: {
        "firegrid.s1.scope": "input-suspend-crash-recovery",
      },
    }),
  )
