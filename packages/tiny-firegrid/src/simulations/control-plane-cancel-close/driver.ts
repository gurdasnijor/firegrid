import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Cause, Effect, Exit } from "effect"

const pathFromHere = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname)

const fakeAgentBin = pathFromHere("../../bin/fake-acp-agent-process.ts")
const tsxBin = pathFromHere("../../../../../node_modules/tsx/dist/cli.mjs")

interface ExitSummary {
  readonly tag: "Success" | "Failure"
  readonly errorTag?: string
  readonly message?: string
}

interface ControlPlaneCancelCloseResult {
  readonly cancelSessionId: string
  readonly closeSessionId: string
  readonly cancelStartOffset: string
  readonly closeStartOffset: string
  readonly cancel: ExitSummary
  readonly close: ExitSummary
}

const errorTag = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined

const errorMessage = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : undefined

const failureSummary = (error: unknown): ExitSummary => {
  const tag = errorTag(error)
  const message = errorMessage(error)
  return {
    tag: "Failure",
    ...(tag === undefined ? {} : { errorTag: tag }),
    ...(message === undefined ? {} : { message }),
  }
}

const summarizeExit = <A>(
  exit: Exit.Exit<A, unknown>,
): ExitSummary => {
  if (Exit.isSuccess(exit)) return { tag: "Success" }
  const failure = Cause.failureOption(exit.cause)
  if (failure._tag === "Some") {
    return failureSummary(failure.value)
  }
  return {
    tag: "Failure",
    message: Cause.pretty(exit.cause),
  }
}

export const driver: Effect.Effect<ControlPlaneCancelCloseResult, unknown, Firegrid> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid

    const launchSession = (operation: "cancel" | "close") =>
      Effect.gen(function*() {
        const context = yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, tsxBin, fakeAgentBin],
            agentProtocol: "acp",
          }),
          requestedBy: `tf-ll90.4:${operation}`,
        })
        const session = yield* firegrid.sessions.attach({ sessionId: context.contextId })
        const startOffset = yield* session.start()
        return { session, startOffset }
      })

    const cancelProbe = yield* launchSession("cancel")
    const closeProbe = yield* launchSession("close")
    yield* Effect.sleep("500 millis")

    const cancelExit = yield* Effect.exit(
      cancelProbe.session.cancel({ reason: "tf-ll90.4 cancel probe" }).pipe(
        Effect.withSpan("firegrid.cancel_close.driver.session_cancel", {
          attributes: {
            "firegrid.session.id": cancelProbe.session.sessionId,
            "firegrid.context.id": cancelProbe.session.sessionId,
            "firegrid.cancel_close.operation": "cancel",
            "firegrid.channel.target": "session.cancel",
          },
        }),
      ),
    )
    const closeExit = yield* Effect.exit(
      closeProbe.session.close({ reason: "tf-ll90.4 close probe" }).pipe(
        Effect.withSpan("firegrid.cancel_close.driver.session_close", {
          attributes: {
            "firegrid.session.id": closeProbe.session.sessionId,
            "firegrid.context.id": closeProbe.session.sessionId,
            "firegrid.cancel_close.operation": "close",
            "firegrid.channel.target": "session.close",
          },
        }),
      ),
    )
    yield* Effect.sleep("500 millis")

    const cancel = summarizeExit(cancelExit)
    const close = summarizeExit(closeExit)

    yield* Effect.annotateCurrentSpan({
      "firegrid.cancel_close.cancel.session_id": cancelProbe.session.sessionId,
      "firegrid.cancel_close.close.session_id": closeProbe.session.sessionId,
      "firegrid.cancel_close.cancel.exit": cancel.tag,
      "firegrid.cancel_close.cancel.error_tag": cancel.errorTag ?? "",
      "firegrid.cancel_close.close.exit": close.tag,
      "firegrid.cancel_close.close.error_tag": close.errorTag ?? "",
    })

    return {
      cancelSessionId: cancelProbe.session.sessionId,
      closeSessionId: closeProbe.session.sessionId,
      cancelStartOffset: cancelProbe.startOffset.offset,
      closeStartOffset: closeProbe.startOffset.offset,
      cancel,
      close,
    }
  }).pipe(
    Effect.withSpan("firegrid.cancel_close.driver", {
      attributes: {
        "firegrid.bead": "tf-ll90.4",
        "firegrid.simulation.intent": "cancel-close-current-state",
      },
    }),
  )
