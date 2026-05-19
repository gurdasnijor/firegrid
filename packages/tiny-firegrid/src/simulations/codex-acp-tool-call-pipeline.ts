import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  codexAcpOpenAiEnvPolicy,
  tinyCodexAcpToolCallPipeline,
} from "../configurations/codex-acp-tool-call-pipeline.ts"
import type { TinyFiregridSimulation, TinyFiregridSimulationEnv } from "./types.ts"
import { Clock, Effect, Schedule } from "effect"

/* eslint-disable local/no-fixed-polling -- firegrid-observability.TINY_FIREGRID_SIMULATIONS.1 public-client simulation retry backoff. */

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

const codexAcpToolCallDriver = (
  env: TinyFiregridSimulationEnv,
): Effect.Effect<CodexAcpToolCallSimulationResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    // Env-gate: codex-acp cannot run without its key. Fail FAST +
    // explicitly when absent (mirrors dark-factory-pipeline) instead of
    // spawning the agent and hanging to the runner timeout (~90s). The
    // real-key path is untouched; this only fires keyless.
    if (env.processEnv.OPENAI_API_KEY === undefined || env.processEnv.OPENAI_API_KEY.length === 0) {
      return yield* Effect.fail(new Error(
        "codex-acp-tool-call-pipeline requires OPENAI_API_KEY for codex-acp",
      ))
    }
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: env.runId,
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

export const codexAcpToolCallSimulation = {
  id: "codex-acp-tool-call-pipeline",
  description:
    "Launches the Codex ACP host configuration and drives it through the public Firegrid client surface until the sleep tool-call result is observed or timed out.",
  makeHost: env =>
    tinyCodexAcpToolCallPipeline({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      localProcessEnv: env.localProcessEnv,
      envPolicy: codexAcpOpenAiEnvPolicy(env.processEnv),
    }),
  driver: codexAcpToolCallDriver,
  summarize: result => ({
    sawReady: result.sawReady,
    sawSleepToolUse: result.sawSleepToolUse,
    sawAnyToolUse: result.sawAnyToolUse,
    observedToolNames: result.observedToolNames,
    resultTextExcerpt: result.resultText.slice(0, 600),
  }),
  localize: result =>
    result.sawSleepToolUse
      ? [
        "REAL-BEHAVIOR PASS: the real codex-acp agent issued a Firegrid `sleep` ToolUse round-trip and the terminal result was observed through the public client.",
      ]
      : result.sawAnyToolUse
        ? [
          "PARTIAL: a real MCP ToolUse round-trip WAS observed but not under the name `sleep`.",
          `Observed ToolUse names: ${result.observedToolNames.join(", ")}.`,
          "Finding: the agent exercised the tool path but the asserted Firegrid tool name `sleep` was not the surfaced ToolUse part.name — inspect the ACP tool_call -> Firegrid MCP tool-name mapping in the codec, or whether the agent chose a different advertised tool.",
        ]
        : [
          "The host and client flow reached agent Ready, but NO ToolUse was observed at all.",
          "Query MCP and codec spans to determine whether tools/list or tools/call reached the host.",
        ],
} satisfies TinyFiregridSimulation<CodexAcpToolCallSimulationResult>

/* eslint-enable local/no-fixed-polling */
