import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Clock, Effect, Schedule } from "effect"
import { factCorrelationId, factEventType, factSource } from "./host.ts"

/* eslint-disable local/no-fixed-polling -- public-client simulation retry backoff; same SDK readiness gap as codex-acp-tool-calls, tracked under session.whenReady follow-up. */

interface WaitPreAttachResult {
  readonly sessionId: string
  readonly observedToolNames: ReadonlyArray<string>
  readonly sawWaitForCall: boolean
  readonly sawPermissionRequest: boolean
  readonly permissionAllowed: boolean
  readonly sawResultMarker: boolean
  readonly sawTurnComplete: boolean
  readonly resultText: string
}

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

export const waitPreAttachDriver: Effect.Effect<
  WaitPreAttachResult,
  unknown,
  Firegrid
> = Effect.gen(function*() {
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

  yield* session.prompt({
    payload: promptForWaitForCall,
    idempotencyKey: "wait-pre-attach-roundtrip:turn-1",
  }).pipe(
    Effect.retry(
      Schedule.intersect(
        Schedule.spaced("1000 millis"),
        Schedule.recurs(60),
      ),
    ),
  )
  yield* session.start()

  const deadline = (yield* Clock.currentTimeMillis) + 180_000
  let afterSequence: number | undefined
  let sawWaitForCall = false
  let sawPermissionRequest = false
  let permissionAllowed = false
  let sawResultMarker = false
  let sawTurnComplete = false
  let resultText = ""
  const observedToolNames = new Set<string>()

  while (!sawResultMarker && !sawTurnComplete) {
    if ((yield* Clock.currentTimeMillis) >= deadline) break
    const next = yield* session.wait.forAgentOutput({
      ...(afterSequence === undefined ? {} : { afterSequence }),
      timeoutMs: 15_000,
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(5),
        ),
      ),
    )
    if (!next.matched) continue
    const observation = next.output
    afterSequence = observation.sequence
    const event = observation.event
    if (event._tag === "ToolUse") {
      observedToolNames.add(event.part.name)
      // claude-agent-acp issues tool calls under an MCP-prefixed name
      // (`mcp__firegrid-runtime-context__wait_for`). Match the suffix
      // rather than the bare name.
      if (event.part.name === "wait_for" || event.part.name.endsWith("__wait_for")) {
        sawWaitForCall = true
      }
    }
    if (event._tag === "PermissionRequest") {
      // claude-agent-acp surfaces every tool call through a permission
      // gate. Without an answer the agent stalls indefinitely. For this
      // MRC we auto-allow so the tool actually executes and we can
      // observe the wait_router's pre-attach delivery behavior.
      sawPermissionRequest = true
      const decision = yield* session.permissions.respond({
        permissionRequestId: event.permissionRequestId,
        decision: { _tag: "Allow", optionId: "allow" },
      }).pipe(Effect.either)
      if (decision._tag === "Right") permissionAllowed = true
    }
    if (event._tag === "TextChunk") {
      resultText += event.part.delta
      if (resultText.includes("FIREGRID_WAIT_OBSERVED")) sawResultMarker = true
    }
    if (event._tag === "TurnComplete") sawTurnComplete = true
  }

  return {
    sessionId: session.contextId,
    observedToolNames: [...observedToolNames].sort(),
    sawWaitForCall,
    sawPermissionRequest,
    permissionAllowed,
    sawResultMarker,
    sawTurnComplete,
    resultText,
  }
})

/* eslint-enable local/no-fixed-polling */
