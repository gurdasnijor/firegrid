import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Effect, Schema } from "effect"
import { RuntimeRunAppendAndGet } from "@firegrid/runtime/control-plane"
import {
  mapRuntimeContextError,
} from "@firegrid/runtime/errors"
import type { RuntimeContextError } from "@firegrid/runtime/errors"

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.2
// RuntimeContextWorkflow owns workflow/activity/run lifecycle wiring only.
export const RuntimeContextWorkflowPayload = Schema.Struct({
  contextId: Schema.String,
})

export const RuntimeExitEvidence = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})

export const StartRuntimeResultSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})

export type RuntimeExitEvidence = Schema.Schema.Type<typeof RuntimeExitEvidence>
export type StartRuntimeResult = Schema.Schema.Type<typeof StartRuntimeResultSchema>

export const allocateRuntimeActivityAttempt = (
  context: RuntimeContext,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2
  Effect.gen(function*() {
    const runtimeRuns = yield* RuntimeRunAppendAndGet
    return yield* runtimeRuns.allocateActivityAttempt(context)
  }).pipe(
    mapRuntimeContextError(
      "runtime-control-plane.runs.allocate-attempt",
      "failed to allocate runtime activity attempt",
      context.contextId,
    ),
  )

export const writeRunStarted = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Effect.gen(function*() {
    const runtimeRuns = yield* RuntimeRunAppendAndGet
    yield* runtimeRuns.recordStarted(context, activityAttempt).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.started",
        "failed to append runtime started row",
        context.contextId,
      ),
    )
  })

const writeRunExited = (
  context: RuntimeContext,
  activityAttempt: number,
  exit: RuntimeExitEvidence,
) =>
  Effect.gen(function*() {
    const runtimeRuns = yield* RuntimeRunAppendAndGet
    yield* runtimeRuns.recordExited(context, activityAttempt, exit).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.exited",
        "failed to append runtime exited row",
        context.contextId,
      ),
    )
  })

const writeRunFailed = (
  context: RuntimeContext,
  activityAttempt: number,
  message: string,
) =>
  Effect.gen(function*() {
    const runtimeRuns = yield* RuntimeRunAppendAndGet
    yield* runtimeRuns.recordFailed(context, activityAttempt, message).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.failed",
        "failed to append runtime failed row",
        context.contextId,
      ),
    )
  })

export const failAfterWritingRunFailed = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
(error: RuntimeContextError) =>
  Effect.gen(function*() {
    yield* writeRunFailed(context, activityAttempt, error.message)
    return yield* Effect.fail(error)
  })

const startRuntimeResult = (
  context: RuntimeContext,
  activityAttempt: number,
  exit: RuntimeExitEvidence,
): StartRuntimeResult => ({
  contextId: context.contextId,
  activityAttempt,
  exitCode: exit.exitCode,
  ...(exit.signal === undefined ? {} : { signal: exit.signal }),
})

export const writeRunExitedResult = (
  context: RuntimeContext,
  activityAttempt: number,
  exit: RuntimeExitEvidence,
) =>
  writeRunExited(context, activityAttempt, exit).pipe(
    Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    Effect.as(startRuntimeResult(context, activityAttempt, exit)),
  )
