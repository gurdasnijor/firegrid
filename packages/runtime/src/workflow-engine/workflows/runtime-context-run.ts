import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Effect, Option, Schema } from "effect"
import {
  RuntimeContextRead,
  RuntimeRunAppendAndGet,
} from "../../authorities/index.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  RuntimeContextError,
} from "../../runtime-errors.ts"
// `RuntimeExitEvidence` is owned by `tables/runtime-context-state.ts` (its
// durable storage). Imported here for in-file annotations; re-exported below
// so existing `@firegrid/runtime/workflows` callers keep their import path.
// The single owner avoids the `tables -> workflow-engine -> tables` folder
// cycle that depcruise enforces.
import { RuntimeExitEvidence } from "../../tables/runtime-context-state.ts"

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.2
// RuntimeContextWorkflow owns workflow/activity/run lifecycle wiring only.
export const RuntimeContextWorkflowPayload = Schema.Struct({
  contextId: Schema.String,
})

export const runtimeContextWorkflowExecutionId = (contextId: string) =>
  `runtime-context:${contextId}`

export const readRuntimeContext = (
  contextId: string,
): Effect.Effect<RuntimeContext, RuntimeContextError, RuntimeContextRead> =>
  Effect.gen(function*() {
    const contextRead = yield* RuntimeContextRead
    const maybeContext = yield* contextRead.readContext(contextId).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.contexts.get",
        "failed to read runtime context row",
        contextId,
      ),
    )
    return yield* Option.match(maybeContext, {
      onNone: () =>
        Effect.fail(asRuntimeContextError(
          "runtime-control-plane.contexts.get",
          `runtime context not found: ${contextId}`,
          contextId,
        )),
      onSome: row => Effect.succeed(row),
    })
  })

// Re-export `RuntimeExitEvidence` from its new owner (`tables/`) so existing
// `@firegrid/runtime/workflows` callers keep working.
export { RuntimeExitEvidence }

export const StartRuntimeResultSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
  failure: Schema.optional(RuntimeContextError),
})

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
    return yield* error
  })

export const writeRunFailedResult = (
  context: RuntimeContext,
  activityAttempt: number,
  error: RuntimeContextError,
) =>
  writeRunFailed(context, activityAttempt, error.message).pipe(
    Effect.as({
      contextId: context.contextId,
      activityAttempt,
      exitCode: 1,
      failure: error,
    } satisfies StartRuntimeResult),
  )

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
