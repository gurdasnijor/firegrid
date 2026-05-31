/**
 * unified-kernel-validation driver.
 *
 * Runs the five product-surface scenarios through the `UnifiedChannels`
 * client, then runs the structural collapse-invariant scans over the
 * simulation source. Verdict prints to stdout in the same shape as
 * other tiny-firegrid simulations.
 *
 * The scenarios verify behaviour through the channel responses; the
 * driver never reaches into the substrate. Recovery scenarios verify
 * through a second-generation channel call whose only possible
 * success path is signal recovery.
 */

import { Console, Effect } from "effect"
import { unifiedKernelRuntime } from "./host.ts"
import { runStructuralChecks } from "./invariants.ts"

interface UnifiedKernelVerdict {
  readonly verdict: "GREEN"
  readonly scenarios: number
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

    // ── Scenario 1 — end-to-end product surface ─────────────────
    const e2e = yield* runtime.runEndToEnd
    yield* assertInvariant(
      e2e.sessionTerminal &&
        e2e.sessionInputsConsumed >= 3 &&
        e2e.permissionRequestRowSeen &&
        e2e.permissionDecision === "allow" &&
        e2e.toolInvocations === 1 &&
        e2e.toolResultJson.length > 0 &&
        e2e.scheduleFiredAt.length > 0 &&
        e2e.webhookOffset.length > 0 &&
        !e2e.webhookDeduplicated &&
        e2e.webhookObservationEventType === "Issue.create" &&
        e2e.peerOffset.length > 0 &&
        !e2e.peerDeduplicated &&
        e2e.peerObservationName === "plan.ready" &&
        e2e.recorderSpawns === 1 &&
        e2e.recorderSends >= 3,
      "end-to-end: product surface did not settle every capability through the channels",
      e2e,
    )

    // ── Scenario 2 — crash recovery ─────────────────────────────
    const recovery = yield* runtime.runCrashRecovery
    yield* assertInvariant(
      recovery.gen2ReachedTerminal && recovery.gen2InputsConsumed >= 1,
      "crash recovery: session did not complete after gen-2 reconstruction without driver re-drive",
      recovery,
    )

    // ── Scenario 3 — tool dispatch idempotency ──────────────────
    const idempotency = yield* runtime.runToolIdempotency
    yield* assertInvariant(
      idempotency.executorInvocations === 1 && idempotency.bothResultsMatch,
      "tool idempotency: concurrent dispatch invoked executor more than once or returned divergent results",
      idempotency,
    )

    // ── Scenario 4 — webhook bad-HMAC rejection ─────────────────
    const badHmac = yield* runtime.runWebhookBadHmac
    yield* assertInvariant(
      badHmac.rejected && badHmac.errorOp === "signature/invalid",
      "webhook bad-HMAC: ingest did not reject invalid signature",
      badHmac,
    )

    // ── Scenario 5 — bounded ownership ──────────────────────────
    const bounded = yield* runtime.runBoundedOwnership
    yield* assertInvariant(
      bounded.deferredStillParkedAfterRecovery,
      "bounded ownership: signal recovery touched a deferred-await execution it owns no signal for",
      bounded,
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
      scenarios: 5,
      structuralChecks: structural.checks.length,
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.ukv.verdict": verdict.verdict,
      "firegrid.ukv.scenarios": verdict.scenarios,
      "firegrid.ukv.structural_checks": verdict.structuralChecks,
    })

    yield* Console.log(
      [
        `unified-kernel-validation: ${verdict.verdict}`,
        "",
        "  Three primitives — Workflow + DurableTable + Signal — are sufficient",
        "  to deliver the entire product surface, exposed as channels.",
        "",
        "  Channel-driven scenarios (5/5 green):",
        `    end-to-end .............. session=${e2e.sessionTerminal} inputs=${e2e.sessionInputsConsumed} tool=${e2e.toolInvocations}× perm=${e2e.permissionDecision} schedule=${e2e.scheduleFiredAt.length > 0} webhook=${e2e.webhookObservationEventType}@${e2e.webhookOffset} peer=${e2e.peerObservationName}@${e2e.peerOffset}`,
        `    crash recovery .......... gen2Terminal=${recovery.gen2ReachedTerminal} gen2Inputs=${recovery.gen2InputsConsumed}`,
        `    tool idempotency ........ invocations=${idempotency.executorInvocations} match=${idempotency.bothResultsMatch}`,
        `    webhook bad HMAC ........ rejected=${badHmac.rejected} op=${badHmac.errorOp ?? "-"}`,
        `    bounded ownership ....... deferredParked=${bounded.deferredStillParkedAfterRecovery} replayed=${bounded.signalsReplayed}`,
        "",
        `  Structural collapse invariants (${structural.passed}/${structural.checks.length} green):`,
        ...structural.checks.map((c) =>
          `    ${c.offenders.length === 0 ? "✓" : "✗"} ${c.id} — ${c.title}`,
        ),
        "",
        "  => Driver exercises every product capability through the channel",
        "     abstraction. Signal-based subscribers underneath each channel;",
        "     no driver-side reach into substrate state. Source structurally",
        "     excludes every retired Shape C / DurableDeferred-mailbox pattern.",
      ].join("\n"),
    )

    return verdict
  }).pipe(
    Effect.withSpan("firegrid.ukv.verdict", {
      kind: "internal",
      attributes: { "firegrid.ukv.scope": "unified-kernel-validation" },
    }),
  )
