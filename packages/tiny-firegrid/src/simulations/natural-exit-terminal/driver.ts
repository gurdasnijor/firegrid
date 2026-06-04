/**
 * tf-r06u.36 / tf-ll90.8.4 — natural-exit terminal-deregister proof driver.
 *
 * MCP-only (`@firegrid/client-sdk/mcp`). Provisions a `session_new` child off
 * the host-owned gateway (the self-exiting one-shot ACP agent inherits that
 * runtime, is prompted, and started). The agent answers once then exits its
 * process; the driver observes the streamed output up to `Terminated` (the
 * natural-exit terminal the production observer turns into `adapter.deregister`).
 * It does NOT call cancel/close — the terminal here is natural process exit.
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import { makeFiregridMcpClient } from "@firegrid/client-sdk/mcp"
import { Duration, Effect, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals.
const gatewayContextId = "session:tiny-firegrid:natural-exit-terminal-gateway"
const streamId = "natural-exit-terminal"

export const naturalExitTerminalDriver = Effect.gen(function*() {
  const config = yield* FiregridConfig
  if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
    return yield* Effect.fail(
      new Error("natural-exit-terminal requires durableStreamsBaseUrl and namespace"),
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

  yield* mcp.observations.watchContexts(
    context => context.contextId === gatewayContextId,
  ).pipe(
    Stream.runHead,
    Effect.timeoutFail({
      duration: Duration.seconds(30),
      onTimeout: () => new Error("host gateway context did not appear over MCP"),
    }),
  )

  // session_new inherits the self-exiting agent runtime, prompts, and starts it.
  const session = yield* mcp.sessions.create({
    agentKind: "self-exiting-acp-agent",
    prompt: "Respond once, then exit.",
  })

  // Drain streamed output up to the natural-exit Terminated observation.
  const outputTags: Array<string> = []
  let waited = yield* session.wait.forAgentOutput({ timeoutMs: 8_000 })
  let remaining = 12
  while (waited.matched && waited.output._tag !== "Terminated" && remaining > 0) {
    outputTags.push(waited.output._tag)
    waited = yield* session.wait.forAgentOutput({ timeoutMs: 8_000 })
    remaining -= 1
  }
  if (waited.matched) outputTags.push(waited.output._tag)

  // Let the journaled Terminated reach the observer + terminal deregister run.
  yield* Effect.sleep("2500 millis")

  yield* Effect.annotateCurrentSpan({
    "firegrid.r06u36.context_id": session.contextId,
    "firegrid.r06u36.session_id": session.sessionId,
    "firegrid.r06u36.terminated_observed": outputTags.includes("Terminated"),
    "firegrid.r06u36.output_count": outputTags.length,
    "firegrid.r06u36.output_tags": outputTags.join(","),
    "firegrid.r06u36.spawn_target": "src/bin/self-exiting-acp-agent-process.ts",
    "firegrid.r06u36.codec": "acp",
    "firegrid.r06u36.transport": "mcp",
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.natural_exit_terminal.driver", {
    kind: "internal",
  }),
)
