import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

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

const toolResultMarker = "FIREGRID_TOOL_RESULT sleep slept=true"

export const codexAcpToolCallDriver: Effect.Effect<void, unknown, Firegrid> =
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

    yield* session.prompt({
      payload: promptForToolCall,
      idempotencyKey: "codex-acp-tool-calls:turn-1",
    })
    yield* session.start()

    let afterSequence: number | undefined
    let resultText = ""
    while (true) {
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 15_000,
      })
      if (next.matched) {
        afterSequence = next.output.sequence
        const event = next.output.event
        if (event._tag === "TextChunk") {
          resultText += event.part.delta
          if (resultText.includes(toolResultMarker)) return
        }
      }
    }
  })
