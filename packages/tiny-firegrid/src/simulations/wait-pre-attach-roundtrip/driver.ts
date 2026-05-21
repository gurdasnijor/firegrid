import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"
import { factCorrelationId, factEventType, factSource } from "./host.ts"

// claude-agent-acp is the agent that surfaces the §6 ToolSearch /
// alwaysLoad behavior the codec is trying to work around. Same prompt
// against codex-acp would not exercise that path.
const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

// Short imperative prompt. NO tutorial, NO contract recital, NO halt
// protocol decorated with line-prefix tokens. If the agent can't make a
// single tool call from this much context, that's the finding — not
// papered over by a 60-line walkthrough.
const promptForWaitForCall = [
  "You have a Firegrid runtime-context MCP toolset available, including `wait_for`.",
  "",
  "Call `wait_for` exactly once with this query:",
  JSON.stringify(
    {
      waitQuery: {
        source: { _tag: "CallerFact", stream: factSource },
        whereFields: {
          correlationId: factCorrelationId,
          eventType: factEventType,
        },
      },
      timeoutMs: 30_000,
    },
    null,
    2,
  ),
  "",
  "When `wait_for` returns, emit one line: FIREGRID_WAIT_OBSERVED:<json>",
  "where <json> is the matched row. Then stop.",
].join("\n")

const waitObservedMarker = "FIREGRID_WAIT_OBSERVED"

export const waitPreAttachDriver: Effect.Effect<void, unknown, Firegrid> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const session = yield* firegrid.sessions.createOrLoad({
    externalKey: {
      source: "tiny-firegrid",
      id: "wait-pre-attach-roundtrip",
    },
    runtime: local.jsonl({
      argv: [...claudeAcpArgv],
      agent: "claude-acp",
      agentProtocol: "acp",
      cwd: globalThis.process.cwd(),
      envBindings: [
        { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
      ],
      runtimeContextMcp: { enabled: true },
    }),
    createdBy: "tiny-firegrid-simulation",
  })

  // tf-2osu KEEP: gates the forked permissions.autoApprove loop, which eagerly
  // resolves the context and would die with PreloadError if it ran before the
  // context materialized. autoApprove has no internal readiness barrier (it is
  // not a prompt/start dependent write), so this is not covered by tf-1r3h.
  yield* session.whenReady
  yield* session.permissions.autoApprove("allow", { timeoutMs: 30_000 })
  yield* session.prompt({
    payload: promptForWaitForCall,
    idempotencyKey: "wait-pre-attach-roundtrip:turn-1",
  })
  yield* session.start()

  let afterSequence: number | undefined
  let resultText = ""
  while (true) {
    const next = yield* session.wait.forAgentOutput({
      ...(afterSequence === undefined ? {} : { afterSequence }),
      timeoutMs: 15_000,
    })
    if (!next.matched) continue
    afterSequence = next.output.sequence
    const event = next.output.event
    if (event._tag === "TextChunk") {
      resultText += event.part.delta
      if (resultText.includes(waitObservedMarker)) return
    }
  }
}).pipe(Effect.scoped)
