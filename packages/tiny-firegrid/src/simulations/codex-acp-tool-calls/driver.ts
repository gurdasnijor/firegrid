import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Cause, Config, Effect, Exit, Option } from "effect"

const codexAcpArgv = [
  "npx",
  "-y",
  "@zed-industries/codex-acp@0.14.0",
] as const

const mcpHost = "127.0.0.1"
const mcpPort = 43791
const mcpPath = "/mcp"
const mcpServerName = "firegrid-runtime-context"

const promptForToolCall = [
  "Use the MCP server available in this ACP session.",
  "Make EXACTLY ONE call to the Firegrid `sleep` tool with durationMs 0.",
  "Immediately after that single tool call returns, respond with this",
  "exact line and nothing else: FIREGRID_TOOL_RESULT sleep slept=true",
  "Do not call any tool more than once. Do not answer before the call.",
].join("\n")

const toolResultMarker = "FIREGRID_TOOL_RESULT sleep slept=true"

const openAiKeyConfig = Config.redacted("OPENAI_API_KEY").pipe(Config.option)

interface ExternalKey {
  readonly source: string
  readonly id: string
}

interface ScenarioResult {
  readonly id: string
  readonly contextId: string
  readonly startOffset: string
  readonly promptOffset: string
  readonly markerObserved: boolean
  readonly textLength: number
  readonly outputCount: number
  readonly outputTags: string
  readonly lastSequence: number
  readonly timedOut: boolean
}

interface ScenarioFailure {
  readonly id: string
  readonly contextId: string
  readonly failure: string
}

const sessionContextIdForExternalKey = (externalKey: ExternalKey): string => {
  // Mirrors the currently merged host.sessions.createOrLoad binding; this is
  // config data over the public launch seam, not a host handle import.
  return `session:${externalKey.source}:${externalKey.id}`
}

const mcpUrlForContext = (contextId: string): string =>
  `http://${mcpHost}:${mcpPort}${mcpPath}/runtime-context/${contextId}`

const runCodexScenario = (
  scenario: {
    readonly id: string
    readonly externalKey: ExternalKey
    readonly explicitMcpUrl: boolean
  },
): Effect.Effect<ScenarioResult, unknown, Firegrid> =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const contextId = sessionContextIdForExternalKey(scenario.externalKey)
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: scenario.externalKey,
      runtime: local.jsonl({
        argv: [...codexAcpArgv],
        agent: "codex-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "OPENAI_API_KEY", ref: "env:OPENAI_API_KEY" },
        ],
        runtimeContextMcp: { enabled: true },
        ...(scenario.explicitMcpUrl
          ? {
            mcpServers: [{
              name: mcpServerName,
              server: {
                type: "url" as const,
                url: mcpUrlForContext(contextId),
              },
            }],
          }
          : {}),
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    const promptOffset = yield* session.prompt({
      payload: promptForToolCall,
      idempotencyKey: `codex-acp-tool-calls:${scenario.id}:turn-1`,
    })
    const startOffset = yield* session.start()

    let afterSequence: number | undefined
    let resultText = ""
    let outputCount = 0
    let timedOut = false
    const outputTags: Array<string> = []
    while (!resultText.includes(toolResultMarker) && outputCount < 24 && !timedOut) {
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 15_000,
      })
      if (!next.matched) {
        timedOut = true
      } else {
        afterSequence = next.output.sequence
        outputCount += 1
        const event = next.output.event
        outputTags.push(event._tag)
        if (event._tag === "TextChunk") {
          resultText += event.part.delta
        }
        if (event._tag === "TurnComplete" || event._tag === "Terminated") {
          timedOut = !resultText.includes(toolResultMarker)
        }
      }
    }

    return {
      id: scenario.id,
      contextId: session.contextId,
      startOffset: startOffset.offset,
      promptOffset: promptOffset.offset,
      markerObserved: resultText.includes(toolResultMarker),
      textLength: resultText.length,
      outputCount,
      outputTags: outputTags.join(","),
      lastSequence: afterSequence ?? -1,
      timedOut,
    }
  }).pipe(
    Effect.withSpan(`firegrid.codex_acp_tool_calls.${scenario.id}`, {
      kind: "client",
      attributes: {
        "firegrid.codex_acp.scenario": scenario.id,
        "firegrid.codex_acp.explicit_mcp_url": scenario.explicitMcpUrl,
      },
    }),
  )

