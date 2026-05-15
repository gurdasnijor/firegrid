import { Schema, type Effect, type Sink, type Stream } from "effect"
import type { SourceCollectionHandle } from "../waits/index.ts"

// firegrid-runtime-agent-event-pipeline.STAGES.7
export type RuntimeTransform<Input, Output, Error = never, Requirements = never> = (
  input: Stream.Stream<Input, Error, Requirements>,
) => Stream.Stream<Output, Error, Requirements>

// firegrid-runtime-agent-event-pipeline.STAGES.7
export type RuntimeAuthorityCommand<Input, Output, Error = never, Requirements = never> = (
  input: Input,
) => Effect.Effect<Output, Error, Requirements>

// firegrid-runtime-agent-event-pipeline.AUTHORITIES.10
// firegrid-runtime-agent-event-pipeline.AUTHORITIES.11
export interface RuntimeAuthority<Write, Read> {
  readonly write: Write
  readonly read: Read
}

// firegrid-runtime-agent-event-pipeline.AUTHORITIES.10
export type RuntimeAuthoritySink<Input, Output, Error = never, Requirements = never> =
  Sink.Sink<Output, Input, never, Error, Requirements>

// firegrid-runtime-agent-event-pipeline.AUTHORITIES.10
// firegrid-runtime-agent-event-pipeline.AUTHORITIES.11
export type RuntimeAuthorityRead = SourceCollectionHandle

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

export const runtimeSubscriberId = (value: string): RuntimeSubscriberId =>
  Schema.decodeUnknownSync(RuntimeSubscriberIdSchema)(value)

export const runtimeAuthoritySourceName = (value: string): RuntimeAuthoritySourceName =>
  Schema.decodeUnknownSync(RuntimeAuthoritySourceNameSchema)(value)

export const runtimeIdempotencyKey = (value: string): RuntimeIdempotencyKey =>
  Schema.decodeUnknownSync(RuntimeIdempotencyKeySchema)(value)
