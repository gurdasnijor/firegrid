/**
 * comp-derisk-ordering driver — MCP-only (`@firegrid/client-sdk/mcp`),
 * tf-ll90.8.4. Provisions a `session_new` child off the host-owned gateway (the
 * official ACP example agent inherits that runtime + the initial turn), then
 * prompts a second turn, closes the session, and re-prompts post-close. The
 * host-wide `outputOrderProbe` (see ./host.ts) records each journal row's
 * append order; the `settle` after each action gives the real drain wall-clock.
 * The trace is the deliverable; this driver computes no verdict.
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import { makeFiregridMcpClient } from "@firegrid/client-sdk/mcp"
import { Duration, Effect, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals.
const gatewayContextId = "session:tiny-firegrid:comp-derisk-ordering-gateway"
const streamId = "comp-derisk-ordering"

// Bounded settle after each action — lets the real per-context output drain
// append its rows host-wide before the next action.
const settle = Effect.sleep("4 seconds")

export const compDeriskOrderingDriver = Effect.gen(function*() {
  const config = yield* FiregridConfig
  if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
    return yield* Effect.fail(
      new Error("comp-derisk-ordering requires durableStreamsBaseUrl and namespace"),
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

  // Turn 1 — session_new inherits the gateway runtime, prompts, and starts it.
  const session = yield* mcp.sessions.create({
    agentKind: "official-acp-typescript-sdk-example",
    prompt: "First turn — emit output.",
  })
  yield* settle

  // Turn 2 — same session, same drain: sequence should continue monotonically.
  yield* Effect.exit(session.promptTask({ prompt: "Second turn — emit more output." }))
  yield* settle

  // Close (terminal -> deregister -> per-context Scope.close flushes the drain),
  // then re-prompt post-close (expected to fail — the session is terminal).
  const closeExit = yield* Effect.exit(
    mcp.callTool("session_close", { sessionId: session.sessionId }),
  )
  const rePromptExit = yield* Effect.exit(
    session.promptTask({ prompt: "Post-close turn." }),
  )
  yield* settle

  yield* Effect.annotateCurrentSpan({
    "firegrid.sim.context_id": session.contextId,
    "firegrid.sim.close_exit": closeExit._tag,
    "firegrid.sim.postclose_reprompt_exit": rePromptExit._tag,
    "firegrid.sim.transport": "mcp",
  })
}).pipe(
  Effect.withSpan("tiny_firegrid.comp_derisk_ordering.driver", {
    kind: "internal",
  }),
)
