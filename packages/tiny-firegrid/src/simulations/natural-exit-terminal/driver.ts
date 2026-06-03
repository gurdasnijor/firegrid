/**
 * tf-r06u.36 — natural-exit terminal-deregister proof driver.
 *
 * Public-surface only (`@firegrid/client-sdk`). Launches the REAL one-shot ACP
 * agent that answers a single prompt and then EXITS its own process. The host
 * codec sees the byte-pipe EOF and emits `Terminated`; the production observer
 * (this branch) delivers a terminal input to the per-event RuntimeContext
 * handler, which runs `adapter.deregister` (Scope.close → process reaped).
 *
 * The driver does NOT call `session.close`/`session.cancel` — the terminal path
 * here is NATURAL process exit, the case that previously leaked. The trace is
 * the deliverable; the prose finding interprets the reap.
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
  "src/bin/self-exiting-acp-agent-process.ts",
]

const runScenario = Effect.scoped(Effect.gen(function*() {
  const firegrid = yield* Firegrid

  const launched = yield* firegrid.launch({
    requestedBy: "tiny-firegrid:natural-exit-terminal",
    runtime: local.jsonl({
      agent: "self-exiting-acp-agent",
      argv: fixtureArgv,
      cwd: process.cwd(),
      agentProtocol: "acp",
    }),
  })

  const session = yield* firegrid.sessions.attach({
    sessionId: launched.contextId,
  })

  const startOffset = yield* session.start()

  // One prompt — the agent answers (`end_turn`) then exits its process.
  const promptOffset = yield* session.prompt({
    idempotencyKey: "tf-r06u-36-natural-exit",
    payload: { text: "Respond once, then exit." },
  })

  // Wait for streamed output, then for the natural exit → Terminated to
  // propagate and the observer-delivered terminal input to run deregister.
  let waited = yield* session.wait.forAgentOutput({ timeoutMs: 8_000 })
  const outputTags: Array<string> = []
  let remaining = 12
  while (waited.matched && waited.output._tag !== "Terminated" && remaining > 0) {
    outputTags.push(waited.output._tag)
    waited = yield* session.wait.forAgentOutput({ timeoutMs: 8_000 })
    remaining -= 1
  }
  if (waited.matched) outputTags.push(waited.output._tag)
  // Let the journaled Terminated reach the observer and the terminal per-event
  // execution run `adapter.deregister`.
  yield* Effect.sleep("2500 millis")

  return {
    contextId: launched.contextId,
    startRecorded: startOffset.offset.length > 0,
    promptRecorded: promptOffset.offset.length > 0,
    terminatedObserved: outputTags.includes("Terminated"),
    outputCount: outputTags.length,
    outputTags: outputTags.join(","),
  }
}))

export const naturalExitTerminalDriver = Effect.gen(function*() {
  const scenario = yield* runScenario

  yield* Effect.annotateCurrentSpan({
    "firegrid.r06u36.context_id": scenario.contextId,
    "firegrid.r06u36.start_recorded": scenario.startRecorded,
    "firegrid.r06u36.prompt_recorded": scenario.promptRecorded,
    "firegrid.r06u36.terminated_observed": scenario.terminatedObserved,
    "firegrid.r06u36.output_count": scenario.outputCount,
    "firegrid.r06u36.output_tags": scenario.outputTags,
    "firegrid.r06u36.spawn_target": "src/bin/self-exiting-acp-agent-process.ts",
    "firegrid.r06u36.codec": "acp",
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.natural_exit_terminal.driver", {
    kind: "internal",
  }),
)
