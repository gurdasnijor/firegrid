import { DurableTable, type DurableTableService } from "effect-durable-operators"
import { Schema } from "effect"
import {
  RuntimeContextIntentSchema,
  RuntimeOutputEventKeySchema,
  RuntimeOutputLogLineKeySchema,
  RuntimeRunEventKeySchema,
  runtimeEventFields,
  runtimeLogLineFields,
  runtimeRunEventFields,
  type RuntimeContext,
} from "./schema.ts"

const KEY_SEPARATOR = "\x1f"

const RuntimeRunEventPrimaryKeySchema = Schema.transform(
  Schema.String,
  RuntimeRunEventKeySchema,
  {
    strict: false,
    decode: (encoded: string) => {
      const [contextId = "", activityAttempt = "0", status = "started"] = encoded.split(KEY_SEPARATOR)
      return {
        contextId,
        activityAttempt: Number(activityAttempt),
        status: status as "started" | "exited" | "failed",
      }
    },
    encode: ({ contextId, activityAttempt, status }) =>
      [contextId, String(activityAttempt), status].join(KEY_SEPARATOR),
  },
)

const RuntimeOutputEventPrimaryKeySchema = Schema.transform(
  Schema.String,
  RuntimeOutputEventKeySchema,
  {
    strict: false,
    decode: (encoded: string) => {
      const [contextId = "", activityAttempt = "0", target = "events", sequence = "0"] = encoded.split(KEY_SEPARATOR)
      return {
        contextId,
        activityAttempt: Number(activityAttempt),
        target: target as "events",
        sequence: Number(sequence),
      }
    },
    encode: ({ contextId, activityAttempt, target, sequence }) =>
      [contextId, String(activityAttempt), target, String(sequence)].join(KEY_SEPARATOR),
  },
)

const RuntimeOutputLogLinePrimaryKeySchema = Schema.transform(
  Schema.String,
  RuntimeOutputLogLineKeySchema,
  {
    strict: false,
    decode: (encoded: string) => {
      const [contextId = "", activityAttempt = "0", target = "logs", sequence = "0"] = encoded.split(KEY_SEPARATOR)
      return {
        contextId,
        activityAttempt: Number(activityAttempt),
        target: target as "logs",
        sequence: Number(sequence),
      }
    },
    encode: ({ contextId, activityAttempt, target, sequence }) =>
      [contextId, String(activityAttempt), target, String(sequence)].join(KEY_SEPARATOR),
  },
)

const RuntimeContextRowSchema = Schema.Struct({
  contextId: Schema.String.pipe(DurableTable.primaryKey),
  createdAt: Schema.String,
  createdBy: Schema.optional(Schema.String),
  runtime: RuntimeContextIntentSchema,
})

const RuntimeRunEventRowSchema = Schema.Struct({
  ...runtimeRunEventFields,
  runEventId: RuntimeRunEventPrimaryKeySchema.pipe(DurableTable.primaryKey),
})

const runtimeControlPlaneSchemas = {
  contexts: RuntimeContextRowSchema,
  runs: RuntimeRunEventRowSchema,
} as const

const RuntimeEventRowSchema = Schema.Struct({
  ...runtimeEventFields,
  eventId: RuntimeOutputEventPrimaryKeySchema.pipe(DurableTable.primaryKey),
})

const RuntimeLogLineRowSchema = Schema.Struct({
  ...runtimeLogLineFields,
  logLineId: RuntimeOutputLogLinePrimaryKeySchema.pipe(DurableTable.primaryKey),
})

const runtimeOutputSchemas = {
  events: RuntimeEventRowSchema,
  logs: RuntimeLogLineRowSchema,
} as const

export class RuntimeControlPlaneTable extends DurableTable(
  "firegrid.runtime",
  runtimeControlPlaneSchemas,
) {}

export class RuntimeOutputTable extends DurableTable(
  "firegrid.runtimeOutput",
  runtimeOutputSchemas,
) {}

export type RuntimeControlPlaneTableService = DurableTableService<typeof runtimeControlPlaneSchemas>
export type RuntimeOutputTableService = DurableTableService<typeof runtimeOutputSchemas>
export type RuntimeContextRow = RuntimeContext
export type RuntimeRunEventRow = Schema.Schema.Type<typeof RuntimeRunEventRowSchema>
export type RuntimeEventRow = Schema.Schema.Type<typeof RuntimeEventRowSchema>
export type RuntimeLogLineRow = Schema.Schema.Type<typeof RuntimeLogLineRowSchema>
