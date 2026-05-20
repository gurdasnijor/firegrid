import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Clock, Effect, Schedule } from "effect"
import { factCorrelationId, factEventType, factSource } from "./host.ts"

/* eslint-disable local/no-fixed-polling -- empirical sim poll loop through the public client wait surface; methodology.md keeps this shape explicit. */

interface WorkflowCorePathsResult {
  readonly sessionId: string
  readonly observedToolNames: ReadonlyArray<string>
  readonly sawWaitForCall: boolean
  readonly sawPermissionRequest: boolean
  readonly permissionAllowed: boolean
  readonly sawResultMarker: boolean
  readonly sawTurnComplete: boolean
  readonly resultText: string
}

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

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
  "When `wait_for` returns, emit one line: FIREGRID_WORKFLOW_CORE_PATHS:<json>",
  "where <json> is the matched row. Then stop.",
].join("\n")

export const workflowCorePathsDriver: Effect.Effect<
  WorkflowCorePathsResult,
  unknown,
  Firegrid
> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const session = yield* firegrid.sessions.createOrLoad({
    externalKey: {
      source: "tiny-firegrid",
      id: "workflow-core-paths",
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
    idempotencyKey: "workflow-core-paths:turn-1",
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
      if (event.part.name === "wait_for" || event.part.name.endsWith("__wait_for")) {
        sawWaitForCall = true
      }
    }
    if (event._tag === "PermissionRequest") {
      sawPermissionRequest = true
      const decision = yield* session.permissions.respond({
        permissionRequestId: event.permissionRequestId,
        decision: { _tag: "Allow", optionId: "allow" },
      }).pipe(Effect.either)
      if (decision._tag === "Right") permissionAllowed = true
    }
    if (event._tag === "TextChunk") {
      resultText += event.part.delta
      if (resultText.includes("FIREGRID_WORKFLOW_CORE_PATHS")) sawResultMarker = true
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
