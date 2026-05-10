import { Schema } from "effect"

export class ReactiveWorkflowOperatorError
  extends Schema.TaggedError<ReactiveWorkflowOperatorError>()(
    "ReactiveWorkflowOperatorError",
    {
      op: Schema.String,
      operatorId: Schema.optional(Schema.String),
      sourceId: Schema.optional(Schema.String),
      executionId: Schema.optional(Schema.String),
      message: Schema.String,
      cause: Schema.optional(Schema.Unknown),
    },
  )
{}

export const reactiveWorkflowOperatorError = (
  op: string,
  message: string,
  options?: {
    readonly operatorId?: string
    readonly sourceId?: string
    readonly executionId?: string
    readonly cause?: unknown
  },
): ReactiveWorkflowOperatorError =>
  new ReactiveWorkflowOperatorError({
    op,
    message,
    ...(options?.operatorId === undefined ? {} : { operatorId: options.operatorId }),
    ...(options?.sourceId === undefined ? {} : { sourceId: options.sourceId }),
    ...(options?.executionId === undefined ? {} : { executionId: options.executionId }),
    ...(options?.cause === undefined ? {} : { cause: options.cause }),
  })

export const ReactiveWorkflowOperatorRunSummarySchema = Schema.Struct({
  operatorId: Schema.String,
  sourceId: Schema.String,
  factsRead: Schema.Number,
  payloadsSelected: Schema.Number,
  duplicateInputsSkipped: Schema.Number,
  workflowExecutionsRequested: Schema.Number,
  executionIds: Schema.Array(Schema.String),
})
export type ReactiveWorkflowOperatorRunSummary = Schema.Schema.Type<
  typeof ReactiveWorkflowOperatorRunSummarySchema
>
