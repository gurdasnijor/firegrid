import { Schema } from "effect"

export const RuntimeOutputSourceSchema = Schema.Literal("stdout", "stderr")
export type RuntimeOutputSource = Schema.Schema.Type<typeof RuntimeOutputSourceSchema>

export const RuntimeJournalTargetSchema = Schema.Literal("events", "logs")
export type RuntimeJournalTarget = Schema.Schema.Type<typeof RuntimeJournalTargetSchema>

export const RuntimeJournalFormatSchema = Schema.Literal("jsonl", "text-lines")
export type RuntimeJournalFormat = Schema.Schema.Type<typeof RuntimeJournalFormatSchema>

export const RuntimeProviderSchema = Schema.Literal("local-process")
export type RuntimeProvider = Schema.Schema.Type<typeof RuntimeProviderSchema>

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
//
// Only the binding (name + ref) is durably persisted. The ref names a host
// env var; the resolver reads the value at spawn time and merges it into
// SandboxCommand.envVars. The durable plane never sees the value.
export const RuntimeEnvBindingSchema = Schema.Struct({
  name: Schema.String,
  ref: Schema.String,
})
export type RuntimeEnvBinding = Schema.Schema.Type<typeof RuntimeEnvBindingSchema>

export const RuntimeConfigSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  envBindings: Schema.optional(Schema.Array(RuntimeEnvBindingSchema)),
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

const normalizeRuntimeConfig = (config: RuntimeConfig): RuntimeConfig => ({
  argv: [...config.argv],
  ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
  ...(config.envBindings === undefined ? {} : {
    envBindings: config.envBindings.map(binding => ({
      name: binding.name,
      ref: binding.ref,
    })),
  }),
})

export const localJsonlJournal = [
  { source: "stdout", format: "jsonl", target: "events" },
  { source: "stderr", format: "text-lines", target: "logs" },
] satisfies ReadonlyArray<RuntimeJournalRule>

export const normalizeRuntimeIntent = (
  runtime: PublicLaunchRuntimeIntent,
): RuntimeContextIntent => ({
  provider: runtime.provider,
  config: normalizeRuntimeConfig(runtime.config),
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.8
  journal: [...localJsonlJournal],
})

export const local = {
  jsonl: (config: RuntimeConfig): PublicLaunchRuntimeIntent => ({
    provider: "local-process",
    config: normalizeRuntimeConfig(config),
  }),
}

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
//
// Helper to construct an env binding with the env: ref shape. v1 supports
// only "env:VAR"; future ref shapes (vault, k8s secret, etc.) get their own
// constructors here.
export const envBinding = (
  name: string,
  envVarName: string = name,
): RuntimeEnvBinding => ({
  name,
  ref: `env:${envVarName}`,
})

export const RuntimeContextSchema = Schema.Struct({
  contextId: Schema.String,
  createdAt: Schema.String,
  createdBy: Schema.optional(Schema.String),
  runtime: RuntimeContextIntentSchema,
})
export type RuntimeContext = Schema.Schema.Type<typeof RuntimeContextSchema>

export const RuntimeRunEventKeySchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  status: Schema.Literal("started", "exited", "failed"),
})
export type RuntimeRunEventKey = Schema.Schema.Type<typeof RuntimeRunEventKeySchema>

export const runtimeRunEventFields = {
  runEventId: RuntimeRunEventKeySchema,
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  status: Schema.Literal("started", "exited", "failed"),
  at: Schema.String,
  provider: RuntimeProviderSchema,
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
} as const
export const RuntimeRunEventSchema = Schema.Struct(runtimeRunEventFields)
export type RuntimeRunEvent = Schema.Schema.Type<typeof RuntimeRunEventSchema>

export const RuntimeOutputEventKeySchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  target: Schema.Literal("events"),
  sequence: Schema.Number,
})
export type RuntimeOutputEventKey = Schema.Schema.Type<typeof RuntimeOutputEventKeySchema>

export const runtimeEventFields = {
  eventId: RuntimeOutputEventKeySchema,
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  source: Schema.Literal("stdout"),
  format: Schema.Literal("jsonl"),
  receivedAt: Schema.String,
  raw: Schema.String,
} as const
export const RuntimeEventSchema = Schema.Struct(runtimeEventFields)
export type RuntimeEvent = Schema.Schema.Type<typeof RuntimeEventSchema>

export const RuntimeOutputLogLineKeySchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  target: Schema.Literal("logs"),
  sequence: Schema.Number,
})
export type RuntimeOutputLogLineKey = Schema.Schema.Type<typeof RuntimeOutputLogLineKeySchema>

export const runtimeLogLineFields = {
  logLineId: RuntimeOutputLogLineKeySchema,
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  source: Schema.Literal("stderr"),
  format: Schema.Literal("text-lines"),
  receivedAt: Schema.String,
  raw: Schema.String,
} as const
export const RuntimeLogLineSchema = Schema.Struct(runtimeLogLineFields)
export type RuntimeLogLine = Schema.Schema.Type<typeof RuntimeLogLineSchema>
