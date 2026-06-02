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

const mcpHost = "127.0.0.1"
const mcpPort = 43792
const mcpPath = "/mcp"
const mcpServerName = "firegrid-runtime-context"
const markerTerminal = "FACTORY_CAPSTONE_TERMINAL"
const markerFinding = "FACTORY_CAPSTONE_FINDING"

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Config.option,
)

interface ExternalKey {
  readonly source: string
  readonly id: string
}

const externalKey: ExternalKey = {
  source: "tiny-firegrid",
  id: "factory-capstone",
}

const sessionContextIdForExternalKey = (key: ExternalKey): string =>
  `session:${key.source}:${key.id}`

const mcpUrlForContext = (contextId: string): string =>
  `http://${mcpHost}:${mcpPort}${mcpPath}/runtime-context/${encodeURIComponent(contextId)}`

const promptForFactoryLoop = [
  "Drive the factory capstone loop using only the Firegrid MCP tools available in this ACP session.",
  "Do not inspect files. Do not call execute, call, or send for shell/file work.",
  "",
  "Required trace shape:",
  "1. Call wait_for with exactly { event: { channel: \"darkFactory.facts\", match: { eventType: \"factory.trigger.accepted\" }, timeoutMs: 30000 } }. Do not include a prompt field.",
  "2. After wait_for returns matched:true, continue in the same turn and create or load a delegated Firegrid session with session_new.",
  "3. Prompt that delegated session with session_prompt to draft a reviewed action plan for the trigger.",
  "4. Request operator approval before merge-signoff; continue when the ACP permission gate is approved.",
  "5. Review the delegated result and write a merge-signoff decision.",
  "",
  `When the loop reaches reviewed-action signoff, write one line beginning with ${markerTerminal}.`,
  `If any step is not expressible through the public Firegrid tool surface, write one line beginning with ${markerFinding} and name the missing surface.`,
].join("\n")

const waitForMarker = (
  session: FiregridSessionHandle,
) =>
  Effect.gen(function*() {
    let afterSequence: number | undefined
    let text = ""
    let outputCount = 0
    let permissionRequests = 0
    let timedOut = false
    let sawTerminal = false
    let sawFinding = false
    const outputTags: Array<string> = []

    while (
      !sawTerminal &&
      !sawFinding &&
      outputCount < 80 &&
      !timedOut
    ) {
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
        if (event._tag === "PermissionRequest") {
          permissionRequests += 1
        }
        if (event._tag === "TextChunk") {
          text += event.part.delta
          sawTerminal = text.includes(markerTerminal)
          sawFinding = text.includes(markerFinding)
        }
        if (event._tag === "TurnComplete" || event._tag === "Terminated") {
          timedOut = !sawTerminal && !sawFinding
        }
      }
    }

    return {
      outputCount,
      permissionRequests,
      outputTags: outputTags.join(","),
      textLength: text.length,
      timedOut,
      sawTerminal,
      sawFinding,
      lastSequence: afterSequence ?? -1,
    }
  })

export const factoryCapstoneDriver: Effect.Effect<void, unknown, Firegrid> =
  Effect.scoped(Effect.gen(function*() {
    const anthropicKey = yield* anthropicKeyConfig
    if (Option.isNone(anthropicKey)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.factory_capstone.status": "blocked",
        "firegrid.factory_capstone.blocked_reason": "ANTHROPIC_API_KEY is absent",
        "firegrid.factory_capstone.anthropic_api_key_present": false,
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
        runtimeContextMcp: { enabled: true },
        mcpServers: [{
          name: mcpServerName,
          server: {
            type: "url",
            url: mcpUrlForContext(contextId),
          },
        }],
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.permissions.autoApprove("allow", { timeoutMs: 120_000 })
    const promptOffset = yield* session.prompt({
      payload: {
        text: promptForFactoryLoop,
      },
      idempotencyKey: "tiny-firegrid-factory-capstone-turn-1",
    })
    const startOffset = yield* session.start()
    const result = yield* waitForMarker(session)

    yield* Effect.annotateCurrentSpan({
      "firegrid.factory_capstone.status": result.sawTerminal
        ? "terminal"
        : result.sawFinding
        ? "finding"
        : "incomplete",
      "firegrid.factory_capstone.anthropic_api_key_present": true,
      "firegrid.factory_capstone.context_id": session.contextId,
      "firegrid.factory_capstone.mcp_url": mcpUrlForContext(contextId),
      "firegrid.factory_capstone.start_offset": startOffset.offset,
      "firegrid.factory_capstone.prompt_offset": promptOffset.offset,
      "firegrid.factory_capstone.output_count": result.outputCount,
      "firegrid.factory_capstone.output_tags": result.outputTags,
      "firegrid.factory_capstone.permission_request_count": result.permissionRequests,
      "firegrid.factory_capstone.text_length": result.textLength,
      "firegrid.factory_capstone.timed_out": result.timedOut,
      "firegrid.factory_capstone.terminal_marker_observed": result.sawTerminal,
      "firegrid.factory_capstone.finding_marker_observed": result.sawFinding,
      "firegrid.factory_capstone.last_sequence": result.lastSequence,
      "firegrid.factory_capstone.spawn_target": claudeAcpArgv.join(" "),
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.factory_capstone.driver", {
      kind: "client",
    }),
  )
