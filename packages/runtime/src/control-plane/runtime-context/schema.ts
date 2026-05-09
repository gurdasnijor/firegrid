import { Schema } from "effect"

export const RuntimeContextTerminalStateSchema = Schema.Struct({
  contextId: Schema.String,
  status: Schema.Literal("completed", "failed"),
  activityAttempt: Schema.Number,
  exitCode: Schema.Number,
})

export const ProcessAttemptResultSchema = Schema.Struct({
  activityAttempt: Schema.Number,
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})
