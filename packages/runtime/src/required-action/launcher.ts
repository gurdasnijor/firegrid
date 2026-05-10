import type { WorkflowEngine } from "@effect/workflow/WorkflowEngine"
import {
  WorkflowEngine as WorkflowEngineService,
} from "@effect/workflow"
import {
  DurableStreamsWorkflowEngine,
} from "@firegrid/durable-streams/workflow-engine"
import { Effect, Layer } from "effect"
import {
  RequiredActionsLive,
  type RequiredActions,
  type RequiredActionsOptions,
} from "./service.ts"
import {
  RequiredActionWorkflow,
  runRequiredActionWorkflow,
} from "./workflow.ts"
import type {
  RequiredActionError,
  RequiredActionRequest,
  RequiredActionResolution,
} from "./schema.ts"

export interface RequiredActionRuntimeOptions {
  readonly requiredActionStreamUrl: string
  readonly workflowStreamUrl: string
  readonly workerId?: string
}

export const RequiredActionRuntimeLive = (
  options: RequiredActionRuntimeOptions,
) => {
  const workflowEngine = DurableStreamsWorkflowEngine.layer({
    streamUrl: options.workflowStreamUrl,
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
  })
  const requiredActions = RequiredActionsLive({
    streamUrl: options.requiredActionStreamUrl,
  })

  return Layer.mergeAll(
    requiredActions,
    workflowEngine,
  )
}

export const RequiredActionStateLive = (
  options: RequiredActionsOptions,
) =>
  RequiredActionsLive(options)

export const startRequiredAction = (
  request: RequiredActionRequest,
): Effect.Effect<RequiredActionResolution, RequiredActionError, WorkflowEngine | RequiredActions> =>
  // firegrid-required-actions.BOUNDARY.1
  // firegrid-required-actions.BOUNDARY.2
  // firegrid-required-actions.BOUNDARY.3
  // firegrid-required-actions.BOUNDARY.4
  Effect.scoped(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngineService.WorkflowEngine
      yield* engine.register(RequiredActionWorkflow, runRequiredActionWorkflow)
      return yield* RequiredActionWorkflow.execute(request)
    }),
  )
