import { Schema } from "effect"
import {
  DurableTable,
  type DurableTableHeaders,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"

export interface WorkflowEngineDurableStateOptions {
  readonly streamUrl: string
  readonly contentType?: string
  readonly headers?: DurableTableHeaders
  readonly workerId?: string
  readonly txTimeoutMs?: number
}

const WorkflowExecutionRowSchema = Schema.Struct({
  executionId: Schema.String.pipe(DurableTable.primaryKey),
  workflowName: Schema.String,
  payload: Schema.Unknown,
  parentExecutionId: Schema.optional(Schema.String),
  interrupted: Schema.Boolean,
  suspended: Schema.Boolean,
  cause: Schema.optional(Schema.Unknown),
  finalResult: Schema.optional(Schema.Unknown),
})
export type WorkflowExecutionRow = Schema.Schema.Type<typeof WorkflowExecutionRowSchema>

const WorkflowActivityRowSchema = Schema.Struct({
  activityKey: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  activityName: Schema.String,
  attempt: Schema.Number,
  result: Schema.Unknown,
})
export type WorkflowActivityRow = Schema.Schema.Type<typeof WorkflowActivityRowSchema>

const WorkflowActivityClaimRowSchema = Schema.Struct({
  claimKey: Schema.String.pipe(DurableTable.primaryKey),
  executionId: Schema.String,
  activityName: Schema.String,
  attempt: Schema.Number,
  workerId: Schema.String,
  claimedAtMs: Schema.Number,
})
export type WorkflowActivityClaimRow = Schema.Schema.Type<typeof WorkflowActivityClaimRowSchema>

const WorkflowDeferredRowSchema = Schema.Struct({
  deferredKey: Schema.String.pipe(DurableTable.primaryKey),
  workflowName: Schema.String,
  executionId: Schema.String,
  deferredName: Schema.String,
  exit: Schema.Unknown,
})
export type WorkflowDeferredRow = Schema.Schema.Type<typeof WorkflowDeferredRowSchema>

const WorkflowClockWakeupRowSchema = Schema.Struct({
  clockKey: Schema.String.pipe(DurableTable.primaryKey),
  workflowName: Schema.String,
  executionId: Schema.String,
  clockName: Schema.String,
  deferredName: Schema.String,
  deadlineMs: Schema.Number,
  status: Schema.Literal("pending", "fired"),
})
export type WorkflowClockWakeupRow = Schema.Schema.Type<typeof WorkflowClockWakeupRowSchema>

const workflowEngineSchemas = {
  executions: WorkflowExecutionRowSchema,
  activities: WorkflowActivityRowSchema,
  activityClaims: WorkflowActivityClaimRowSchema,
  deferreds: WorkflowDeferredRowSchema,
  clockWakeups: WorkflowClockWakeupRowSchema,
} as const

export class WorkflowEngineTable extends DurableTable<WorkflowEngineTable>()(
  "firegrid.workflow",
  workflowEngineSchemas,
) {}

export type WorkflowEngineTableService = DurableTableService<typeof workflowEngineSchemas>

export const workflowEngineTableLayerOptions = (
  options: WorkflowEngineDurableStateOptions,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: options.streamUrl,
    contentType: options.contentType ?? "application/json",
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  },
  txTimeoutMs: options.txTimeoutMs ?? 2_000,
})
