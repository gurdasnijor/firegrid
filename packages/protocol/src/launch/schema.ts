import { Schema } from "effect"

export const LaunchOutputSourceSchema = Schema.Literal("stdout", "stderr")
export type LaunchOutputSource = Schema.Schema.Type<typeof LaunchOutputSourceSchema>

export const LaunchJournalStreamSchema = Schema.Literal("provider-wire", "diagnostics")
export type LaunchJournalStream = Schema.Schema.Type<typeof LaunchJournalStreamSchema>

export const LaunchJournalFormatSchema = Schema.Literal("jsonl", "text-lines")
export type LaunchJournalFormat = Schema.Schema.Type<typeof LaunchJournalFormatSchema>

export const RuntimeProviderSchema = Schema.Literal("local-process")
export type RuntimeProvider = Schema.Schema.Type<typeof RuntimeProviderSchema>

export const RuntimeConfigSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
})
export type RuntimeConfig = Schema.Schema.Type<typeof RuntimeConfigSchema>

export const LaunchJournalRuleSchema = Schema.Struct({
  source: LaunchOutputSourceSchema,
  format: LaunchJournalFormatSchema,
  stream: LaunchJournalStreamSchema,
})
export type LaunchJournalRule = Schema.Schema.Type<typeof LaunchJournalRuleSchema>

export const LaunchRuntimeIntentSchema = Schema.Struct({
  provider: RuntimeProviderSchema,
  config: RuntimeConfigSchema,
  journal: Schema.Array(LaunchJournalRuleSchema),
})
export type LaunchRuntimeIntent = Schema.Schema.Type<typeof LaunchRuntimeIntentSchema>

export const PublicLaunchRuntimeIntentSchema = Schema.Struct({
  provider: RuntimeProviderSchema,
  config: RuntimeConfigSchema,
})
export type PublicLaunchRuntimeIntent = Schema.Schema.Type<typeof PublicLaunchRuntimeIntentSchema>

export const PublicLaunchRequestSchema = Schema.Struct({
  runtime: PublicLaunchRuntimeIntentSchema,
  requestedBy: Schema.optional(Schema.String),
})
export type PublicLaunchRequest = Schema.Schema.Type<typeof PublicLaunchRequestSchema>

export const RuntimeLaunchRequestSchema = Schema.Struct({
  launchId: Schema.String,
  requestedAt: Schema.String,
  requestedBy: Schema.optional(Schema.String),
  runtime: LaunchRuntimeIntentSchema,
})
export type RuntimeLaunchRequest = Schema.Schema.Type<typeof RuntimeLaunchRequestSchema>

export const RuntimeProcessEventSchema = Schema.Struct({
  processEventId: Schema.String,
  processAttemptId: Schema.String,
  launchId: Schema.String,
  activityAttempt: Schema.Number,
  status: Schema.Literal("started", "exited", "failed"),
  at: Schema.String,
  provider: RuntimeProviderSchema,
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
})
export type RuntimeProcessEvent = Schema.Schema.Type<typeof RuntimeProcessEventSchema>

export const ProviderWireRowSchema = Schema.Struct({
  providerWireRowId: Schema.String,
  launchId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  channel: Schema.Literal("stdout"),
  format: Schema.Literal("jsonl"),
  stream: Schema.Literal("provider-wire"),
  receivedAt: Schema.String,
  raw: Schema.String,
  parseStatus: Schema.Literal("valid-json", "malformed-json"),
})
export type ProviderWireRow = Schema.Schema.Type<typeof ProviderWireRowSchema>

export const DiagnosticRowSchema = Schema.Struct({
  diagnosticRowId: Schema.String,
  launchId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  channel: Schema.Literal("stderr"),
  format: Schema.Literal("text-lines"),
  stream: Schema.Literal("diagnostics"),
  receivedAt: Schema.String,
  raw: Schema.String,
})
export type DiagnosticRow = Schema.Schema.Type<typeof DiagnosticRowSchema>
