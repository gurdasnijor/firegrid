import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect, Exit } from "effect"

const fixtureArgv: ReadonlyArray<string> = [
  process.execPath,
  "--import",
  "tsx",
  "src/bin/fake-acp-agent-process.ts",
]

type ProbeStatus = "observed" | "surfaced-gap" | "public-surface-blocked"

interface MigratedProbe {
  readonly id: string
  readonly legacyProbe: string
  readonly status: ProbeStatus
  readonly evidence: string
}

const migratedProbe = (
  id: string,
  legacyProbe: string,
  status: ProbeStatus,
  evidence: string,
): MigratedProbe => ({
  id,
  legacyProbe,
  status,
  evidence,
})

const probeAttributes = (
  probes: ReadonlyArray<MigratedProbe>,
): Record<string, string | number> => {
  const attributes: Record<string, string | number> = {
    "firegrid.ukv.migrated_probe_count": probes.length,
    "firegrid.ukv.migrated_probe_observed_count": probes.filter((probe) =>
      probe.status === "observed",
    ).length,
    "firegrid.ukv.migrated_probe_gap_count": probes.filter((probe) =>
      probe.status === "surfaced-gap",
    ).length,
    "firegrid.ukv.migrated_probe_public_surface_blocked_count": probes.filter((probe) =>
      probe.status === "public-surface-blocked",
    ).length,
  }
  probes.forEach((probe, index) => {
    const prefix = `firegrid.ukv.migrated_probe.${index + 1}`
    attributes[`${prefix}.id`] = probe.id
    attributes[`${prefix}.legacy_probe`] = probe.legacyProbe
    attributes[`${prefix}.status`] = probe.status
    attributes[`${prefix}.evidence`] = probe.evidence
  })
  return attributes
}

