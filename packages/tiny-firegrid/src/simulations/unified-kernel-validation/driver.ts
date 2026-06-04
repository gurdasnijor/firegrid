/**
 * unified-kernel-validation driver — drives the full production kernel path
 * PURELY over `@firegrid/client-sdk/mcp` (tf-ll90.8.4). No firegrid.ts client:
 * the host owns the gateway RuntimeContext (see ./host.ts); the driver
 * provisions one session via the `session_new` MCP tool (which inherits the
 * gateway's creds-free official-ACP-example agent, prompts it, and starts it),
 * lets the agent turn run (the fixture always emits a tool_call → the ACP
 * ToolUse journal seam), then closes it (terminal → adapter deregister).
 *
 * The `trace:seams:ukv` gate asserts the HOST/substrate spans this elicits;
 * `FiregridConfig` is the only client-sdk import (read-only config Tag).
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import { makeFiregridMcpClient } from "@firegrid/client-sdk/mcp"
import { Duration, Effect, Option, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals (kept in sync).
const gatewayContextId = "session:tiny-firegrid:unified-kernel-validation-gateway"
const streamId = "unified-kernel-validation"

const promptText =
  "Validate the production ACP path through the official SDK example agent."

export const unifiedKernelValidationDriver = Effect.gen(function*() {
  const config = yield* FiregridConfig
  if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
    return yield* Effect.fail(
      new Error("unified-kernel-validation requires durableStreamsBaseUrl and namespace"),
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
  // runtime, sends the initial prompt, and starts it. The fixture agent's turn
  // emits a tool_call (the ACP ToolUse journal seam the gate asserts).
  const session = yield* mcp.sessions.create({
    agentKind: "official-acp-typescript-sdk-example",
    prompt: promptText,
  })

  // Let the agent turn complete and reach the journal before closing.
  yield* Effect.sleep("3500 millis")

  const snapshot = yield* Effect.option(mcp.observations.snapshot(session.contextId))
  const snapshotRunCount = Option.match(snapshot, {
    onNone: () => 0,
    onSome: value => value.runs.length,
  })

  // Terminal close → adapter deregister, terminal ordering recorded first.
  yield* mcp.callTool("session_close", {
    sessionId: session.sessionId,
    reason: "unified-kernel-validation terminal cleanup proof",
  })

  yield* Effect.sleep("1000 millis")

  yield* Effect.annotateCurrentSpan({
    "firegrid.ukv.context_id": session.contextId,
    "firegrid.ukv.session_id": session.sessionId,
    "firegrid.ukv.snapshot_run_count": snapshotRunCount,
    "firegrid.ukv.codec": "acp",
    "firegrid.ukv.transport": "mcp",
    "firegrid.ukv.spawn_target": "src/bin/fake-acp-agent-process.ts",
    "firegrid.ukv.agent_source":
      "agentclientprotocol/typescript-sdk/src/examples/agent.ts",
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.unified_kernel_validation.driver", {
    kind: "internal",
  }),
)
