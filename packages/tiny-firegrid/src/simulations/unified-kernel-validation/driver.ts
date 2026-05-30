/**
 * unified-kernel-validation driver.
 *
 * Pulls every runtime probe through the host latch, asserts the
 * invariants each probe must satisfy, then runs the structural
 * collapse-invariant scans over the simulation source. Emits a
 * verdict block to stdout in the same shape as kernel-owned-write-arm.
 *
 * Runtime assertions live next to the data they're checking (no
 * separate "assert" module) so a failure points at the relevant
 * scenario directly. The driver fails the simulation run if any
 * assertion fails — no soft warnings — because the invariants are
 * what define "the unified shape works."
 */

import { Console, Effect } from "effect"
import { unifiedKernelRuntime } from "./host.ts"
import { runStructuralChecks } from "./invariants.ts"

interface UnifiedKernelVerdict {
  readonly verdict: "GREEN"
  readonly runtimeProbes: number
  readonly structuralChecks: number
}

const assertInvariant = (condition: boolean, message: string, detail: unknown) =>
  condition
    ? Effect.void
    : Effect.fail(new Error(
      `unified-kernel-validation invariant failed: ${message}; ${JSON.stringify(detail)}`,
    ))

export const unifiedKernelValidationDriver: Effect.Effect<UnifiedKernelVerdict, unknown> =
  Effect.gen(function*() {
    const runtime = yield* Effect.promise(() => unifiedKernelRuntime)

    // ── P1 — Signal primitive ───────────────────────────────────
    const p1a = yield* runtime.runProbeP1A
    yield* assertInvariant(
      p1a.parked && p1a.finalLanded,
      "P1A: body did not park, or sendSignal did not wake it",
      p1a,
    )
    const p1b = yield* runtime.runProbeP1B
    yield* assertInvariant(
      p1b.gen1Recorded && p1b.autoRecovered && p1b.replayed >= 1,
      "P1B: recovery did not re-arm the parked body after crash between record and resume",
      p1b,
    )
    const p1c = yield* runtime.runProbeP1C
    yield* assertInvariant(
      p1c.signalExecRecovered && p1c.deferredExecUntouched,
      "P1C: bounded ownership FALSIFIED — recovery swept a deferred-await execution it owns no signal for",
      p1c,
    )

    // ── P2 — RuntimeContext session ─────────────────────────────
    const p2a = yield* runtime.runProbeP2A
    yield* assertInvariant(
      p2a.spawns === 1 &&
        p2a.sends === 2 &&
        p2a.inputsConsumed1 === 2 &&
        p2a.inputsConsumed2 === 2 &&
        p2a.reachedTerminal1 &&
        p2a.reachedTerminal2,
      "P2A: concurrent executes did not collapse to one body (TOCTOU regression)",
      p2a,
    )
    const p2b = yield* runtime.runProbeP2B
    yield* assertInvariant(
      p2b.spawns === 1 && p2b.sends === 3 && p2b.finalLanded,
      "P2B: input arrival via sendSignal did not wake parked body or sends were not memoized",
      p2b,
    )
    const p2c = yield* runtime.runProbeP2C
    yield* assertInvariant(
      p2c.recoveredFinalLanded &&
        p2c.gen2Spawns === 0 &&
        p2c.gen2Sends === 1 &&
        p2c.replayed >= 1,
      "P2C: crash recovery did not re-arm session, or Activity memoization across generations broke",
      p2c,
    )

    // ── P3 — Permission + tool ──────────────────────────────────
    const p3a = yield* runtime.runProbeP3A
    yield* assertInvariant(
      p3a.openRequestRecorded && p3a.decision === "allow",
      "P3A: permission body did not record open request, or did not return signal-delivered decision",
      p3a,
    )
    const p3b = yield* runtime.runProbeP3B
    yield* assertInvariant(
      p3b.invocations === 1 && p3b.resultsMatch,
      "P3B: tool dispatch invoked executor >1 time or returned divergent results across concurrent executes",
      p3b,
    )

    // ── P4 — Scheduled + external adapters ──────────────────────
    const p4a = yield* runtime.runProbeP4A
    yield* assertInvariant(
      p4a.rowPresent && p4a.scheduleIdMatch && p4a.firedAt.length > 0,
      "P4A: scheduled prompt did not fire / commitment row missing",
      p4a,
    )
    const p4b = yield* runtime.runProbeP4B
    yield* assertInvariant(
      p4b.ingestTag === "Inserted" &&
        p4b.factWritten &&
        p4b.observerEventType === "Issue.create",
      "P4B: webhook ingest+observer roundtrip failed",
      p4b,
    )
    const p4c = yield* runtime.runProbeP4C
    yield* assertInvariant(
      p4c.rejected && p4c.errorOp === "signature/invalid" && !p4c.factWritten,
      "P4C: webhook with invalid HMAC was not rejected, or fact was written anyway",
      p4c,
    )
    const p4d = yield* runtime.runProbeP4D
    yield* assertInvariant(
      p4d.emitTag === "Inserted" &&
        p4d.observerName === "plan.ready" &&
        p4d.observerEmitter === "ctx-emit",
      "P4D: peer event emit+observer roundtrip failed",
      p4d,
    )

    // ── P5 — End-to-end product surface ─────────────────────────
    const p5 = yield* runtime.runProbeP5E2E
    yield* assertInvariant(
      p5.openPermissionRequestRecorded &&
        p5.sessionFinalResultPresent &&
        p5.spawnCount === 1 &&
        p5.sendCount >= 3 &&
        p5.toolInvocations === 1 &&
        p5.toolResult.length > 0 &&
        p5.permDecision === "allow" &&
        p5.scheduleFiredAt.length > 0 &&
        p5.webhookFactWritten &&
        p5.peerFactWritten &&
        p5.sessionTerminal,
      "P5: end-to-end product surface did not settle every capability durably",
      p5,
    )

    // ── Structural collapse invariants ──────────────────────────
    const structural = runStructuralChecks()
    for (const check of structural.checks) {
      yield* assertInvariant(
        check.offenders.length === 0,
        `${check.id}: ${check.title}`,
        { offenders: check.offenders },
      )
    }

    const verdict: UnifiedKernelVerdict = {
      verdict: "GREEN",
      runtimeProbes: 13,
      structuralChecks: structural.checks.length,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.ukv.verdict": verdict.verdict,
      "firegrid.ukv.runtime_probes": verdict.runtimeProbes,
      "firegrid.ukv.structural_checks": verdict.structuralChecks,
      "firegrid.ukv.structural_passed": structural.passed,
      "firegrid.ukv.structural_failed": structural.failed,
    })

    yield* Console.log(
      [
        `unified-kernel-validation: ${verdict.verdict}`,
        "",
        "  Three primitives — Workflow + DurableTable + Signal — are sufficient",
        "  to deliver the entire product surface.",
        "",
        "  Runtime probes (13/13 green):",
        `    P1A signal wake .................. parked=${p1a.parked} finalLanded=${p1a.finalLanded}`,
        `    P1B crash record↦resume recovery . autoRecovered=${p1b.autoRecovered} replayed=${p1b.replayed}`,
        `    P1C bounded ownership ............ signalRecovered=${p1c.signalExecRecovered} deferredUntouched=${p1c.deferredExecUntouched}`,
        `    P2A session concurrent dedup ..... spawns=${p2a.spawns} sends=${p2a.sends}`,
        `    P2B session input arrival ........ spawns=${p2b.spawns} sends=${p2b.sends} finalLanded=${p2b.finalLanded}`,
        `    P2C session crash recovery ....... recoveredFinalLanded=${p2c.recoveredFinalLanded} gen2Spawns=${p2c.gen2Spawns} gen2Sends=${p2c.gen2Sends}`,
        `    P3A permission roundtrip ......... openRequest=${p3a.openRequestRecorded} decision=${p3a.decision}`,
        `    P3B tool dispatch idempotency .... invocations=${p3b.invocations} resultsMatch=${p3b.resultsMatch}`,
        `    P4A scheduled prompt fires ....... rowPresent=${p4a.rowPresent} firedAt=${p4a.firedAt}`,
        `    P4B webhook ingest+observer ...... ingestTag=${p4b.ingestTag} factWritten=${p4b.factWritten}`,
        `    P4C webhook bad HMAC rejected .... rejected=${p4c.rejected} errorOp=${p4c.errorOp ?? "-"}`,
        `    P4D peer event emit+observer ..... emitTag=${p4d.emitTag} observerName=${p4d.observerName}`,
        `    P5 end-to-end product surface ... spawns=${p5.spawnCount} sends=${p5.sendCount} toolInvocations=${p5.toolInvocations} permission=${p5.permDecision} sessionTerminal=${p5.sessionTerminal}`,
        "",
        `  Structural collapse invariants (${structural.passed}/${structural.checks.length} green):`,
        ...structural.checks.map((c) =>
          `    ${c.offenders.length === 0 ? "✓" : "✗"} ${c.id} — ${c.title}`,
        ),
        "",
        "  => Subscribers built only on Workflow + DurableTable + the durable",
        "     Signal primitive cover the full product surface end-to-end, and",
        "     the source structurally excludes every retired Shape C /",
        "     DurableDeferred-mailbox pattern.",
      ].join("\n"),
    )

    return verdict
  }).pipe(
    Effect.withSpan("firegrid.ukv.verdict", {
      kind: "internal",
      attributes: { "firegrid.ukv.scope": "unified-kernel-validation" },
    }),
  )
