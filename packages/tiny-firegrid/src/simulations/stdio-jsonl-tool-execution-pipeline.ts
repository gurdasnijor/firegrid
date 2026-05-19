import {
  FiregridRuntimeHostLive,
  type RuntimeHostTopologyOptions,
} from "@firegrid/host-sdk"
import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"
import { Clock, Effect, Schedule } from "effect"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client simulation retry backoff. */

interface StdioJsonlToolExecutionSimulationResult {
  readonly sawReady: boolean
  readonly sawToolUse: boolean
  readonly sawToolResultRoundtrip: boolean
  readonly sawNoHostRoundtrip: boolean
  readonly sawTurnComplete: boolean
  readonly resultText: string
}

// Self-contained deterministic stdio-JSONL agent. NOT an LLM and NOT a real
// provider: it speaks the Firegrid stdio-jsonl wire protocol
// (packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl) directly so
// the simulation traces the NON-MCP tool-execution substrate path
// deterministically. On a prompt it emits a single Firegrid `sleep`
// tool_use and waits for the host to round-trip a tool_result; it always
// terminates the turn (round-trip OR a deterministic NO_HOST_ROUNDTRIP
// marker) so the trace empirically records whether the stdio-jsonl
// transport executes a host tool round-trip.
const deterministicStdioJsonlAgentSource = `
const lines = []
let buf = ""
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n")
const TOOL = "sleep"
const TOOL_USE_ID = "stdio-jsonl-tool-1"
let emittedToolUse = false
let finished = false
const finish = (text) => {
  if (finished) return
  finished = true
  out({ type: "text", text })
  out({ type: "turn_complete", finishReason: "stop" })
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line.length === 0) continue
    let msg
    try { msg = JSON.parse(line) } catch (_e) { continue }
    if (msg && msg.type === "prompt" && !emittedToolUse) {
      emittedToolUse = true
      out({ type: "status", kind: "accepted" })
      out({ type: "tool_use", toolUseId: TOOL_USE_ID, name: TOOL, input: { durationMs: 0 } })
      setTimeout(() => {
        finish("FIREGRID_TOOL_RESULT " + TOOL + " NO_HOST_ROUNDTRIP")
      }, 8000)
    } else if (msg && msg.type === "tool_result" && msg.toolUseId === TOOL_USE_ID) {
      finish("FIREGRID_TOOL_RESULT " + TOOL + " slept=true")
    }
  }
})
process.stdin.on("end", () => { finish("FIREGRID_TOOL_RESULT " + TOOL + " STDIN_CLOSED") })
`

const stdioJsonlArgv = [
  "node",
  "-e",
  deterministicStdioJsonlAgentSource,
] as const

const promptForToolCall = [
  "Deterministic stdio-jsonl substrate probe.",
  "Emit exactly one Firegrid sleep tool_use and report the round-trip result.",
].join("\n")

// Self-contained host-compose. Deliberately does NOT import
// packages/tiny-firegrid/src/configurations/ (that directory is slated for
// deletion); the stdio-jsonl host topology is inlined here. No MCP server
// layer: this is the non-MCP stdio-jsonl transport, the high-signal
// contrast to the ACP/MCP path.
const makeStdioJsonlHost = (
  env: TinyFiregridSimulationEnv,
): ReturnType<typeof FiregridRuntimeHostLive> => {
  const hostId = "host-a"
  const localProcessEnv: RuntimeHostTopologyOptions["localProcessEnv"] | undefined =
    env.localProcessEnv
  return FiregridRuntimeHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    hostId,
    hostSessionId: `${hostId}-session`,
    input: true,
    ...(localProcessEnv === undefined ? {} : { localProcessEnv }),
  })
}

const stdioJsonlToolExecutionDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<StdioJsonlToolExecutionSimulationResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: env.runId,
      },
      runtime: local.jsonl({
        argv: [...stdioJsonlArgv],
        agent: "stdio-jsonl-fixture",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: promptForToolCall,
      idempotencyKey: `${env.runId}:turn-1`,
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(60),
        ),
      ),
    )
    yield* session.start()

    const deadline = (yield* Clock.currentTimeMillis) + 200_000
    let sawReady = false
    let sawToolUse = false
    let sawToolResultRoundtrip = false
    let sawNoHostRoundtrip = false
    let sawTurnComplete = false
    let resultText = ""
    let afterSequence: number | undefined

    while (!(sawTurnComplete || sawToolResultRoundtrip || sawNoHostRoundtrip)) {
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
      if (event._tag === "Ready") sawReady = true
      if (event._tag === "ToolUse" && event.part.name === "sleep") {
        sawToolUse = true
      }
      if (event._tag === "TextChunk") {
        resultText += event.part.delta
        if (resultText.includes("FIREGRID_TOOL_RESULT sleep slept=true")) {
          sawToolResultRoundtrip = true
        }
        if (resultText.includes("NO_HOST_ROUNDTRIP")) {
          sawNoHostRoundtrip = true
        }
      }
      if (event._tag === "TurnComplete") sawTurnComplete = true
    }

    return {
      sawReady,
      sawToolUse,
      sawToolResultRoundtrip,
      sawNoHostRoundtrip,
      sawTurnComplete,
      resultText,
    }
  })

export const stdioJsonlToolExecutionSimulation = {
  id: "stdio-jsonl-tool-execution-pipeline",
  description:
    "Drives the inlined non-MCP stdio-JSONL host topology with a deterministic stdio-jsonl agent through the public Firegrid client until a Firegrid sleep tool round-trip (or its deterministic absence) is observed. Substrate-property trace of the non-MCP agent transport.",
  makeHost: env => makeStdioJsonlHost(env),
  driver: stdioJsonlToolExecutionDriver,
  summarize: result => ({
    sawReady: result.sawReady,
    sawToolUse: result.sawToolUse,
    sawToolResultRoundtrip: result.sawToolResultRoundtrip,
    sawNoHostRoundtrip: result.sawNoHostRoundtrip,
    sawTurnComplete: result.sawTurnComplete,
    resultTextExcerpt: result.resultText.slice(0, 600),
  }),
  localize: result =>
    result.sawToolUse && !result.sawToolResultRoundtrip
      ? [
        "stdio-jsonl ToolUse was observed but the host did not round-trip a tool_result back over stdin.",
        "FINDING CANDIDATE: the non-MCP stdio-jsonl transport surfaced a ToolUse with no host-side tool-execution round-trip.",
        "Inspect the stdio_jsonl codec spans (send/decode_line) and the host tool-execution path for this run.",
      ]
      : !result.sawToolUse
      ? [
        "No stdio-jsonl ToolUse was observed; inspect codec decode_line spans and whether the prompt reached the agent stdin.",
      ]
      : [
        "Inspect the DuckDB span tables for the stdio-jsonl codec, host, workflow, and durable-table path taken by this run.",
      ],
} satisfies TinyFiregridSimulation<StdioJsonlToolExecutionSimulationResult>

/* eslint-enable local/no-fixed-polling */
