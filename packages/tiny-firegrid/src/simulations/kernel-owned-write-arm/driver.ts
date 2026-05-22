import { Console, Effect } from "effect"
import {
  type SoundnessProbeResult,
  type WriteArmProbeResult,
  kwaRuntime,
} from "./host.ts"

interface KwaVerdict {
  readonly verdict: "GREEN"
  readonly probeA: WriteArmProbeResult
  readonly probeB: WriteArmProbeResult
  readonly probeC: SoundnessProbeResult
}

const assertInvariant = (condition: boolean, message: string, detail: unknown) =>
  condition
    ? Effect.void
    : Effect.fail(new Error(
      `kernel-owned-write-arm invariant failed: ${message}; ${JSON.stringify(detail)}`,
    ))

// tf-c9r9 acceptance: the kernel-owned write+arm controller recovers parked
// table-wait bodies after reconstruction THROUGH THE KERNEL PATH (its restart
// replay of owned pending facts), with no explicit driver re-drive — and it does
// so WITHOUT a generic resume-all sweep, so a deferred-await execution it owns no
// fact for stays untouched (Probe C). No deferred mailbox is used by the bodies.
export const kernelOwnedWriteArmDriver: Effect.Effect<KwaVerdict, unknown> =
  Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => kwaRuntime)

    const probeA = yield* runtime.runProbeA
    const probeB = yield* runtime.runProbeB
    const probeC = yield* runtime.runProbeC

    // === Probe A: arm lost mid-write+arm, recovered by the kernel replay ===
    yield* assertInvariant(
      probeA.beforeCrash.suspended === true &&
        !probeA.beforeCrash.hasFinalResult &&
        probeA.beforeCrash.deferredCount === 0,
      "probe A: body did not park as a table-wait (no deferred) before crash",
      probeA.beforeCrash,
    )
    yield* assertInvariant(
      probeA.autoRecovered &&
        probeA.afterRecovery.processed &&
        probeA.afterRecovery.hasFinalResult &&
        probeA.afterRecovery.processedValue === "delivered-by-A" &&
        probeA.recoveredValue === "delivered-by-A",
      "probe A: kernel replay did not recover the parked body through the write+arm fact",
      probeA,
    )

    // === Probe B: arm issued, body unfinished, re-armed by the kernel replay ===
    yield* assertInvariant(
      probeB.beforeCrash.suspended === true && !probeB.beforeCrash.hasFinalResult,
      "probe B: body did not park before crash",
      probeB.beforeCrash,
    )
    yield* assertInvariant(
      probeB.autoRecovered &&
        probeB.afterRecovery.processed &&
        probeB.afterRecovery.hasFinalResult &&
        probeB.afterRecovery.processedValue === "delivered-by-B" &&
        probeB.recoveredValue === "delivered-by-B",
      "probe B: kernel replay did not re-arm/recover the parked body",
      probeB,
    )

    // === Probe C: soundness — kernel replay is bounded to owned facts ===
    yield* assertInvariant(
      probeC.deferredSuspendedBeforeCrash,
      "probe C: deferred-await body did not park before crash",
      probeC,
    )
    yield* assertInvariant(
      probeC.deferredUntouchedByReplay,
      "probe C FALSIFIED soundness: kernel replay touched a deferred-await execution it owns no fact for (generic sweep)",
      probeC,
    )
    yield* assertInvariant(
      probeC.recoveredViaOwnPath,
      "probe C: deferred-await did not recover via its own deferredDone path",
      probeC,
    )

    const verdict: KwaVerdict = { verdict: "GREEN", probeA, probeB, probeC }

    yield* Effect.annotateCurrentSpan({
      "firegrid.kwa.verdict": verdict.verdict,
      "firegrid.kwa.probe_a.recovered_by_kernel_replay": probeA.autoRecovered,
      "firegrid.kwa.probe_b.recovered_by_kernel_replay": probeB.autoRecovered,
      "firegrid.kwa.probe_c.deferred_untouched_by_replay": probeC.deferredUntouchedByReplay,
    })

    yield* Console.log(
      [
        `kernel-owned-write-arm: ${verdict.verdict}`,
        "",
        "  target shape: workflow-owned TABLE input + kernel-owned write+arm,",
        "  no deferred mailbox, no generic resume-all sweep, no ordering authority.",
        "  Probe A (crash between write & arm):",
        `    after restart (NO driver redrive): processed=${probeA.afterRecovery.processed} value=${probeA.recoveredValue} <- kernel replay armed`,
        "  Probe B (arm issued, body unfinished, crash):",
        `    after restart (NO driver redrive): processed=${probeB.afterRecovery.processed} value=${probeB.recoveredValue} <- kernel replay re-armed`,
        "  Probe C (soundness contrast — deferred-await):",
        `    after kernel replay: untouched=${probeC.deferredUntouchedByReplay} (no generic sweep)`,
        `    after own deferredDone: recovered=${probeC.recoveredViaOwnPath}`,
        "",
        "  => the kernel recovers ONLY executions it owns a write+arm fact for, by",
        "     replaying those facts on restart — never by sweeping arbitrary",
        "     suspended workflows (the unsound shape tf-12q9 rejected).",
      ].join("\n"),
    )

    return verdict
  }).pipe(
    Effect.withSpan("firegrid.kwa.verdict", {
      kind: "internal",
      attributes: { "firegrid.kwa.scope": "kernel-owned-write-arm" },
    }),
  )
