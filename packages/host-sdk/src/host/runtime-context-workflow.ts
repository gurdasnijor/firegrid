import {
  Activity,
  Workflow,
} from "@effect/workflow"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Effect } from "effect"
import {
  RuntimeContextError,
} from "@firegrid/runtime/errors"
import { runRuntimeContext } from "./raw-process-runtime.ts"
import {
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
} from "./internal/runtime-context-helpers.ts"
import {
  RuntimeContextWorkflowPayload,
  RuntimeExitEvidence,
  StartRuntimeResultSchema,
  allocateRuntimeActivityAttempt,
  failAfterWritingRunFailed,
  writeRunExitedResult,
  writeRunStarted,
} from "./internal/runtime-context-workflow-run.ts"

export { RuntimeContextWorkflowPayload }

const runRuntimeContextActivity = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Activity.make({
    name: "firegrid.runtime-context.run",
    success: RuntimeExitEvidence,
    error: RuntimeContextError,
    execute: runRuntimeContext(context, activityAttempt),
  })

export const RuntimeContextWorkflow = Workflow.make({
  name: "firegrid.runtime-context",
  payload: RuntimeContextWorkflowPayload,
  success: StartRuntimeResultSchema,
  error: RuntimeContextError,
  idempotencyKey: ({ contextId }) => runtimeContextWorkflowExecutionId(contextId),
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
    return yield* writeRunExitedResult(context, activityAttempt, exit)
  }))
