import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

// tf-7kq8 reproduction with the REAL agent that produced the bug
// (claude-agent-acp@0.36.1) over the production runtime-context path. We ask it
// to call a Firegrid tool — the exact interaction that hung live Zed turns. The
// agent streams output over time, so the runtime-context workflow processes
// output across many resumes; on `main` the body re-walks the whole output
// history with a live full-scan `events.initial` read on every resume (cursor in
// a non-durable Ref that resets to -1), giving the agent_output.initial storm.
// The fix memoizes immutable Some reads so the re-walk is O(distinct outputs).
const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

// The exact interaction that hung live Zed turns: ask the real agent to call a
// Firegrid tool. The agent streams output across many runtime-context workflow
// resumes (the re-read amplification this fix targets) AND issues the MCP
// tool-call round trip. Permissions are auto-approved (claude-agent-acp gates
// tool calls behind canUseTool; without approval the call never reaches the
// handler, which is why an un-approved run shows McpServer.tools/call: 0).
const prompt = [
  "You have a Firegrid runtime-context MCP toolset available, including `sleep`.",
  "Call `sleep` exactly once with durationMs 0.",
  "When `sleep` returns, emit one line: FIREGRID_SLEEP_DONE then stop.",
].join("\n")

const marker = "FIREGRID_SLEEP_DONE"

interface OutputReplayStormResult {
  readonly outputsObserved: number
  readonly sawMarker: boolean
  readonly sawTurnComplete: boolean
}

export const tf7kq8OutputReplayStormDriver: Effect.Effect<
  OutputReplayStormResult,
  unknown,
  Firegrid
> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const session = yield* firegrid.sessions.createOrLoad({
    externalKey: { source: "tiny-firegrid", id: "tf-7kq8-output-replay-storm" },
    runtime: local.jsonl({
      argv: [...claudeAcpArgv],
      agent: "claude-acp",
      agentProtocol: "acp",
      cwd: globalThis.process.cwd(),
      envBindings: [{ name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" }],
      runtimeContextMcp: { enabled: true },
    }),
    createdBy: "tiny-firegrid-simulation",
  })

  yield* session.permissions.autoApprove("allow", { timeoutMs: 30_000 })
  yield* session.prompt({
    payload: prompt,
    idempotencyKey: "tf-7kq8-output-replay-storm:turn-1",
  })
  yield* session.start()

  let afterSequence: number | undefined
  let outputsObserved = 0
  let sawMarker = false
  let sawTurnComplete = false
  let text = ""
  while (!sawTurnComplete && !sawMarker) {
    const next = yield* session.wait.forAgentOutput({
      ...(afterSequence === undefined ? {} : { afterSequence }),
      timeoutMs: 30_000,
    })
    if (!next.matched) break
    afterSequence = next.output.sequence
    outputsObserved += 1
    const event = next.output.event
    if (event._tag === "TextChunk") {
      text += event.part.delta
      if (text.includes(marker)) sawMarker = true
    }
    if (event._tag === "TurnComplete") sawTurnComplete = true
  }

  return { outputsObserved, sawMarker, sawTurnComplete }
}).pipe(Effect.scoped)