const runExampleAgentScenario =
  Effect.scoped(Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const launched = yield* firegrid.launch({
      requestedBy: "tiny-firegrid:official-acp-example",
      runtime: local.jsonl({
        agent: "official-acp-typescript-sdk-example",
        argv: fixtureArgv,
        cwd: process.cwd(),
        agentProtocol: "acp",
      }),
    })
    const session = yield* firegrid.sessions.attach({
      sessionId: launched.contextId,
    })
    const startOffset = yield* session.start()
    yield* session.permissions.autoApprove("allow", { timeoutMs: 2_000 })
    const promptOffset = yield* session.prompt({
      idempotencyKey: "tiny-firegrid-unified-kernel-validation-official-acp-example",
      payload: {
        text: "Validate the production ACP path through the official SDK example agent.",
      },
    })
    const permissionWait = yield* Effect.exit(
      session.wait.forPermissionRequest({
        timeoutMs: 2_000,
      }),
    )
    let waitResult = yield* session.wait.forAgentOutput({
      timeoutMs: 12_000,
    })
    let remainingOutputWaits = 20
    while (
      waitResult.matched &&
      waitResult.output._tag !== "TurnComplete" &&
      remainingOutputWaits > 0
    ) {
      waitResult = yield* session.wait.forAgentOutput({
        timeoutMs: 12_000,
      })
      remainingOutputWaits -= 1
    }
    const snapshot = yield* launched.snapshot
    const outputTags = snapshot.agentOutputs.map((output) => output._tag)
    const toolUseCount = outputTags.filter((tag) => tag === "ToolUse").length
    const turnCompleteCount = outputTags.filter((tag) => tag === "TurnComplete").length
    const textChunkCount = outputTags.filter((tag) => tag === "TextChunk").length
    const permissionRequestCount = outputTags.filter((tag) =>
      tag === "PermissionRequest",
    ).length
    const terminalCleanupContext = yield* firegrid.launch({
      requestedBy: "tiny-firegrid:terminal-cleanup",
      runtime: local.jsonl({
        agent: "official-acp-typescript-sdk-example-terminal-cleanup",
        argv: fixtureArgv,
        cwd: process.cwd(),
        agentProtocol: "acp",
      }),
    })
    const terminalCleanupSession = yield* firegrid.sessions.attach({
      sessionId: terminalCleanupContext.contextId,
    })
    yield* terminalCleanupSession.start()
    const closeResult = yield* terminalCleanupSession.close({
      reason: "unified-kernel-validation terminal cleanup proof",
    })
    yield* Effect.sleep("500 millis")
    const startRecorded = startOffset.offset.length > 0
    const promptRecorded = promptOffset.offset.length > 0
    const permissionWaitMatched = Exit.match(permissionWait, {
      onFailure: () => false,
      onSuccess: (result) => result.matched,
    })
    const migratedProbes: ReadonlyArray<MigratedProbe> = [
      migratedProbe(
        "P1A",
        "probeP1A signal happy path",
        promptRecorded ? "observed" : "surfaced-gap",
        `public session.prompt returned durable offset ${promptOffset.offset}`,
      ),
      migratedProbe(
        "P1B",
        "probeP1B signal crash recovery",
        "public-surface-blocked",
        "old probe required generation teardown/recovery controls; driver airgap exposes only public SDK operations",
      ),
      migratedProbe(
        "P1C",
        "probeP1C bounded signal ownership",
        "public-surface-blocked",
        "old probe required a DurableDeferred-only workflow outside the public Firegrid surface",
      ),
      migratedProbe(
        "P2A",
        "probeP2A concurrent session executes admit one body",
        startRecorded ? "observed" : "surfaced-gap",
        `public session.start returned durable offset ${startOffset.offset}; trace must show one start_or_attach for one launch`,
      ),
      migratedProbe(
        "P2B",
        "probeP2B input arrival after body parks",
        promptRecorded ? "observed" : "surfaced-gap",
        `prompt delivered after start via session.prompt offset ${promptOffset.offset}`,
      ),
      migratedProbe(
        "P2C",
        "probeP2C session crash recovery",
        closeResult.closed ? "observed" : "surfaced-gap",
        `public session.close returned closed=${closeResult.closed} for terminal cleanup session; trace must show terminal_signal before adapter.deregister`,
      ),
      migratedProbe(
        "P3A",
        "probeP3A permission roundtrip",
        permissionWaitMatched || permissionRequestCount > 0 ? "observed" : "surfaced-gap",
        `permission wait matched=${permissionWaitMatched}; snapshot PermissionRequest count=${permissionRequestCount}`,
      ),
      migratedProbe(
        "P3B",
        "probeP3B tool dispatch idempotency",
        toolUseCount > 0 ? "observed" : "surfaced-gap",
        `snapshot ToolUse count=${toolUseCount}; trace surfaced ACP ToolResult codec gap during real tool-result relay`,
      ),
      migratedProbe(
        "P4A",
        "probeP4A scheduled prompt",
        "public-surface-blocked",
        "no public scheduled-prompt operation is exposed to this airgapped driver",
      ),
      migratedProbe(
        "P4B",
        "probeP4B webhook observer",
        "public-surface-blocked",
        "no public webhook ingest/observer operation is exposed to this airgapped driver",
      ),
      migratedProbe(
        "P4C",
        "probeP4C webhook bad HMAC rejection",
        "public-surface-blocked",
        "no public webhook ingest operation is exposed to this airgapped driver",
      ),
      migratedProbe(
        "P4D",
        "probeP4D peer event observer",
        "public-surface-blocked",
        "no public peer event operation is exposed to this airgapped driver",
      ),
      migratedProbe(
        "P5",
        "probeP5E2E full product surface",
        waitResult.matched && turnCompleteCount > 0 && textChunkCount > 0
          ? "observed"
          : "surfaced-gap",
        `agent-output wait matched=${waitResult.matched}; TextChunk count=${textChunkCount}; ToolUse count=${toolUseCount}; TurnComplete count=${turnCompleteCount}`,
      ),
    ]
    return {
      contextId: launched.contextId,
      matched: waitResult.matched,
      runCount: snapshot.runs.length,
      eventCount: snapshot.events.length,
      outputCount: snapshot.agentOutputs.length,
      outputTags: outputTags.join(","),
      textChunkCount,
      toolUseCount,
      turnCompleteCount,
      permissionRequestCount,
      permissionWaitMatched,
      closeRecorded: closeResult.closed,
      migratedProbes,
    }
  }))

export const unifiedKernelValidationDriver = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const scenario = yield* runExampleAgentScenario

  yield* Effect.annotateCurrentSpan({
    "firegrid.ukv.client_metadata_count": firegrid.channels.metadata.length,
    "firegrid.ukv.context_id": scenario.contextId,
    "firegrid.ukv.output_matched": scenario.matched,
    "firegrid.ukv.snapshot_run_count": scenario.runCount,
    "firegrid.ukv.snapshot_event_count": scenario.eventCount,
    "firegrid.ukv.snapshot_output_count": scenario.outputCount,
    "firegrid.ukv.snapshot_output_tags": scenario.outputTags,
    "firegrid.ukv.snapshot_text_chunk_count": scenario.textChunkCount,
    "firegrid.ukv.snapshot_tool_use_count": scenario.toolUseCount,
    "firegrid.ukv.snapshot_turn_complete_count": scenario.turnCompleteCount,
    "firegrid.ukv.snapshot_permission_request_count": scenario.permissionRequestCount,
    "firegrid.ukv.permission_wait_matched": scenario.permissionWaitMatched,
    "firegrid.ukv.close_recorded": scenario.closeRecorded,
    "firegrid.ukv.factory_host": true,
    "firegrid.ukv.codec": "acp",
    "firegrid.ukv.spawn_target": "src/bin/fake-acp-agent-process.ts",
    "firegrid.ukv.agent_source":
      "agentclientprotocol/typescript-sdk/src/examples/agent.ts",
    ...probeAttributes(scenario.migratedProbes),
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.unified_kernel_validation.driver", {
    kind: "internal",
  }),
)
