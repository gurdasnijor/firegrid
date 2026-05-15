import type { Effect } from "effect"
import { Context, Schema } from "effect"

export const RuntimeStartOptionsSchema = Schema.Struct({
  contextId: Schema.String,
})
export type RuntimeStartOptions = Schema.Schema.Type<typeof RuntimeStartOptionsSchema>

export const RuntimeStartResultSchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  exitCode: Schema.Number,
  signal: Schema.optional(Schema.String),
})
export type RuntimeStartResult = Schema.Schema.Type<typeof RuntimeStartResultSchema>

export interface RuntimeStartCapabilityService {
  readonly start: (
    options: RuntimeStartOptions,
  ) => Effect.Effect<RuntimeStartResult, unknown>
}

export class RuntimeStartCapability extends Context.Tag(
  "@firegrid/protocol/RuntimeStartCapability",
)<RuntimeStartCapability, RuntimeStartCapabilityService>() {}
