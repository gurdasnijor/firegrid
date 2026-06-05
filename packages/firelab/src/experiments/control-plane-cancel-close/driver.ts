/**
 * control-plane-cancel-close driver — cancel/close lifecycle PURELY over
 * `@firegrid/client-sdk/mcp` (tf-ll90.8.4). No firegrid.ts client: the host owns
 * the gateway RuntimeContext (see ./host.ts); the driver provisions two child
 * sessions via `session_new` (they inherit the gateway's creds-free fake ACP
 * agent), then exercises `session_cancel` / `session_close` as MCP tool-calls
 * and records whether each reaches a terminal consumer.
 *
 * `FiregridConfig` is the only client-sdk import — a read-only config Tag.
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import { makeFiregridMcpClient } from "@firegrid/client-sdk/mcp"
import { Cause, Duration, Effect, Exit, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals (kept in sync).
const gatewayContextId = "session:firelab:control-plane-cancel-close-gateway"
const streamId = "control-plane-cancel-close"

interface ExitSummary {
  readonly tag: "Success" | "Failure"
  readonly errorTag?: string
  readonly message?: string
}

interface ControlPlaneCancelCloseResult {
  readonly cancelSessionId: string
  readonly closeSessionId: string
  readonly cancel: ExitSummary
  readonly close: ExitSummary
}

const errorTag = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined

const errorMessage = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : undefined

const summarizeExit = <A>(
  exit: Exit.Exit<A, unknown>,
): ExitSummary => {
  if (Exit.isSuccess(exit)) return { tag: "Success" }
  const failure = Cause.failureOption(exit.cause)
  if (failure._tag === "Some") {
    const tag = errorTag(failure.value)
    const message = errorMessage(failure.value)
    return {
      tag: "Failure",
      ...(tag === undefined ? {} : { errorTag: tag }),
      ...(message === undefined ? {} : { message }),
    }
  }
  return { tag: "Failure", message: Cause.pretty(exit.cause) }
}

const cancelClosePrompt =
  "Stand by — this session is a control-plane cancel/close probe."

export const driver: Effect.Effect<ControlPlaneCancelCloseResult, unknown, FiregridConfig> =
  Effect.gen(function*() {
    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(
        new Error("control-plane-cancel-close requires durableStreamsBaseUrl and namespace"),
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

    // Provision two child sessions over MCP; cancel one, close the other.
    const cancelChild = yield* mcp.sessions.create({
      agentKind: "fake-acp",
      prompt: cancelClosePrompt,
    })
    const closeChild = yield* mcp.sessions.create({
      agentKind: "fake-acp",
      prompt: cancelClosePrompt,
    })

    yield* Effect.sleep("500 millis")

    const cancelExit = yield* Effect.exit(
      mcp.callTool("session_cancel", {
        sessionId: cancelChild.sessionId,
        reason: "tf-ll90.8.4 cancel probe",
      }).pipe(
        Effect.withSpan("firegrid.cancel_close.driver.session_cancel", {
          attributes: {
            "firegrid.session.id": cancelChild.sessionId,
            "firegrid.context.id": cancelChild.contextId,
            "firegrid.cancel_close.operation": "cancel",
            "firegrid.mcp.tool": "session_cancel",
          },
        }),
      ),
    )
    const closeExit = yield* Effect.exit(
      mcp.callTool("session_close", {
        sessionId: closeChild.sessionId,
        reason: "tf-ll90.8.4 close probe",
      }).pipe(
        Effect.withSpan("firegrid.cancel_close.driver.session_close", {
          attributes: {
            "firegrid.session.id": closeChild.sessionId,
            "firegrid.context.id": closeChild.contextId,
            "firegrid.cancel_close.operation": "close",
            "firegrid.mcp.tool": "session_close",
          },
        }),
      ),
    )
    yield* Effect.sleep("500 millis")

    const cancel = summarizeExit(cancelExit)
    const close = summarizeExit(closeExit)

    yield* Effect.annotateCurrentSpan({
      "firegrid.cancel_close.cancel.session_id": cancelChild.sessionId,
      "firegrid.cancel_close.close.session_id": closeChild.sessionId,
      "firegrid.cancel_close.cancel.exit": cancel.tag,
      "firegrid.cancel_close.cancel.error_tag": cancel.errorTag ?? "",
      "firegrid.cancel_close.close.exit": close.tag,
      "firegrid.cancel_close.close.error_tag": close.errorTag ?? "",
      "firegrid.cancel_close.transport": "mcp",
    })

    return {
      cancelSessionId: cancelChild.sessionId,
      closeSessionId: closeChild.sessionId,
      cancel,
      close,
    }
  }).pipe(
    Effect.withSpan("firegrid.cancel_close.driver", {
      attributes: {
        "firegrid.bead": "tf-ll90.8.4",
        "firegrid.simulation.intent": "cancel-close-over-mcp",
      },
    }),
  )
