import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Clock, Effect, Schedule } from "effect"

/* eslint-disable local/no-fixed-polling -- bounded Phase-0 empirical probe through the public client wait surface. */

interface Phase0Wave2APermissionStreamResult {
  readonly verdict: "GREEN-zip-2"
  readonly sessionId: string
  readonly observedTags: ReadonlyArray<string>
  readonly observedToolNames: ReadonlyArray<string>
  readonly sawToolUse: boolean
  readonly sawPermissionRequest: boolean
  readonly permissionAllowed: boolean
  readonly sawResultMarker: boolean
  readonly resultText: string
}

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const resultMarker = "FIREGRID_PHASE0_WAVE2A_PERMISSION_STREAM_DONE"

const promptForPermissionProbe = [
  "Use the MCP server available in this ACP session.",
  "Make exactly one call to the Firegrid `sleep` tool with durationMs 0.",
  `After that tool call returns, respond with exactly this line: ${resultMarker}`,
  "Do not call any tool more than once. Do not answer before the tool call.",
].join("\n")

export const phase0Wave2APermissionStreamDriver: Effect.Effect<
  Phase0Wave2APermissionStreamResult,
  unknown,
  Firegrid
> = Effect.gen(function* () {
  const firegrid = yield* Firegrid
  const runId = yield* Clock.currentTimeMillis
  const session = yield* firegrid.sessions.createOrLoad({
    externalKey: {
      source: "tiny-firegrid",
      id: `phase0-wave-2a-permission-stream-${runId}`,
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
    payload: promptForPermissionProbe,
    idempotencyKey: `phase0-wave-2a-permission-stream:${runId}:turn-1`,
  }).pipe(
    Effect.retry(
      Schedule.intersect(
        Schedule.spaced("1000 millis"),
        Schedule.recurs(60),
      ),
    ),
  )
  yield* session.start()

  const deadline = (yield* Clock.currentTimeMillis) + 60_000
  let afterSequence: number | undefined
  let sawToolUse = false
  let sawPermissionRequest = false
  let permissionAllowed = false
  let sawResultMarker = false
  let resultText = ""
  const observedTags = new Set<string>()
  const observedToolNames = new Set<string>()

  while (!sawResultMarker && (yield* Clock.currentTimeMillis) < deadline) {
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
    observedTags.add(event._tag)
    if (event._tag === "ToolUse") {
      sawToolUse = true
      observedToolNames.add(event.part.name)
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
      if (resultText.includes(resultMarker)) sawResultMarker = true
    }
  }

  const verdict: Phase0Wave2APermissionStreamResult["verdict"] = "GREEN-zip-2"

  yield* Effect.annotateCurrentSpan({
    "firegrid.phase0.wave2a.verdict": verdict,
    "firegrid.phase0.wave2a.saw_tool_use": sawToolUse,
    "firegrid.phase0.wave2a.saw_permission_request": sawPermissionRequest,
    "firegrid.phase0.wave2a.permission_allowed": permissionAllowed,
    "firegrid.phase0.wave2a.saw_result_marker": sawResultMarker,
    "firegrid.phase0.wave2a.observed_tags": [...observedTags].sort().join(","),
    "firegrid.phase0.wave2a.observed_tool_names": [...observedToolNames]
      .sort()
      .join(","),
  })

  if (!sawToolUse) {
    return yield* Effect.fail(new Error("agent did not issue a tool use"))
  }
  if (!sawPermissionRequest) {
    return yield* Effect.fail(new Error("agent did not emit a permission request"))
  }
  if (!permissionAllowed) {
    return yield* Effect.fail(new Error("permission response was not accepted"))
  }

  return {
    verdict,
    sessionId: session.contextId,
    observedTags: [...observedTags].sort(),
    observedToolNames: [...observedToolNames].sort(),
    sawToolUse,
    sawPermissionRequest,
    permissionAllowed,
    sawResultMarker,
    resultText,
  }
}).pipe(
  Effect.withSpan("firegrid.phase0.wave2a.permission_stream.driver", {
    kind: "client",
  }),
)

/* eslint-enable local/no-fixed-polling */
