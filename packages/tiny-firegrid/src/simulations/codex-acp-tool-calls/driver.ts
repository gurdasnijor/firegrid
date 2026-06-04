/**
 * codex-acp-tool-calls driver — drives a REAL `@zed-industries/codex-acp` agent
 * PURELY over `@firegrid/client-sdk/mcp` (tf-ll90.8.4). No firegrid.ts client:
 * the host owns the gateway RuntimeContext carrying the codex runtime (ACP +
 * host-owned runtime-context MCP, see ./host.ts). The driver provisions a child
 * session via `session_new` (which inherits the gateway runtime, prompts it, and
 * starts it), then waits on the agent-output journal until codex emits the
 * `FIREGRID_TOOL_RESULT sleep slept=true` marker proving it called the Firegrid
 * `sleep` MCP tool. Creds-gated: needs OPENAI_API_KEY to actually run.
 *
 * `FiregridConfig` is the only client-sdk import (read-only config Tag); the
 * effect `Config` read of OPENAI_API_KEY is the creds gate, not a host handle.
 *
 * GAP (tf-ll90.8.4): the legacy sim ran TWO scenarios distinguished by a
 * per-launch `mcpServers` URL override (`explicit_mcp_url`). `session_new`
 * options carry only { cwd, metadata } — a per-session client-owned MCP URL
 * override is NOT on the mcp.ts surface; that runtime config is gateway-owned
 * now (host.ts sets `runtimeContextMcp.enabled`). So the migrated driver runs
 * the single host-owned runtime-context-MCP path; the explicit-URL variant is
 * dropped. See final report.
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import { makeFiregridMcpClient } from "@firegrid/client-sdk/mcp"
import { Config, Duration, Effect, Option, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals (kept in sync).
const gatewayContextId = "session:tiny-firegrid:codex-acp-tool-calls-gateway"
const streamId = "codex-acp-tool-calls"

const codexSpawnTarget = "npx -y @zed-industries/codex-acp@0.14.0"

const promptForToolCall = [
  "Use the MCP server available in this ACP session.",
  "Make EXACTLY ONE call to the Firegrid `sleep` tool with durationMs 0.",
  "Immediately after that single tool call returns, respond with this",
  "exact line and nothing else: FIREGRID_TOOL_RESULT sleep slept=true",
  "Do not call any tool more than once. Do not answer before the call.",
].join("\n")

const toolResultMarker = "FIREGRID_TOOL_RESULT sleep slept=true"

const openAiKeyConfig = Config.redacted("OPENAI_API_KEY").pipe(Config.option)

export const codexAcpToolCallDriver: Effect.Effect<void, unknown, FiregridConfig> =
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

    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(
        new Error("codex-acp-tool-calls requires durableStreamsBaseUrl and namespace"),
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

    // Provision a child session over MCP — session_new inherits the gateway
    // codex runtime (host-owned runtime-context MCP enabled), sends the initial
    // prompt, and starts it. The agent's turn should call the Firegrid `sleep`
    // tool then emit the marker line.
    const session = yield* mcp.sessions.createOrLoad({
      agentKind: "codex-acp",
      prompt: promptForToolCall,
    })

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

    const markerObserved = resultText.includes(toolResultMarker)

    yield* Effect.annotateCurrentSpan({
      "firegrid.codex_acp.status": "captured",
      "firegrid.codex_acp.openai_api_key_present": true,
      "firegrid.codex_acp.context_id": session.contextId,
      "firegrid.codex_acp.session_id": session.sessionId,
      "firegrid.codex_acp.marker_observed": markerObserved,
      "firegrid.codex_acp.text_length": resultText.length,
      "firegrid.codex_acp.output_count": outputCount,
      "firegrid.codex_acp.output_tags": outputTags.join(","),
      "firegrid.codex_acp.last_sequence": afterSequence ?? -1,
      "firegrid.codex_acp.timed_out": timedOut,
      "firegrid.codex_acp.transport": "mcp",
      "firegrid.codex_acp.runtime_context_mcp": "host-owned",
      "firegrid.codex_acp.spawn_target": codexSpawnTarget,
    })
  }).pipe(
    Effect.withSpan("firegrid.codex_acp_tool_calls.driver", {
      kind: "client",
    }),
  )
