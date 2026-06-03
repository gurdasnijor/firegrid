/**
 * tf-ogoj — DurableDeferred + serialization WORKBENCH driver.
 *
 * Public-surface only (`@firegrid/client-sdk`). Drives the three hypotheses;
 * draws NO conclusions (the trace is the deliverable, the prose finding
 * interprets confirm/reject).
 *
 *   H1: prompt `h1-open` (starts the deferred-gate workflow → it awaits/suspends),
 *       then prompt `h1-resolve` (resolves the DurableDeferred → engine resumes
 *       it). The trace shows engine.deferred.result/.done spans.
 *   H2: fire N CONCURRENT same-`contextId` prompts (idempotencyKey `h2-*`). The
 *       trace shows whether idempotencyKey+cursor serializes or races.
 *   H3: crash-recovery is NOT driven (public-surface-blocked) — see the finding.
 */

import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

const fixtureArgv: ReadonlyArray<string> = [
  process.execPath,
  "--import",
  "tsx",
  "src/bin/fake-acp-agent-process.ts",
]

const CONCURRENT_INPUTS = 6

const runScenario = Effect.scoped(Effect.gen(function*() {
  const firegrid = yield* Firegrid

  const launched = yield* firegrid.launch({
    requestedBy: "tiny-firegrid:durable-deferred-and-serialization",
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

  // ── H1: DurableDeferred await-once round-trip on the real engine ──────────
  const h1OpenOffset = yield* session.prompt({
    idempotencyKey: "h1-open-1",
    payload: { text: "open the deferred gate (H1: await on the real engine)" },
  })
  // Let the gate workflow start and suspend on the deferred before resolving.
  yield* Effect.sleep("1500 millis")
  const h1ResolveOffset = yield* session.prompt({
    idempotencyKey: "h1-resolve-1",
    payload: { text: "tf-ogoj-h1-resolved-value" },
  })
  // Let the engine.deferredDone → resume → completion settle.
  yield* Effect.sleep("1500 millis")

  // ── H2: concurrent same-contextId inputs (the serialization probe) ────────
  const indices = Array.from({ length: CONCURRENT_INPUTS }, (_, i) => i)
  const h2Offsets = yield* Effect.all(
    indices.map((i) =>
      session.prompt({
        idempotencyKey: `h2-${i}`,
        payload: { text: `H2 concurrent input ${i}` },
      }),
    ),
    { concurrency: "unbounded" },
  )
  // Let the concurrent per-event executions (spawn + sends + cursor) settle.
  yield* Effect.sleep("3000 millis")

  const closeResult = yield* session.close({
    reason: "durable-deferred-and-serialization workbench terminal cleanup",
  })
  yield* Effect.sleep("500 millis")

  const snapshot = yield* launched.snapshot
  const outputTags = snapshot.agentOutputs.map((output) => output._tag)

  return {
    contextId: launched.contextId,
    startRecorded: startOffset.offset.length > 0,
    h1OpenRecorded: h1OpenOffset.offset.length > 0,
    h1ResolveRecorded: h1ResolveOffset.offset.length > 0,
    h2InputCount: CONCURRENT_INPUTS,
    h2OffsetCount: h2Offsets.filter((offset) => offset.offset.length > 0).length,
    closeRecorded: closeResult.closed,
    snapshotRunCount: snapshot.runs.length,
    snapshotOutputCount: snapshot.agentOutputs.length,
    textChunkCount: outputTags.filter((tag) => tag === "TextChunk").length,
    turnCompleteCount: outputTags.filter((tag) => tag === "TurnComplete").length,
    outputTags: outputTags.join(","),
  }
}))

export const durableDeferredAndSerializationDriver = Effect.gen(function*() {
  const scenario = yield* runScenario

  yield* Effect.annotateCurrentSpan({
    "firegrid.workbench.context_id": scenario.contextId,
    "firegrid.workbench.start_recorded": scenario.startRecorded,
    "firegrid.workbench.h1_open_recorded": scenario.h1OpenRecorded,
    "firegrid.workbench.h1_resolve_recorded": scenario.h1ResolveRecorded,
    "firegrid.workbench.h2_input_count": scenario.h2InputCount,
    "firegrid.workbench.h2_offset_count": scenario.h2OffsetCount,
    "firegrid.workbench.close_recorded": scenario.closeRecorded,
    "firegrid.workbench.snapshot_run_count": scenario.snapshotRunCount,
    "firegrid.workbench.snapshot_output_count": scenario.snapshotOutputCount,
    "firegrid.workbench.snapshot_text_chunk_count": scenario.textChunkCount,
    "firegrid.workbench.snapshot_turn_complete_count": scenario.turnCompleteCount,
    "firegrid.workbench.snapshot_output_tags": scenario.outputTags,
    "firegrid.workbench.spawn_target": "src/bin/fake-acp-agent-process.ts",
    "firegrid.workbench.codec": "acp",
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.durable_deferred_and_serialization.driver", {
    kind: "internal",
  }),
)
