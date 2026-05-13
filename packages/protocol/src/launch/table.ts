import { DurableTable, type DurableTableService } from "effect-durable-operators"
import { Schema } from "effect"
import {
  RuntimeProviderSchema,
  type RuntimeContext,
  type RuntimeRunEvent,
} from "./schema.ts"

const RuntimeContextRowSchema = Schema.Struct({
  contextId: Schema.String.pipe(DurableTable.primaryKey),
  createdAt: Schema.String,
  createdBy: Schema.optional(Schema.String),
  runtime: Schema.Unknown,
})

const RuntimeRunEventRowSchema = Schema.Struct({
  runEventId: Schema.String.pipe(DurableTable.primaryKey),
  runId: Schema.String,
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  status: Schema.Literal("started", "exited", "failed"),
  at: Schema.String,
  provider: RuntimeProviderSchema,
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
})

const runtimeControlPlaneSchemas = {
  contexts: RuntimeContextRowSchema,
  runs: RuntimeRunEventRowSchema,
} as const

export class RuntimeControlPlaneTable extends DurableTable(
  "firegrid.runtime",
  runtimeControlPlaneSchemas,
) {}

export type RuntimeControlPlaneTableService = DurableTableService<typeof runtimeControlPlaneSchemas>
export type RuntimeContextRow = RuntimeContext
export type RuntimeRunEventRow = RuntimeRunEvent
