import {
  Activity,
  Workflow,
} from "@effect/workflow"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Effect, Schema } from "effect"
import {
  RuntimeContextError,
  mapRuntimeContextError,
} from "../runtime-errors.ts"
import {
  RuntimeRunAppendAndGet,
} from "../authorities/index.ts"
import {
  RuntimeOutputJournalLayer,
} from "../agent-event-pipeline/authorities/runtime-output-journal.ts"
import { runRuntimeContext } from "./raw-process-runtime.ts"
import {
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
} from "./internal/runtime-context-helpers.ts"

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.2
// RuntimeContextWorkflow owns workflow/activity/run lifecycle wiring only.
export const RuntimeContextWorkflowPayload = Schema.Struct({
  contextId: Schema.String,
})

const RuntimeExitEvidence = Schema.Struct({
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})

const StartRuntimeResultSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})

const allocateRuntimeActivityAttempt = (
  context: RuntimeContext,
) =>
  // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2
  Effect.gen(function* () {
    const runtimeRuns = yield* RuntimeRunAppendAndGet
    return yield* runtimeRuns.allocateActivityAttempt(context)
  }).pipe(
    mapRuntimeContextError(
      "runtime-control-plane.runs.allocate-attempt",
      "failed to allocate runtime activity attempt",
      context.contextId,
    ),
  )

const writeRunStarted = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Effect.gen(function* () {
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
  exit: Schema.Schema.Type<typeof RuntimeExitEvidence>,
) =>
  Effect.gen(function* () {
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
  Effect.gen(function* () {
    const runtimeRuns = yield* RuntimeRunAppendAndGet
    yield* runtimeRuns.recordFailed(context, activityAttempt, message).pipe(
      mapRuntimeContextError(
        "runtime-control-plane.runs.failed",
        "failed to append runtime failed row",
        context.contextId,
      ),
    )
  })

const runRuntimeContextActivity = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Activity.make({
    name: "firegrid.runtime-context.run",
    success: RuntimeExitEvidence,
    error: RuntimeContextError,
    execute: runRuntimeContext(context, activityAttempt).pipe(
      Effect.provide(RuntimeOutputJournalLayer),
    ),
  })

export const RuntimeContextWorkflow = Workflow.make({
  name: "firegrid.runtime-context",
  payload: RuntimeContextWorkflowPayload,
  success: StartRuntimeResultSchema,
  error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => runtimeContextWorkflowExecutionId(contextId),
})

const failAfterWritingRunFailed = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
(error: RuntimeContextError) =>
  Effect.gen(function* () {
    yield* writeRunFailed(context, activityAttempt, error.message)
    return yield* Effect.fail(error)
  })

export const RuntimeContextWorkflowLayer = RuntimeContextWorkflow.toLayer(({ contextId }) =>
  Effect.gen(function* () {
    // firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.2
    const context = yield* readRuntimeContext(contextId)
    const activityAttempt = yield* allocateRuntimeActivityAttempt(context)
    yield* writeRunStarted(context, activityAttempt)
    const exit = yield* runRuntimeContextActivity(context, activityAttempt).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    yield* writeRunExited(context, activityAttempt, exit).pipe(
      Effect.catchAll(failAfterWritingRunFailed(context, activityAttempt)),
    )
    return {
      contextId: context.contextId,
      activityAttempt,
      exitCode: exit.exitCode,
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    }
  }))
