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
        // Adapter sees prompt + permission-response. Terminal does NOT
        // produce an adapter.send (it triggers deregister, recorded
        // separately). Per SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING §A.
        e2e.recorderSends >= 2 &&
        e2e.recorderDeregistrations >= 1,
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

    // ── Scenario 6 — end-to-end via Firegrid client SDK ─────────
    // Production-shaped driver: imports `Firegrid` from @firegrid/
    // client-sdk and dispatches through `firegrid.channels.call/send`
    // against channels registered via FiregridConfig.channels. The
    // unified signal-based subscribers serve those channels — same
    // dispatch flow a real production consumer would use.
    const fgClient = yield* runtime.runEndToEndViaFiregridClient
    yield* assertInvariant(
      fgClient.sessionTerminal &&
        fgClient.sessionInputsConsumed >= 3 &&
        fgClient.toolInvocations === 1 &&
        fgClient.toolResultJson.length > 0 &&
        fgClient.permissionDecision === "allow" &&
        fgClient.scheduleFiredAt.length > 0 &&
        fgClient.webhookOffset.length > 0 &&
        fgClient.webhookObservationEventType === "Issue.create" &&
        fgClient.peerOffset.length > 0 &&
        fgClient.peerObservationName === "plan.ready" &&
        fgClient.recorderSpawns === 1 &&
        fgClient.recorderSends >= 2 &&
        fgClient.recorderDeregistrations >= 1,
      "Firegrid client e2e: production-shaped driver via firegrid.channels.call/send did not settle every capability",
      fgClient,
    )

    // ── Scenario 7 — production-flow end-to-end ─────────────────
    // The only scenario that exercises the full production loop:
    // codec writes outputs to RuntimeOutputTable → JournalObserverLive
    // picks them up → fires sibling workflows → sibling workflows
    // auto-relay results back to session → session forwards relays
    // to codec → ... no driver-side relay anywhere.
    const prod = yield* runtime.runProductionFlow
    yield* assertInvariant(
      prod.sessionTerminal &&
        prod.sessionInputsConsumed >= 4 && // prompt + auto-tool-result + auto-perm-response + terminal
        prod.codecSendCount >= 3 && // prompt, tool-result, permission-response
        prod.codecDeregisterCount === 1 &&
        prod.toolInvocations === 1 &&
        prod.codecSawToolResult &&
        prod.codecSawPermissionResponse,
      "production-flow: codec → journal → observer → workflow → relay → session loop did not close",
      prod,
    )

    // ── Scenario 8 — production-flow against REAL ACP codec ────
    // Drives `ProductionCodecAdapterLive` end-to-end through a
    // `PermissionFixtureAgent` speaking real ACP over an in-memory
    // TransformStream byte pipe. The codec, sandbox provider
    // (fake), and adapter are exactly what production uses; only
    // the byte transport is in-process. Proves AcpSessionLive
    // decodes real wire bytes and the journal drain writes typed
    // AgentOutputObservations.
    const prodAcp = yield* runtime.runProductionFlowAcp
    yield* assertInvariant(
      prodAcp.sessionTerminal &&
        prodAcp.fixtureSawPrompt &&
        prodAcp.journalRowsWritten >= 3 && // Ready + TextChunk + ToolUse + TurnComplete at minimum
        prodAcp.sawToolUse &&
        prodAcp.sawTurnComplete,
      "production-flow-acp: real ACP codec end-to-end loop did not surface expected observations",
      prodAcp,
    )

    // ── Scenario 9 — production-flow against REAL ACP codec via
    // ── REAL SUBPROCESS (LocalProcessSandboxProvider) ──────────
    // Gated behind FIREGRID_UKV_RUN_ACP_LIVE=1. When enabled, drives
    // the same flow as scenario 8 but through a Node child process
    // running our fake ACP agent bootstrap. Proves the full
    // production stack works against a genuine subprocess — same
    // sandbox provider that runs `claude-agent-acp` in production.
    const prodAcpLive = yield* runtime.runProductionFlowAcpLive
    if (prodAcpLive.enabled) {
      yield* assertInvariant(
        prodAcpLive.sessionTerminal === true &&
          (prodAcpLive.journalRowsWritten ?? 0) >= 3 &&
          prodAcpLive.sawToolUse === true,
        "production-flow-acp-live: real subprocess + real ACP codec loop did not surface expected observations",
        prodAcpLive,
      )
    }

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
      scenarios: prodAcpLive.enabled ? 9 : 8,
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
        `  Channel-driven scenarios (${prodAcpLive.enabled ? "9/9" : "8/8"} green):`,
        `    end-to-end (router) ...... session=${e2e.sessionTerminal} inputs=${e2e.sessionInputsConsumed} tool=${e2e.toolInvocations}× perm=${e2e.permissionDecision} schedule=${e2e.scheduleFiredAt.length > 0}`,
        `    end-to-end (Firegrid SDK) session=${fgClient.sessionTerminal} inputs=${fgClient.sessionInputsConsumed} tool=${fgClient.toolInvocations}× perm=${fgClient.permissionDecision} webhook=${fgClient.webhookObservationEventType} peer=${fgClient.peerObservationName}`,
        `    production flow (e2e) ... session=${prod.sessionTerminal} inputs=${prod.sessionInputsConsumed} codecSends=${prod.codecSendCount} dereg=${prod.codecDeregisterCount} tool=${prod.toolInvocations}× auto-relay=${prod.codecSawToolResult && prod.codecSawPermissionResponse}`,
        `    production flow (ACP) ... session=${prodAcp.sessionTerminal} journalRows=${prodAcp.journalRowsWritten} sawTool=${prodAcp.sawToolUse} sawPerm=${prodAcp.sawPermissionRequest} fixtureSawPrompt=${prodAcp.fixtureSawPrompt}`,
        prodAcpLive.enabled
          ? `    production flow (LIVE) .. session=${prodAcpLive.sessionTerminal} journalRows=${prodAcpLive.journalRowsWritten} sawTool=${prodAcpLive.sawToolUse} sawTurn=${prodAcpLive.sawTurnComplete}`
          : `    production flow (LIVE) .. ⊘ skipped (${prodAcpLive.skipped ?? "FIREGRID_UKV_RUN_ACP_LIVE not set"})`,
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
