import { Schema } from "effect"

export const LaunchTerminalStateSchema = Schema.Struct({
  launchId: Schema.String,
  status: Schema.Literal("completed", "failed"),
  activityAttempt: Schema.Number,
  exitCode: Schema.Number,
})
export type LaunchTerminalState = Schema.Schema.Type<typeof LaunchTerminalStateSchema>

export const ProcessAttemptResultSchema = Schema.Struct({
  activityAttempt: Schema.Number,
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})
export type ProcessAttemptResult = Schema.Schema.Type<typeof ProcessAttemptResultSchema>
