/**
 * tf-ll90.5.1 / tf-ll90.8.4 — shape-c terminal-ordering proof driver.
 *
 * Airgapped: imports ONLY from `@firegrid/client-sdk/mcp` +
 * `@firegrid/client-sdk/config` + `effect`. The host owns the gateway
 * RuntimeContext carrying the REAL `claude-acp` agent (see ./host.ts); this
 * driver provisions one `session_new` child off that gateway (which inherits
 * the creds-gated claude-acp runtime, is prompted, and started), drains a full
 * turn of raw agent_output (`TextChunk` … `TurnComplete`, which by the per-event
 * design does NOT terminate the session), then issues the explicit DURABLE
 * terminal `session_close`.
 *
 * The invariant the trace must show: terminal completion is bound to the durable
 * lifecycle (the terminal signal), NOT to a raw agent_output. Concretely,
 * `firegrid.unified.session.terminal_signal` precedes
 * `firegrid.unified.adapter.deregister` for the same `firegrid.context.id`, and
 * no `TurnComplete` agent_output triggers a deregister. The trace is the
 * deliverable; this sim NEVER returns a verdict object.
 *
 * Process-leak watch (tf-r06u.36 terminal-completion-relay leak): the finding
 * reports whether the deregister fired after close, or whether the process
 * leaked (terminal_signal with no following deregister).
 *
 * Creds-gated: needs `ANTHROPIC_API_KEY` to RUN (the absent-key path records a
 * `blocked` finding and halts cleanly). `FiregridConfig` is the only
 * client-sdk config import (a read-only Tag).
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import { makeFiregridMcpClient } from "@firegrid/client-sdk/mcp"
import { Config, Duration, Effect, Option, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals (kept in sync).
const gatewayContextId = "session:tiny-firegrid:shape-c-terminal-ordering-gateway"
const streamId = "shape-c-terminal-ordering"

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Config.option,
)

const marker = "SHAPE_C_TERMINAL_ORDERING_ACK"
const promptText = [
  "This is a Firegrid tiny simulation prompt-delivery probe.",
  `Reply with exactly this marker on its own line: ${marker}`,
  "Do not call tools. Do not inspect files.",
].join("\n")

export const shapeCTerminalOrderingDriver = Effect.gen(function*() {
  const anthropicKey = yield* anthropicKeyConfig
  if (Option.isNone(anthropicKey)) {
    // No BLOCKING prompt — record a `blocked` finding and halt cleanly.
    yield* Effect.annotateCurrentSpan({
      "firegrid.shape_c_terminal.status": "blocked",
      "firegrid.shape_c_terminal.blocked_reason": "ANTHROPIC_API_KEY is absent",
      "firegrid.shape_c_terminal.anthropic_api_key_present": false,
    })
    return
  }

  const config = yield* FiregridConfig
  if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
    return yield* Effect.fail(
      new Error("shape-c-terminal-ordering requires durableStreamsBaseUrl and namespace"),
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

  // Provision a child session over MCP — session_new inherits the gateway's
  // real claude-acp runtime, sends the initial prompt, and starts it.
  const session = yield* mcp.sessions.create({
    agentKind: "claude-acp",
    prompt: promptText,
  })

  // 1) Drain a full turn of raw agent_output up to `TurnComplete`. A
  //    `TurnComplete` does NOT terminate the session — the durable lifecycle is
  //    untouched and the live process stays registered.
  const turnTags: Array<string> = []
  let turnText = ""
  let turnCompleteObserved = false
  let waited = yield* session.wait.forAgentOutput({ timeoutMs: 30_000 })
  let remaining = 24
  while (waited.matched && remaining > 0) {
    turnTags.push(waited.output._tag)
    if (waited.output._tag === "TextChunk") {
      turnText += waited.output.event.part.delta
    }
    if (waited.output._tag === "TurnComplete" || waited.output._tag === "Terminated") {
      turnCompleteObserved = waited.output._tag === "TurnComplete"
      break
    }
    waited = yield* session.wait.forAgentOutput({ timeoutMs: 30_000 })
    remaining -= 1
  }
  const markerObserved = turnText.includes(marker)

  // 2) Issue the explicit DURABLE terminal. This is the only thing that binds
  //    the lifecycle end: close binding → terminal_signal → terminal per-event
  //    handler → adapter.deregister.
  yield* mcp.callTool("session_close", {
    sessionId: session.sessionId,
    reason: "tf-ll90.5.1 shape-c terminal-ordering probe",
  }).pipe(
    Effect.withSpan("tiny_firegrid.shape_c_terminal.driver.session_close", {
      kind: "client",
      attributes: {
        "firegrid.mcp.tool": "session_close",
        "firegrid.context.id": session.contextId,
      },
    }),
  )

  // 3) Drain post-close output up to the `Terminated` observation (the natural
  //    terminal the production observer turns into `adapter.deregister`).
  let terminatedObserved = false
  let postClose = yield* session.wait.forAgentOutput({ timeoutMs: 30_000 })
  let postRemaining = 12
  while (postClose.matched && postRemaining > 0) {
    if (postClose.output._tag === "Terminated") {
      terminatedObserved = true
      break
    }
    postClose = yield* session.wait.forAgentOutput({ timeoutMs: 30_000 })
    postRemaining -= 1
  }

  // Let the journaled Terminated reach the observer + terminal deregister run.
  yield* Effect.sleep("2500 millis")

  yield* Effect.annotateCurrentSpan({
    "firegrid.shape_c_terminal.status": turnCompleteObserved
      ? "turn_completed_then_closed"
      : "incomplete_turn_then_closed",
    "firegrid.shape_c_terminal.anthropic_api_key_present": true,
    "firegrid.shape_c_terminal.context_id": session.contextId,
    "firegrid.shape_c_terminal.session_id": session.sessionId,
    "firegrid.shape_c_terminal.turn_output_count": turnTags.length,
    "firegrid.shape_c_terminal.turn_output_tags": turnTags.join(","),
    "firegrid.shape_c_terminal.turn_complete_observed": turnCompleteObserved,
    "firegrid.shape_c_terminal.terminated_observed_post_close": terminatedObserved,
    "firegrid.shape_c_terminal.marker_observed": markerObserved,
    "firegrid.shape_c_terminal.spawn_target":
      "npx -y @agentclientprotocol/claude-agent-acp@0.36.1",
    "firegrid.shape_c_terminal.codec": "acp",
    "firegrid.shape_c_terminal.transport": "mcp",
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.shape_c_terminal.driver", {
    kind: "client",
  }),
)
