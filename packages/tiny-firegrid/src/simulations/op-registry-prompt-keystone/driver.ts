/**
 * op-registry-prompt-keystone driver — prompt-delivery keystone PURELY over
 * `@firegrid/client-sdk/mcp` (tf-ll90.8.4). No firegrid.ts client: the host owns
 * the gateway RuntimeContext (carrying the creds-gated claude-acp agent) and
 * binds the op-registry-projected `GeneratedSessionPromptChannelLive` as the
 * `SessionPromptChannel` (the thing under test). The driver provisions one child
 * session via `session_new` (which delivers the initial prompt THROUGH the
 * generated channel + starts it) and waits for the agent to echo the marker.
 *
 * The generated op-registry channel is exercised end-to-end via the standard MCP
 * `session_new`/`session_prompt` path — host-plane dispatch resolves the
 * `SessionPromptChannel` Tag the sim overrode. `FiregridConfig` is the only
 * client-sdk import (read-only config Tag). Creds-gated; the marker round-trip
 * requires a real ANTHROPIC_API_KEY in the host env.
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import {
  makeFiregridMcpClient,
  type FiregridMcpSessionHandle,
} from "@firegrid/client-sdk/mcp"
import { Duration, Effect, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals (kept in sync).
const gatewayContextId = "session:tiny-firegrid:op-registry-prompt-keystone-gateway"
const streamId = "op-registry-prompt-keystone"

const marker = "OP_REGISTRY_PROMPT_KEYSTONE_ACK"
const promptText = [
  "This is a Firegrid tiny simulation prompt delivery probe.",
  `Reply with exactly this marker on its own line: ${marker}`,
  "Do not call tools. Do not inspect files.",
].join("\n")

const waitForMarker = (
  session: FiregridMcpSessionHandle,
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

export const opRegistryPromptKeystoneDriver: Effect.Effect<void, unknown, FiregridConfig> =
  Effect.gen(function*() {
    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(
        new Error("op-registry-prompt-keystone requires durableStreamsBaseUrl and namespace"),
      )
    }

    const mcp = yield* makeFiregridMcpClient({
      durableStreamsBaseUrl: config.durableStreamsBaseUrl,
      namespace: config.namespace,
      streamId,
      clientId: 2,
      pollIntervalMs: 250,
    })

    yield* mcp.initialize

    // Wait for the host-seeded gateway context before provisioning off it.
    yield* mcp.observations.watchContexts(
      context => context.contextId === gatewayContextId,
    ).pipe(
      Stream.runHead,
      Effect.timeoutFail({
        duration: Duration.seconds(30),
        onTimeout: () => new Error("host gateway context did not appear over MCP"),
      }),
    )

    // Provision a child session over MCP — session_new delivers the initial
    // prompt THROUGH the op-registry GeneratedSessionPromptChannel (the keystone
    // under test) and starts the agent, which inherits the gateway claude-acp
    // runtime.
    const session = yield* mcp.sessions.createOrLoad({
      agentKind: "claude-acp",
      prompt: promptText,
    })

    const result = yield* waitForMarker(session)

    yield* Effect.annotateCurrentSpan({
      "firegrid.op_registry_prompt.status": result.markerObserved
        ? "marker_observed"
        : "incomplete",
      "firegrid.op_registry_prompt.context_id": session.contextId,
      "firegrid.op_registry_prompt.session_id": session.sessionId,
      "firegrid.op_registry_prompt.output_count": result.outputCount,
      "firegrid.op_registry_prompt.output_tags": result.outputTags,
      "firegrid.op_registry_prompt.text_length": result.textLength,
      "firegrid.op_registry_prompt.timed_out": result.timedOut,
      "firegrid.op_registry_prompt.marker_observed": result.markerObserved,
      "firegrid.op_registry_prompt.last_sequence": result.lastSequence,
      "firegrid.op_registry_prompt.transport": "mcp",
      "firegrid.op_registry_prompt.spawn_target":
        "npx -y @agentclientprotocol/claude-agent-acp@0.36.1",
    })
  }).pipe(
    Effect.withSpan("tiny_firegrid.op_registry_prompt.driver", {
      kind: "client",
    }),
  )