const annotateScenario = (
  result: ScenarioResult,
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    [`firegrid.codex_acp.${result.id}.context_id`]: result.contextId,
    [`firegrid.codex_acp.${result.id}.start_offset`]: result.startOffset,
    [`firegrid.codex_acp.${result.id}.prompt_offset`]: result.promptOffset,
    [`firegrid.codex_acp.${result.id}.marker_observed`]: result.markerObserved,
    [`firegrid.codex_acp.${result.id}.text_length`]: result.textLength,
    [`firegrid.codex_acp.${result.id}.output_count`]: result.outputCount,
    [`firegrid.codex_acp.${result.id}.output_tags`]: result.outputTags,
    [`firegrid.codex_acp.${result.id}.last_sequence`]: result.lastSequence,
    [`firegrid.codex_acp.${result.id}.timed_out`]: result.timedOut,
  })

const summarizeCause = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.failureOption(cause)
  if (Option.isSome(failure)) {
    const value = failure.value
    return value instanceof Error ? value.message : String(value)
  }
  return Cause.pretty(cause)
}

const captureScenario = (
  scenario: {
    readonly id: string
    readonly externalKey: ExternalKey
    readonly explicitMcpUrl: boolean
  },
): Effect.Effect<Exit.Exit<ScenarioResult, ScenarioFailure>, never, Firegrid> =>
  runCodexScenario(scenario).pipe(
    Effect.mapError((cause): ScenarioFailure => ({
      id: scenario.id,
      contextId: sessionContextIdForExternalKey(scenario.externalKey),
      failure: String(cause),
    })),
    Effect.exit,
  )

const annotateScenarioExit = (
  exit: Exit.Exit<ScenarioResult, ScenarioFailure>,
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) {
    return annotateScenario(exit.value).pipe(
      Effect.zipRight(Effect.annotateCurrentSpan({
        [`firegrid.codex_acp.${exit.value.id}.status`]: "completed",
      })),
    )
  }
  const failure = Cause.failureOption(exit.cause)
  const id = Option.isSome(failure) ? failure.value.id : "unknown"
  const contextId = Option.isSome(failure) ? failure.value.contextId : ""
  const message = Option.isSome(failure)
    ? failure.value.failure
    : summarizeCause(exit.cause)
  return Effect.annotateCurrentSpan({
    [`firegrid.codex_acp.${id}.status`]: "failed",
    [`firegrid.codex_acp.${id}.context_id`]: contextId,
    [`firegrid.codex_acp.${id}.failure`]: message,
  })
}

export const codexAcpToolCallDriver: Effect.Effect<void, unknown, Firegrid> =
  Effect.gen(function*() {
    const openAiKey = yield* openAiKeyConfig
    if (Option.isNone(openAiKey)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.codex_acp.status": "blocked",
        "firegrid.codex_acp.blocked_reason": "OPENAI_API_KEY is absent",
        "firegrid.codex_acp.openai_api_key_present": false,
      })
      return
    }

    const markerOnly = yield* captureScenario({
      id: "marker_only",
      externalKey: {
        source: "tiny-firegrid",
        id: "codex-acp-tool-calls-marker-only",
      },
      explicitMcpUrl: false,
    })
    yield* annotateScenarioExit(markerOnly)

    const explicitMcp = yield* captureScenario({
      id: "explicit_mcp_url",
      externalKey: {
        source: "tiny-firegrid",
        id: "codex-acp-tool-calls-explicit-mcp-url",
      },
      explicitMcpUrl: true,
    })
    yield* annotateScenarioExit(explicitMcp)

    const markerOnlyObserved = Exit.isSuccess(markerOnly)
      ? markerOnly.value.markerObserved
      : false
    const explicitObserved = Exit.isSuccess(explicitMcp)
      ? explicitMcp.value.markerObserved
      : false
    const explicitContextId = Exit.isSuccess(explicitMcp)
      ? explicitMcp.value.contextId
      : sessionContextIdForExternalKey({
        source: "tiny-firegrid",
        id: "codex-acp-tool-calls-explicit-mcp-url",
      })

    yield* Effect.annotateCurrentSpan({
      "firegrid.codex_acp.status": "captured",
      "firegrid.codex_acp.openai_api_key_present": true,
      "firegrid.codex_acp.marker_only_expected_gap": true,
      "firegrid.codex_acp.marker_only_marker_observed": markerOnlyObserved,
      "firegrid.codex_acp.explicit_mcp_url_marker_observed": explicitObserved,
      "firegrid.codex_acp.explicit_mcp_url": mcpUrlForContext(explicitContextId),
      "firegrid.codex_acp.spawn_target": codexAcpArgv.join(" "),
    })
  }).pipe(
    Effect.withSpan("firegrid.codex_acp_tool_calls.driver", {
      kind: "client",
    }),
  )
