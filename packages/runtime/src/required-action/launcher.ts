import type { WorkflowEngine } from "@effect/workflow/WorkflowEngine"
import { FetchHttpClient } from "@effect/platform"
import {
  DurableStreamsWorkflowEngine,
} from "@firegrid/durable-streams/workflow-engine"
import { Duration, Effect, Exit, Layer } from "effect"
import {
  ReactiveWorkflowOperatorRuntimeLive,
} from "../runtime-operators/index.ts"
import {
  RequiredActionsLive,
  type RequiredActionsOptions,
} from "./service.ts"
import {
  RequiredActionWorkflow,
  RequiredActionWorkflowLayer,
} from "./workflow.ts"
import {
  requiredActionWorkflowExecutionId,
} from "./operator.ts"
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

  return RequiredActionWorkflowLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(
      requiredActions,
      workflowEngine,
      ReactiveWorkflowOperatorRuntimeLive,
      FetchHttpClient.layer,
    )),
  )
}

export const RequiredActionStateLive = (
  options: RequiredActionsOptions,
) =>
  RequiredActionsLive(options)

export const startRequiredAction = (
  request: RequiredActionRequest,
): Effect.Effect<RequiredActionResolution, RequiredActionError, WorkflowEngine> =>
  // firegrid-required-actions.BOUNDARY.1
  // firegrid-required-actions.BOUNDARY.2
  // firegrid-required-actions.BOUNDARY.3
  // firegrid-required-actions.BOUNDARY.4
  Effect.scoped(
    RequiredActionWorkflow.execute(request),
  )

export const awaitRequiredActionWorkflow = (
  requiredActionId: string,
): Effect.Effect<RequiredActionResolution, RequiredActionError, WorkflowEngine> =>
  RequiredActionWorkflow.poll(requiredActionWorkflowExecutionId(requiredActionId)).pipe(
    Effect.flatMap(result => {
      if (result?._tag === "Complete") {
        return Exit.matchEffect(result.exit, {
          onFailure: cause => Effect.failCause(cause),
          onSuccess: Effect.succeed,
        })
      }
      return Effect.sleep(Duration.millis(10)).pipe(
        Effect.flatMap(() => awaitRequiredActionWorkflow(requiredActionId)),
      )
    }),
  )
