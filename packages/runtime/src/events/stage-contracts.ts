import { Schema } from "effect"

// firegrid-runtime-agent-event-pipeline.STAGES.8
export const RuntimeSubscriberIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("RuntimeSubscriberId"),
)
export type RuntimeSubscriberId = Schema.Schema.Type<typeof RuntimeSubscriberIdSchema>

// firegrid-runtime-agent-event-pipeline.STAGES.8
export const RuntimeAuthoritySourceNameSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("RuntimeAuthoritySourceName"),
)
export type RuntimeAuthoritySourceName = Schema.Schema.Type<typeof RuntimeAuthoritySourceNameSchema>

// firegrid-runtime-agent-event-pipeline.STAGES.8
export const RuntimeIdempotencyKeySchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("RuntimeIdempotencyKey"),
)
export type RuntimeIdempotencyKey = Schema.Schema.Type<typeof RuntimeIdempotencyKeySchema>
