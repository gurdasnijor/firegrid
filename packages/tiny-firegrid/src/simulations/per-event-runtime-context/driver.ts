/**
 * tf-c71h — per-event RuntimeContext WORKBENCH driver.
 *
 * Public-surface only (`@firegrid/client-sdk`). Drives MANY inputs into ONE
 * session sequentially so the trace can show N fresh per-event handler
 * executions (and a real spawn) against the real substrate. The driver draws
 * NO conclusions — the trace is the deliverable.
 *
 * Sequence: launch the official ACP example agent → attach → start →
 * autoApprove → prompt #1 → wait for agent output → prompt #2 (proves the same
 * live process serves a second turn) → prompt #3 → close. Each step is awaited
 * (sequential) so per-key seq assignment is deterministic.
 *
 * Note on waits: the fixture requests a permission every turn, and in the
 * unified architecture the decision is delivered to the agent THROUGH the
 * session body's `adapter.send`. This workbench leaves the production permission
 * RELAY pointed at the (dormant) parked body, so the decision strands and the
 * codec resolves the agent's `requestPermission` with its 20s `Cancelled`
 * safety-net (acp/index.ts:53). The driver therefore does NOT block on
 * `TurnComplete`; it waits briefly for streamed output to confirm the per-event
 * send reached the live agent, then proceeds. The execution-shape proofs live
 * in the trace regardless of whether each turn reaches `end_turn`.
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

const PROMPT_WAIT_MS = 6_000

const runScenario = Effect.scoped(Effect.gen(function*() {
  const firegrid = yield* Firegrid

  const launched = yield* firegrid.launch({
    requestedBy: "tiny-firegrid:per-event-runtime-context",
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

  // Multiple inputs into ONE session, each awaited. Each prompt is a distinct
  // idempotencyKey → a distinct per-event handler execution.
  const promptKeys = [
    "tf-c71h-prompt-1",
    "tf-c71h-prompt-2",
    "tf-c71h-prompt-3",
  ] as const

  const offsets: Array<string> = []
  let outputMatchedCount = 0
  let index = 0
  while (index < promptKeys.length) {
    const promptKey = promptKeys[index]!
    const turn = index + 1
    const offset = yield* session.prompt({
      idempotencyKey: promptKey,
      payload: {
        text:
          `Per-event workbench turn ${turn}: confirm this prompt reaches the `
          + "same live ACP process through a fresh per-event handler execution.",
      },
    })
    offsets.push(offset.offset)
    const waited = yield* session.wait.forAgentOutput({ timeoutMs: PROMPT_WAIT_MS })
    if (waited.matched) outputMatchedCount += 1
    index += 1
  }

  const closeResult = yield* session.close({
    reason: "per-event-runtime-context workbench terminal cleanup",
  })

  // Let the close's terminal per-event execution (deregister) settle.
  yield* Effect.sleep("500 millis")

  const snapshot = yield* launched.snapshot
  const outputTags = snapshot.agentOutputs.map((output) => output._tag)

  return {
    contextId: launched.contextId,
    startRecorded: startOffset.offset.length > 0,
    promptCount: promptKeys.length,
    promptOffsetCount: offsets.filter((offset) => offset.length > 0).length,
    outputMatchedCount,
    closeRecorded: closeResult.closed,
    snapshotRunCount: snapshot.runs.length,
    snapshotEventCount: snapshot.events.length,
    snapshotOutputCount: snapshot.agentOutputs.length,
    textChunkCount: outputTags.filter((tag) => tag === "TextChunk").length,
    toolUseCount: outputTags.filter((tag) => tag === "ToolUse").length,
    turnCompleteCount: outputTags.filter((tag) => tag === "TurnComplete").length,
    permissionRequestCount: outputTags.filter((tag) => tag === "PermissionRequest").length,
    outputTags: outputTags.join(","),
  }
}))

export const perEventRuntimeContextDriver = Effect.gen(function*() {
  const scenario = yield* runScenario

  yield* Effect.annotateCurrentSpan({
    "firegrid.workbench.context_id": scenario.contextId,
    "firegrid.workbench.start_recorded": scenario.startRecorded,
    "firegrid.workbench.prompt_count": scenario.promptCount,
    "firegrid.workbench.prompt_offset_count": scenario.promptOffsetCount,
    "firegrid.workbench.output_matched_count": scenario.outputMatchedCount,
    "firegrid.workbench.close_recorded": scenario.closeRecorded,
    "firegrid.workbench.snapshot_run_count": scenario.snapshotRunCount,
    "firegrid.workbench.snapshot_event_count": scenario.snapshotEventCount,
    "firegrid.workbench.snapshot_output_count": scenario.snapshotOutputCount,
    "firegrid.workbench.snapshot_text_chunk_count": scenario.textChunkCount,
    "firegrid.workbench.snapshot_tool_use_count": scenario.toolUseCount,
    "firegrid.workbench.snapshot_turn_complete_count": scenario.turnCompleteCount,
    "firegrid.workbench.snapshot_permission_request_count": scenario.permissionRequestCount,
    "firegrid.workbench.snapshot_output_tags": scenario.outputTags,
    "firegrid.workbench.spawn_target": "src/bin/fake-acp-agent-process.ts",
    "firegrid.workbench.codec": "acp",
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.per_event_runtime_context.driver", {
    kind: "internal",
  }),
)
