import { Workflow } from "@effect/workflow"
import {
  RuntimeControlRequestCompletionRowSchema,
  RuntimeContextRequestRowSchema,
  RuntimeLifecycleRequestRowSchema,
  RuntimeStartRequestRowSchema,
  runtimeContextWorkflowStreamUrl,
  type RuntimeControlRequestKind,
} from "@firegrid/protocol/launch"
import { Schema } from "effect"

export const RuntimeContextProvisionWorkflowPayload = Schema.Struct({
  request: RuntimeContextRequestRowSchema,
  abandonAfterMs: Schema.Number,
})

export const RuntimeStartWorkflowPayload = Schema.Struct({
  request: RuntimeStartRequestRowSchema,
  abandonAfterMs: Schema.Number,
})

export const RuntimeLifecycleWorkflowPayload = Schema.Struct({
  request: RuntimeLifecycleRequestRowSchema,
  abandonAfterMs: Schema.Number,
})

export const RuntimeControlRequestClaimedOutcomeSchema = Schema.Struct({
  _tag: Schema.Literal("Claimed"),
  hostId: Schema.String,
})

export const RuntimeControlRequestDoneOutcomeSchema = Schema.Struct({
  _tag: Schema.Literal("Done"),
})

export const RuntimeControlRequestDispatchOutcomeSchema = Schema.Union(
  RuntimeControlRequestClaimedOutcomeSchema,
  RuntimeControlRequestDoneOutcomeSchema,
)

export type RuntimeControlRequestDispatchOutcome = Schema.Schema.Type<
  typeof RuntimeControlRequestDispatchOutcomeSchema
>

export const runtimeControlRequestWorkflowExecutionId = (
  requestKind: RuntimeControlRequestKind,
  requestId: string,
): string => `runtime-control:${requestKind}:${requestId}`

export const RuntimeContextProvisionWorkflow = Workflow.make({
  name: "firegrid.runtime-control.context-provision",
  payload: RuntimeContextProvisionWorkflowPayload,
  success: RuntimeControlRequestCompletionRowSchema,
  error: Schema.Never,
  idempotencyKey: ({ request }) =>
    runtimeControlRequestWorkflowExecutionId("context", request.requestId),
})

export const RuntimeStartWorkflow = Workflow.make({
  name: "firegrid.runtime-control.start",
  payload: RuntimeStartWorkflowPayload,
  success: RuntimeControlRequestDispatchOutcomeSchema,
  error: Schema.Never,
  idempotencyKey: ({ request }) =>
    runtimeControlRequestWorkflowExecutionId("start", request.requestId),
})

export const RuntimeLifecycleWorkflow = Workflow.make({
  name: "firegrid.runtime-control.lifecycle",
  payload: RuntimeLifecycleWorkflowPayload,
  success: RuntimeControlRequestDispatchOutcomeSchema,
  error: Schema.Never,
  idempotencyKey: ({ request }) =>
    runtimeControlRequestWorkflowExecutionId(request.lifecycle, request.requestId),
})

export const runtimeControlRequestWorkflowStreamUrl = (input: {
  readonly baseUrl: string
  readonly namespace: string
}): string => runtimeContextWorkflowStreamUrl({
  ...input,
  contextId: "__control_requests__",
})
