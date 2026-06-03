import {
  Firegrid,
  local,
  type FiregridSessionHandle,
} from "@firegrid/client-sdk/firegrid"
import { Config, Effect, Option } from "effect"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Config.option,
)

const marker = "OP_REGISTRY_PROMPT_KEYSTONE_ACK"
const promptText = [
  "This is a Firegrid tiny simulation prompt delivery probe.",
  `Reply with exactly this marker on its own line: ${marker}`,
  "Do not call tools. Do not inspect files.",
].join("\n")

interface ExternalKey {
  readonly source: string
  readonly id: string
}

const externalKey: ExternalKey = {
  source: "tiny-firegrid",
  id: "op-registry-prompt-keystone",
}

const sessionContextIdForExternalKey = (key: ExternalKey): string =>
  `session:${key.source}:${key.id}`

const waitForMarker = (
  session: FiregridSessionHandle,
) =>
  Effect.gen(function*() {
    let afterSequence: number | undefined
    let outputCount = 0
    let text = ""
    let timedOut = false
    let markerObserved = false
    const outputTags: Array<string> = []

    while (!markerObserved && outputCount < 40 && !timedOut) {
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
          text += event.part.delta
          markerObserved = text.includes(marker)
        }
        if (event._tag === "TurnComplete" || event._tag === "Terminated") {
          timedOut = !markerObserved
        }
      }
    }

    return {
      outputCount,
      outputTags: outputTags.join(","),
      textLength: text.length,
      timedOut,
      markerObserved,
      lastSequence: afterSequence ?? -1,
    }
  })

export const opRegistryPromptKeystoneDriver: Effect.Effect<void, unknown, Firegrid> =
  Effect.scoped(Effect.gen(function*() {
    const anthropicKey = yield* anthropicKeyConfig
    if (Option.isNone(anthropicKey)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.op_registry_prompt.status": "blocked",
        "firegrid.op_registry_prompt.blocked_reason": "ANTHROPIC_API_KEY is absent",
        "firegrid.op_registry_prompt.anthropic_api_key_present": false,
      })
      return
    }

    const firegrid = yield* Firegrid
    const contextId = sessionContextIdForExternalKey(externalKey)
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey,
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    const promptOffset = yield* session.prompt({
      payload: {
        text: promptText,
      },
      idempotencyKey: "tiny-firegrid-op-registry-prompt-turn-1",
    })
    const startOffset = yield* session.start()
    const result = yield* waitForMarker(session)

    yield* Effect.annotateCurrentSpan({
      "firegrid.op_registry_prompt.status": result.markerObserved
        ? "marker_observed"
        : "incomplete",
      "firegrid.op_registry_prompt.anthropic_api_key_present": true,
      "firegrid.op_registry_prompt.context_id": contextId,
      "firegrid.op_registry_prompt.session_id": session.sessionId,
      "firegrid.op_registry_prompt.start_offset": startOffset.offset,
      "firegrid.op_registry_prompt.prompt_offset": promptOffset.offset,
      "firegrid.op_registry_prompt.output_count": result.outputCount,
      "firegrid.op_registry_prompt.output_tags": result.outputTags,
      "firegrid.op_registry_prompt.text_length": result.textLength,
      "firegrid.op_registry_prompt.timed_out": result.timedOut,
      "firegrid.op_registry_prompt.marker_observed": result.markerObserved,
      "firegrid.op_registry_prompt.last_sequence": result.lastSequence,
      "firegrid.op_registry_prompt.spawn_target": claudeAcpArgv.join(" "),
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.op_registry_prompt.driver", {
      kind: "client",
    }),
  )
