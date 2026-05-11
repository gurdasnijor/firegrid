import { WorkflowEngine } from "@effect/workflow"
import type { HttpClient } from "@effect/platform"
import { Effect, Option } from "effect"
import {
  reactiveWorkflowExecutionId,
  runReactiveWorkflowOperator,
  type ReactiveWorkflowOperator,
} from "../runtime-operators/index.ts"
import {
  RequiredActions,
} from "./service.ts"
import type {
  RequiredActionError,
  RequiredActionRequest,
  RequiredActionRow,
} from "./schema.ts"
import {
  RequiredActionWorkflow,
} from "./workflow.ts"

export const requiredActionOperatorId = "firegrid.required-action"

export const requiredActionWorkflowExecutionId = (
  requiredActionId: string,
): string =>
  reactiveWorkflowExecutionId(requiredActionOperatorId, requiredActionId)

const payloadFromRequestedRow = (
  row: Extract<RequiredActionRow, { readonly type: "firegrid.required_action.requested" }>,
): RequiredActionRequest => ({
  requiredActionId: row.requiredActionId,
  runtimeContextId: row.runtimeContextId,
  requestKind: row.requestKind,
  subject: row.subject,
  ...(row.options === undefined ? {} : { options: row.options }),
  ...(row.prompt === undefined ? {} : { prompt: row.prompt }),
  ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }),
  ...(row.workflowDeferredToken === undefined ? {} : { workflowDeferredToken: row.workflowDeferredToken }),
})

export const requiredActionOperator = (): ReactiveWorkflowOperator<
  RequiredActionRow,
  RequiredActionRequest,
  RequiredActionError,
  RequiredActions | HttpClient.HttpClient,
  RequiredActionError,
  WorkflowEngine.WorkflowEngine
> => ({
  operatorId: requiredActionOperatorId,
  source: {
    sourceId: "firegrid.required-action.rows",
    scan: RequiredActions.pipe(
      Effect.flatMap(actions => actions.rows),
    ),
  },
  select: row =>
    row.type === "firegrid.required_action.requested"
      ? Option.some(payloadFromRequestedRow(row))
      : Option.none(),
  workflowName: RequiredActionWorkflow.name,
  // firegrid-reactive-workflow-operators.WORKFLOW.5
  // firegrid-required-actions.WORKFLOW.7
  executionId: payload => requiredActionWorkflowExecutionId(payload.requiredActionId),
  execute: ({ payload, executionId }) =>
    WorkflowEngine.WorkflowEngine.pipe(
      Effect.flatMap(engine =>
        engine.execute(RequiredActionWorkflow, {
          executionId,
          payload,
          discard: true,
        })),
    ),
})

export const runRequiredActionOperator = () =>
  // firegrid-reactive-workflow-operators.REQUIRED_ACTION_CONSUMER.1
  // firegrid-reactive-workflow-operators.REQUIRED_ACTION_CONSUMER.4
  // firegrid-required-actions.WORKFLOW.7
  runReactiveWorkflowOperator(requiredActionOperator())
