import type {
  WorkflowEngine,
} from "@effect/workflow/WorkflowEngine"
import { Effect } from "effect"
import {
  asRuntimeContextError,
  type RuntimeContextError,
} from "./errors.ts"
import {
  RuntimeContextWorkflow,
} from "./workflow.ts"

export interface StartRuntimeContextOptions {
  readonly contextId: string
}

export interface StartRuntimeResult {
  readonly contextId: string
  readonly activityAttempt: number
  readonly exitCode: number
}

export const startRuntimeContext = (
  options: StartRuntimeContextOptions,
): Effect.Effect<StartRuntimeResult, RuntimeContextError, WorkflowEngine> =>
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.3
  // firegrid-durable-launch-runtime-operator.RUNTIME_HOST.3
  RuntimeContextWorkflow.execute({ contextId: options.contextId }).pipe(
    Effect.flatMap(result =>
      result === undefined
        ? Effect.fail(asRuntimeContextError(
          "workflow.execute",
          "runtime context workflow returned no result",
          options.contextId,
        ))
        : Effect.succeed({
          contextId: result.contextId,
          activityAttempt: result.activityAttempt,
          exitCode: result.exitCode,
        })),
  )
