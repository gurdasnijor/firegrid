import { FetchHttpClient } from "@effect/platform"
import type { Scope } from "effect"
import { Context, Effect, Layer, Schema } from "effect"
import { DurableStream } from "effect-durable-streams"
import type { EventProjectorIdentity } from "../../event-pipeline.ts"

export class StateProtocolWriterError extends Schema.TaggedError<StateProtocolWriterError>()(
  "StateProtocolWriterError",
  {
    op: Schema.String,
    writerId: Schema.optional(Schema.String),
    transient: Schema.Boolean,
    cause: Schema.Unknown,
  },
) {}

const isTransientWriterCause = (
  cause: unknown,
): boolean => {
  if (cause instanceof DurableStream.TransportError) return true
  return false
}

const writerError = (
  op: string,
  writerId: string,
  cause: unknown,
): StateProtocolWriterError =>
  new StateProtocolWriterError({
    op,
    writerId,
    transient: isTransientWriterCause(cause),
    cause,
  })

export interface StateProtocolWriterHandle {
  readonly append: (event: unknown) => Effect.Effect<void, StateProtocolWriterError>
  readonly flush: Effect.Effect<void, StateProtocolWriterError>
}

export interface StateProtocolWriterOpenOptions {
  readonly streamUrl: string
  readonly writerId: string
}

export class StateProtocolWriter extends Context.Tag("firegrid/StateProtocolWriter")<
  StateProtocolWriter,
  {
    readonly open: (
      options: StateProtocolWriterOpenOptions,
    ) => Effect.Effect<StateProtocolWriterHandle, StateProtocolWriterError, Scope.Scope>
  }
>() {}

export const writerIdFor = (
  projector: EventProjectorIdentity,
  contextId: string,
): string =>
  `session-projection:${projector.name}:${projector.version}:${contextId}`

export const StateProtocolWriterLive = Layer.succeed(
  StateProtocolWriter,
  StateProtocolWriter.of({
    open: options =>
      // effect-native-production-cutover.MATERIALIZATION.2
      DurableStream.define({
        endpoint: { url: options.streamUrl },
        schema: Schema.Unknown,
      }).producer({
        producerId: options.writerId,
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError(cause =>
          writerError("state-protocol.open", options.writerId, cause)),
        Effect.map(producer => {
          const mapDurableProducerError = (
            op: string,
          ) =>
            Effect.mapError((cause: DurableStream.ProducerFailure) =>
              writerError(op, options.writerId, cause))
          return {
            append: event =>
              producer.append(event).pipe(
                mapDurableProducerError("state-protocol.append"),
              ),
            flush: producer.flush.pipe(mapDurableProducerError("state-protocol.flush")),
          }
        }),
      ),
  }),
)
