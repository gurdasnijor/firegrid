import { DurableDeferred, Workflow } from "@effect/workflow"
import { Effect } from "effect"
import {
  RequiredActions,
} from "./service.ts"
import {
  RequiredActionError,
  type RequiredActionRequest,
  RequiredActionRequestSchema,
  RequiredActionResolutionSchema,
} from "./schema.ts"
import {
  RequiredActionResolutionDeferred,
  requiredActionWorkflowName,
} from "./deferred.ts"

export const RequiredActionWorkflow = Workflow.make({
  name: requiredActionWorkflowName,
  payload: RequiredActionRequestSchema,
  success: RequiredActionResolutionSchema,
  error: RequiredActionError,
  idempotencyKey: payload => payload.requiredActionId,
})

export const runRequiredActionWorkflow = Effect.fn(function* runRequiredAction(payload: RequiredActionRequest) {
    const actions = yield* RequiredActions
    const token = yield* DurableDeferred.token(RequiredActionResolutionDeferred)
    // firegrid-required-actions.WORKFLOW.1
    yield* actions.request({
      ...payload,
      workflowDeferredToken: token,
    })

    const state = yield* actions.get(payload.requiredActionId)
    if (state.resolution !== undefined) return state.resolution

    // firegrid-required-actions.WORKFLOW.2
    const decision = yield* DurableDeferred.await(RequiredActionResolutionDeferred)

    // firegrid-required-actions.WORKFLOW.3
    yield* actions.resolve(decision)

    return decision
})

export const RequiredActionWorkflowLayer = RequiredActionWorkflow.toLayer(
  runRequiredActionWorkflow,
)
