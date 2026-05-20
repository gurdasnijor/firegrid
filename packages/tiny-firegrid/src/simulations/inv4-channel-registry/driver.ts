import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Clock, Effect, Schedule } from "effect"
import {
  channelName,
  inv4ChannelMcpUrl,
  resultMarker,
  sessionExternalId,
  type ChannelWaitInput,
} from "./host.ts"

/* eslint-disable local/no-fixed-polling -- empirical sim poll loop through the public client wait surface; the finding records the observed tool input. */

interface Inv4ChannelRegistryResult {
  readonly sessionId: string
  readonly mcpUrl: string
  readonly observedToolNames: ReadonlyArray<string>
  readonly observedToolInputs: ReadonlyArray<string>
  readonly sawWaitForCall: boolean
  readonly toolInputContainedOnlyChannelSurface: boolean
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

const waitForInput: ChannelWaitInput = {
  channel: channelName,
  timeoutMs: 30_000,
}

const promptForChannelWait = [
  "You have one MCP tool named `wait_for` from the channel registry server.",
  "",
  "Call `wait_for` exactly once with this JSON input and no other keys:",
  JSON.stringify(waitForInput, null, 2),
  "",
  `When the tool returns, emit one line: ${resultMarker}:<json>`,
  "where <json> is the returned tool result. Then stop.",
].join("\n")

const inputUsesOnlyChannelSurface = (inputJson: string): boolean => {
  if (!inputJson.includes("\"channel\"")) return false
  if (inputJson.includes("\"source\"") || inputJson.includes("\"_tag\"") || inputJson.includes("\"stream\"")) {
    return false
  }
  return inputJson.includes(channelName)
}

export const inv4ChannelRegistryDriver: Effect.Effect<
  Inv4ChannelRegistryResult,
  unknown,
  Firegrid
> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const mcpUrl = yield* Effect.promise(() => inv4ChannelMcpUrl).pipe(
    Effect.timeoutFail({
      duration: "30 seconds",
      onTimeout: () => new Error("timed out waiting for inv4 channel MCP URL"),
    }),
  )
  const session = yield* firegrid.sessions.createOrLoad({
    externalKey: {
      source: "tiny-firegrid",
      id: sessionExternalId,
    },
    runtime: local.jsonl({
      argv: [...claudeAcpArgv],
      agent: "claude-acp",
      agentProtocol: "acp",
      cwd: globalThis.process.cwd(),
      envBindings: [
        { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
      ],
      mcpServers: [
        {
          name: "channel-registry",
          server: {
            type: "url",
            url: mcpUrl,
          },
        },
      ],
    }),
    createdBy: "tiny-firegrid-simulation",
  })

  yield* session.prompt({
    payload: promptForChannelWait,
    idempotencyKey: `${sessionExternalId}:turn-1`,
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
  const observedToolInputs: Array<string> = []

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
      const inputJson = JSON.stringify(event.part.params)
      observedToolInputs.push(inputJson)
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
      if (resultText.includes(resultMarker)) sawResultMarker = true
    }
    if (event._tag === "TurnComplete") sawTurnComplete = true
  }

  const toolInputContainedOnlyChannelSurface = observedToolInputs.some(
    inputUsesOnlyChannelSurface,
  )

  yield* Effect.annotateCurrentSpan({
    "firegrid.inv4.verdict.saw_wait_for_call": sawWaitForCall,
    "firegrid.inv4.verdict.agent_input_channel_only": toolInputContainedOnlyChannelSurface,
    "firegrid.inv4.verdict.saw_result_marker": sawResultMarker,
    "firegrid.inv4.observed_tool_names": [...observedToolNames].sort().join(","),
  })

  if (!sawWaitForCall) {
    return yield* Effect.fail(new Error("agent did not call wait_for"))
  }
  if (!toolInputContainedOnlyChannelSurface) {
    return yield* Effect.fail(
      new Error("wait_for input did not stay on the opaque channel surface"),
    )
  }
  if (!sawResultMarker) {
    return yield* Effect.fail(new Error("agent did not emit result marker"))
  }

  return {
    sessionId: session.contextId,
    mcpUrl,
    observedToolNames: [...observedToolNames].sort(),
    observedToolInputs,
    sawWaitForCall,
    toolInputContainedOnlyChannelSurface,
    sawPermissionRequest,
    permissionAllowed,
    sawResultMarker,
    sawTurnComplete,
    resultText,
  }
}).pipe(
  Effect.withSpan("firegrid.inv4.channel_registry.driver", {
    kind: "client",
  }),
)

/* eslint-enable local/no-fixed-polling */
