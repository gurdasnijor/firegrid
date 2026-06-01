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
  readonly sessionId: string
  readonly startOffset: string
  readonly promptOffset: string
  readonly promptAfterCancel: ExitSummary
  readonly cancel: ExitSummary
  readonly close: ExitSummary
  readonly snapshotStatus: string
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

const lifecycleCall = (
  operation: "cancel" | "close",
  sessionId: string,
) =>
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    return yield* firegrid.channels.call(`session.${operation}`, {
      sessionId,
      reason: `tf-ll90.4 ${operation} probe`,
    })
  }).pipe(
    Effect.withSpan(`firegrid.cancel_close.driver.session_${operation}`, {
      attributes: {
        "firegrid.session.id": sessionId,
        "firegrid.context.id": sessionId,
        "firegrid.cancel_close.operation": operation,
        "firegrid.channel.target": `session.${operation}`,
      },
    }),
  )

export const driver: Effect.Effect<ControlPlaneCancelCloseResult, unknown, Firegrid> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const context = yield* firegrid.launch({
      runtime: local.jsonl({
        argv: [process.execPath, tsxBin, fakeAgentBin],
        agentProtocol: "acp",
        envBindings: [
          {
            name: "FIREGRID_FAKE_ACP_FIXTURE",
            ref: "env:FIREGRID_FAKE_ACP_FIXTURE",
          },
        ],
      }),
      requestedBy: "tf-ll90.4",
    })
    const session = yield* firegrid.sessions.attach({ sessionId: context.contextId })

    const startOffset = yield* session.start()
    const promptOffset = yield* session.prompt({
      idempotencyKey: "before-cancel",
      payload: "start the cancel-close lifecycle probe",
    })
    yield* Effect.sleep("2 seconds")

    const cancelExit = yield* Effect.exit(lifecycleCall("cancel", session.sessionId))
    yield* Effect.sleep("500 millis")
    const promptAfterCancelExit = yield* Effect.exit(session.prompt({
      idempotencyKey: "after-cancel",
      payload: "probe whether prompt dispatch still accepts input after cancel",
    }))
    const closeExit = yield* Effect.exit(lifecycleCall("close", session.sessionId))
    const snapshot = yield* session.snapshot()

    const cancel = summarizeExit(cancelExit)
    const promptAfterCancel = summarizeExit(promptAfterCancelExit)
    const close = summarizeExit(closeExit)
    const snapshotStatus = snapshot.status ?? "none"

    yield* Effect.annotateCurrentSpan({
      "firegrid.cancel_close.session_id": session.sessionId,
      "firegrid.cancel_close.cancel.exit": cancel.tag,
      "firegrid.cancel_close.cancel.error_tag": cancel.errorTag ?? "",
      "firegrid.cancel_close.close.exit": close.tag,
      "firegrid.cancel_close.close.error_tag": close.errorTag ?? "",
      "firegrid.cancel_close.prompt_after_cancel.exit": promptAfterCancel.tag,
      "firegrid.cancel_close.snapshot.status": snapshotStatus,
    })

    return {
      sessionId: session.sessionId,
      startOffset: startOffset.offset,
      promptOffset: promptOffset.offset,
      promptAfterCancel,
      cancel,
      close,
      snapshotStatus,
    }
  }).pipe(
    Effect.withSpan("firegrid.cancel_close.driver", {
      attributes: {
        "firegrid.bead": "tf-ll90.4",
        "firegrid.simulation.intent": "cancel-close-current-state",
      },
    }),
  )
