import {
  RuntimeIngressAuthorSchema,
  RuntimeIngressKindSchema,
} from "@firegrid/protocol/runtime-ingress"
import { Schema } from "effect"
import {
  DurableTable,
  type DurableTableHeaders,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"

export interface RuntimeScheduledInputTableOptions {
  readonly streamUrl: string
  readonly contentType?: string
  readonly headers?: DurableTableHeaders
  readonly txTimeoutMs?: number
}

const ScheduledRuntimeInputStatusSchema = Schema.Literal(
  "pending",
  "fired",
)
export type ScheduledRuntimeInputStatus = Schema.Schema.Type<
  typeof ScheduledRuntimeInputStatusSchema
>

const ScheduledRuntimeInputRowSchema = Schema.Struct({
  scheduleId: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  dueAtMs: Schema.Number,
  status: ScheduledRuntimeInputStatusSchema,
  kind: RuntimeIngressKindSchema,
  authoredBy: RuntimeIngressAuthorSchema,
  payload: Schema.Unknown,
  inputId: Schema.String,
  idempotencyKey: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
  createdAtMs: Schema.Number,
  firedAtMs: Schema.optional(Schema.Number),
  firedInputId: Schema.optional(Schema.String),
})
export type ScheduledRuntimeInputRow = Schema.Schema.Type<
  typeof ScheduledRuntimeInputRowSchema
>

const runtimeScheduledInputSchemas = {
  scheduledInputs: ScheduledRuntimeInputRowSchema,
} as const

export class RuntimeScheduledInputTable extends DurableTable(
  "firegrid.runtimeScheduledInput",
  runtimeScheduledInputSchemas,
) {}

export type RuntimeScheduledInputTableService = DurableTableService<
  typeof runtimeScheduledInputSchemas
>

export const runtimeScheduledInputTableLayerOptions = (
  options: RuntimeScheduledInputTableOptions,
): DurableTableLayerOptions => {
  const streamOptions: DurableTableLayerOptions["streamOptions"] = {
    url: options.streamUrl,
    contentType: options.contentType ?? "application/json",
  }
  if (options.headers !== undefined) {
    streamOptions.headers = options.headers
  }
  return {
    streamOptions,
    txTimeoutMs: options.txTimeoutMs ?? 2_000,
  }
}
