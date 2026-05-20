import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Clock, Effect } from "effect"

interface CodexAcpToolCallSimulationResult {
  readonly sawReady: boolean
  readonly sawSleepToolUse: boolean
  // Every ToolUse part.name the real agent surfaced (evidence: answers
  // "did a real MCP tool-call round-trip happen, and under what name").
  readonly observedToolNames: ReadonlyArray<string>
  readonly sawAnyToolUse: boolean
  readonly resultText: string
}

const codexAcpArgv = [
  "npx",
  "-y",
  "@zed-industries/codex-acp@0.14.0",
] as const

const promptForToolCall = [
  "Use the MCP server available in this ACP session.",
  "Make EXACTLY ONE call to the Firegrid `sleep` tool with durationMs 0.",
  "Immediately after that single tool call returns, respond with this",
  "exact line and nothing else: FIREGRID_TOOL_RESULT sleep slept=true",
  "Do not call any tool more than once. Do not answer before the call.",
].join("\n")

export const codexAcpToolCallDriver: Effect.Effect<
  CodexAcpToolCallSimulationResult,
  unknown,
  Firegrid
> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: "codex-acp-tool-calls",
      },
      runtime: local.jsonl({
        argv: [...codexAcpArgv],
        agent: "codex-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "OPENAI_API_KEY", ref: "env:OPENAI_API_KEY" },
        ],
        runtimeContextMcp: { enabled: true },
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.whenReady
    yield* session.prompt({
      payload: promptForToolCall,
      idempotencyKey: "codex-acp-tool-calls:turn-1",
    })
    yield* session.start()

    const deadline = (yield* Clock.currentTimeMillis) + 260_000
    let sawReady = false
    let sawSleepToolUse = false
    let resultText = ""
    let afterSequence: number | undefined
    const observedToolNames = new Set<string>()

    while (
      !(sawReady && observedToolNames.size > 0 &&
        resultText.includes("FIREGRID_TOOL_RESULT"))
    ) {
      if ((yield* Clock.currentTimeMillis) >= deadline) break
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 15_000,
      })
      if (!next.matched) continue
      const observation = next.output
      afterSequence = observation.sequence
      const event = observation.event
      if (event._tag === "Ready") sawReady = true
      if (event._tag === "ToolUse") {
        observedToolNames.add(event.part.name)
        if (event.part.name === "sleep") sawSleepToolUse = true
      }
      if (event._tag === "TextChunk") resultText += event.part.delta
    }

    return {
      sawReady,
      sawSleepToolUse,
      observedToolNames: [...observedToolNames].sort(),
      sawAnyToolUse: observedToolNames.size > 0,
      resultText,
    }
  })
