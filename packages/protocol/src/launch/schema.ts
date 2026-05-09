import { Schema } from "effect"

export const RuntimeOutputSourceSchema = Schema.Literal("stdout", "stderr")
export type RuntimeOutputSource = Schema.Schema.Type<typeof RuntimeOutputSourceSchema>

export const RuntimeJournalTargetSchema = Schema.Literal("events", "logs")
export type RuntimeJournalTarget = Schema.Schema.Type<typeof RuntimeJournalTargetSchema>

export const RuntimeJournalFormatSchema = Schema.Literal("jsonl", "text-lines")
export type RuntimeJournalFormat = Schema.Schema.Type<typeof RuntimeJournalFormatSchema>

export const RuntimeProviderSchema = Schema.Literal("local-process")
export type RuntimeProvider = Schema.Schema.Type<typeof RuntimeProviderSchema>

export const RuntimeConfigSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
})
export type RuntimeConfig = Schema.Schema.Type<typeof RuntimeConfigSchema>

export const RuntimeJournalRuleSchema = Schema.Struct({
  source: RuntimeOutputSourceSchema,
  format: RuntimeJournalFormatSchema,
  target: RuntimeJournalTargetSchema,
})
export type RuntimeJournalRule = Schema.Schema.Type<typeof RuntimeJournalRuleSchema>

export const RuntimeContextIntentSchema = Schema.Struct({
  provider: RuntimeProviderSchema,
  config: RuntimeConfigSchema,
  journal: Schema.Array(RuntimeJournalRuleSchema),
})
export type RuntimeContextIntent = Schema.Schema.Type<typeof RuntimeContextIntentSchema>

export const PublicLaunchRuntimeIntentSchema = Schema.Struct({
  provider: RuntimeProviderSchema,
  config: RuntimeConfigSchema,
})
export type PublicLaunchRuntimeIntent = Schema.Schema.Type<typeof PublicLaunchRuntimeIntentSchema>

export const PublicLaunchRequestSchema = Schema.Struct({
  runtime: PublicLaunchRuntimeIntentSchema,
  requestedBy: Schema.optional(Schema.String),
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type PublicLaunchRequest = Schema.Schema.Type<typeof PublicLaunchRequestSchema>

export const RuntimeContextSchema = Schema.Struct({
  contextId: Schema.String,
  createdAt: Schema.String,
  createdBy: Schema.optional(Schema.String),
  runtime: RuntimeContextIntentSchema,
})
export type RuntimeContext = Schema.Schema.Type<typeof RuntimeContextSchema>

export const RuntimeRunEventSchema = Schema.Struct({
  runEventId: Schema.String,
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
export type RuntimeRunEvent = Schema.Schema.Type<typeof RuntimeRunEventSchema>

export const RuntimeEventSchema = Schema.Struct({
  eventId: Schema.String,
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  source: Schema.Literal("stdout"),
  format: Schema.Literal("jsonl"),
  receivedAt: Schema.String,
  raw: Schema.String,
})
export type RuntimeEvent = Schema.Schema.Type<typeof RuntimeEventSchema>

export const RuntimeLogLineSchema = Schema.Struct({
  logLineId: Schema.String,
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  source: Schema.Literal("stderr"),
  format: Schema.Literal("text-lines"),
  receivedAt: Schema.String,
  raw: Schema.String,
})
export type RuntimeLogLine = Schema.Schema.Type<typeof RuntimeLogLineSchema>

export const RuntimeOutputStdoutJournalEventSchema = Schema.Struct({
  type: Schema.Literal("firegrid.runtime.output.stdout"),
  id: Schema.String,
  at: Schema.String,
  event: RuntimeEventSchema,
})
export type RuntimeOutputStdoutJournalEvent = Schema.Schema.Type<
  typeof RuntimeOutputStdoutJournalEventSchema
>

export const RuntimeOutputStderrJournalEventSchema = Schema.Struct({
  type: Schema.Literal("firegrid.runtime.output.stderr"),
  id: Schema.String,
  at: Schema.String,
  log: RuntimeLogLineSchema,
})
export type RuntimeOutputStderrJournalEvent = Schema.Schema.Type<
  typeof RuntimeOutputStderrJournalEventSchema
>

export const RuntimeJournalEventSchema = Schema.Union(
  RuntimeOutputStdoutJournalEventSchema,
  RuntimeOutputStderrJournalEventSchema,
)
export type RuntimeJournalEvent = Schema.Schema.Type<typeof RuntimeJournalEventSchema>
