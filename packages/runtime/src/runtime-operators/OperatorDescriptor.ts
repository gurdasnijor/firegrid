import type { WorkflowEngine } from "@effect/workflow/WorkflowEngine"
import type { Effect } from "effect"
import type { Option } from "effect"
import type { OperatorSource } from "./OperatorSource.ts"

export interface ReactiveWorkflowOperator<
  Fact,
  Payload,
  SourceError = never,
  SourceRequirements = never,
  WorkflowError = never,
  WorkflowRequirements = WorkflowEngine,
> {
  readonly operatorId: string
  readonly source: OperatorSource<Fact, SourceError, SourceRequirements>
  readonly select: (
    fact: Fact,
  ) => Option.Option<Payload>
  readonly workflowName: string
  readonly executionId: (
    payload: Payload,
  ) => string
  readonly execute: (
    options: {
      readonly payload: Payload
      readonly executionId: string
    },
  ) => Effect.Effect<string, WorkflowError, WorkflowRequirements>
}

export const reactiveWorkflowExecutionId = (
  operatorId: string,
  inputId: string,
): string =>
  `${operatorId}:${inputId}`
