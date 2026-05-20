import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Clock, Effect, Schedule } from "effect"
import {
  codecStdioJsonlProbeSnapshot,
  codecStdioJsonlProbeUrl,
  probeResultMarker,
  probeToolName,
} from "./host.ts"

/* eslint-disable local/no-fixed-polling -- empirical sim poll loop through the public client wait surface. */

interface CodecStdioJsonlLiveResult {
  readonly sessionId: string
  readonly codexMcpMethods: ReadonlyArray<string>
  readonly codexMcpToolCallCount: number
  readonly codexJsonlTypes: ReadonlyArray<string>
  readonly codexMcpToolAttempts: ReadonlyArray<string>
  readonly codexMcpToolFailures: ReadonlyArray<string>
  readonly sawReady: boolean
  readonly sawCodecDecodeError: boolean
  readonly sawRuntimeToolUse: boolean
  readonly sawRuntimeToolResultRoundtrip: boolean
  readonly sawTurnComplete: boolean
  readonly sawTerminated: boolean
  readonly resultText: string
}

const codexPrompt = [
  "You have an MCP server named firegrid_stdio_probe with one tool named",
  `\`${probeToolName}\`. Call that tool exactly once with {"phrase":"live"}.`,
  `Then reply with ${probeResultMarker} and stop.`,
].join(" ")

const codexCliBridgeSource = (
  mcpUrl: string,
) => {
  const mcpConfigArg = `mcp_servers.firegrid_stdio_probe.url=${JSON.stringify(mcpUrl)}`
  return `
const { spawn } = require("node:child_process")

let buffer = ""
let launched = false

const launch = () => {
  if (launched) return
  launched = true
  const child = spawn("codex", [
    "--sandbox", "read-only",
    "-a", "never",
    "-c", ${JSON.stringify(mcpConfigArg)},
    "exec",
    "--json",
    "--cd", process.cwd(),
    ${JSON.stringify(codexPrompt)}
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"]
  })
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 1)
  })
  child.on("error", (error) => {
    console.error(error && error.stack ? error.stack : String(error))
    process.exit(1)
  })
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  buffer += chunk
  if (buffer.includes("\\n")) launch()
})
setTimeout(launch, 5000)
`
}

const codexArgv = [
  "node",
  "-e",
  codexCliBridgeSource(codecStdioJsonlProbeUrl),
] as const

const firegridPrompt = [
  "Firegrid stdio-jsonl live probe turn 1.",
  "The child process is a real Codex CLI run.",
  "If this were a compatible stdio-jsonl agent, it would emit Firegrid text/tool_use/turn_complete events.",
].join("\n")

const isRecoverableUnsupportedCodexEvent = (cause: unknown): boolean =>
  JSON.stringify(cause).includes("unsupported stdio-jsonl event type")

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined

const unsupportedCodexRecord = (
  cause: unknown,
): Record<string, unknown> | undefined => {
  const record = asRecord(cause)
  return asRecord(record?.["cause"])
}

const codexMcpToolSummary = (
  record: Record<string, unknown>,
): string | undefined => {
  const item = asRecord(record["item"])
  if (item?.["type"] !== "mcp_tool_call") return undefined
  const server = typeof item["server"] === "string" ? item["server"] : "unknown-server"
  const tool = typeof item["tool"] === "string" ? item["tool"] : "unknown-tool"
  const status = typeof item["status"] === "string" ? item["status"] : "unknown-status"
  return `${server}.${tool}:${status}`
}

const codexMcpFailureMessage = (
  record: Record<string, unknown>,
): string | undefined => {
  const item = asRecord(record["item"])
  const error = asRecord(item?.["error"])
  return typeof error?.["message"] === "string" ? error["message"] : undefined
}

export const codecStdioJsonlLiveDriver: Effect.Effect<
  CodecStdioJsonlLiveResult,
  unknown,
  Firegrid
> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const externalId = "codec-stdio-jsonl-live"
  const session = yield* firegrid.sessions.createOrLoad({
    externalKey: {
      source: "tiny-firegrid",
      id: externalId,
    },
    runtime: local.jsonl({
      argv: [...codexArgv],
      agent: "codex-cli",
      agentProtocol: "stdio-jsonl",
      cwd: globalThis.process.cwd(),
      envBindings: [
        { name: "OPENAI_API_KEY", ref: "env:OPENAI_API_KEY" },
      ],
    }),
    createdBy: "tiny-firegrid-simulation",
  })

  // firegrid-runtime-agent-event-pipeline.VALIDATION.2
  // firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.6
  yield* session.prompt({
    payload: firegridPrompt,
    idempotencyKey: `${externalId}:turn-1`,
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
  let sawReady = false
  let sawCodecDecodeError = false
  let sawRuntimeToolUse = false
  let sawRuntimeToolResultRoundtrip = false
  let sawTurnComplete = false
  let sawTerminated = false
  let codecAdvertisesTools = false
  let codecAdvertisesMultiTurn = false
  let resultText = ""
  const codexJsonlTypes = new Set<string>()
  const codexMcpToolAttempts = new Set<string>()
  const codexMcpToolFailures = new Set<string>()

  while (!sawTerminated && (yield* Clock.currentTimeMillis) < deadline) {
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
    if (event._tag === "Ready") {
      sawReady = true
      codecAdvertisesTools = event.capabilities.tools
      codecAdvertisesMultiTurn = event.capabilities.multiTurn
    }
    if (event._tag === "Error" && isRecoverableUnsupportedCodexEvent(event.cause)) {
      sawCodecDecodeError = true
      const record = unsupportedCodexRecord(event.cause)
      const type = record?.["type"]
      if (typeof type === "string") codexJsonlTypes.add(type)
      const toolSummary = record === undefined ? undefined : codexMcpToolSummary(record)
      if (toolSummary !== undefined) codexMcpToolAttempts.add(toolSummary)
      const failure = record === undefined ? undefined : codexMcpFailureMessage(record)
      if (failure !== undefined) codexMcpToolFailures.add(failure)
    }
    if (event._tag === "ToolUse") sawRuntimeToolUse = true
    if (event._tag === "TextChunk") {
      resultText += event.part.delta
      if (resultText.includes(probeResultMarker)) {
        sawRuntimeToolResultRoundtrip = true
      }
    }
    if (event._tag === "TurnComplete") sawTurnComplete = true
    if (event._tag === "Terminated") sawTerminated = true
  }

  const probe = codecStdioJsonlProbeSnapshot()
  const codexMcpToolCallCount = probe.toolCalls.length
  yield* Effect.annotateCurrentSpan({
    "firegrid.codec_stdio_jsonl_live.codec_advertises_tools": codecAdvertisesTools,
    "firegrid.codec_stdio_jsonl_live.codec_advertises_multi_turn": codecAdvertisesMultiTurn,
    "firegrid.codec_stdio_jsonl_live.codex_mcp_methods": probe.methods.join(","),
    "firegrid.codec_stdio_jsonl_live.codex_mcp_tool_call_count": codexMcpToolCallCount,
    "firegrid.codec_stdio_jsonl_live.codex_jsonl_types": [...codexJsonlTypes].sort().join(","),
    "firegrid.codec_stdio_jsonl_live.codex_mcp_tool_attempts": [...codexMcpToolAttempts].sort().join(","),
    "firegrid.codec_stdio_jsonl_live.codex_mcp_tool_failures": [...codexMcpToolFailures].sort().join(","),
    "firegrid.codec_stdio_jsonl_live.saw_codec_decode_error": sawCodecDecodeError,
    "firegrid.codec_stdio_jsonl_live.saw_runtime_tool_use": sawRuntimeToolUse,
    "firegrid.codec_stdio_jsonl_live.saw_runtime_tool_result_roundtrip": sawRuntimeToolResultRoundtrip,
  })

  return {
    sessionId: session.contextId,
    codexMcpMethods: probe.methods,
    codexMcpToolCallCount,
    codexJsonlTypes: [...codexJsonlTypes].sort(),
    codexMcpToolAttempts: [...codexMcpToolAttempts].sort(),
    codexMcpToolFailures: [...codexMcpToolFailures].sort(),
    sawReady,
    sawCodecDecodeError,
    sawRuntimeToolUse,
    sawRuntimeToolResultRoundtrip,
    sawTurnComplete,
    sawTerminated,
    resultText,
  }
}).pipe(
  Effect.withSpan("firegrid.codec_stdio_jsonl_live.driver", {
    kind: "client",
  }),
)

/* eslint-enable local/no-fixed-polling */
