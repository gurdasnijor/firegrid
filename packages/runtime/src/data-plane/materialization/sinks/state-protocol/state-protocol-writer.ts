import {
  openDurableStreamProducer,
  DurableStreamProducerError,
  sessionStateSchema,
} from "@firegrid/durable-streams"
import type { Scope } from "effect"
import { Context, Effect, Layer, Schema } from "effect"
import type { EventProjectorIdentity } from "../../event-pipeline.ts"
import type { SessionStateChange } from "./session-state-change.ts"

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
  if (cause instanceof DurableStreamProducerError) return cause.transient
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

export const toSessionStateEvent = (
  change: SessionStateChange,
  projector: EventProjectorIdentity,
): unknown => {
  // durable-records-and-projections.PROJECTIONS.3
  switch (change.kind) {
    case "upsertSession":
      return sessionStateSchema.sessions.upsert({
        value: change.value,
        headers: {
          txid: `${projector.name}:${projector.version}:session:${change.value.sessionId}`,
        },
      })
    case "upsertMessage":
      return sessionStateSchema.messages.upsert({
        value: change.value,
        headers: {
          txid: `${projector.name}:${projector.version}:message:${change.value.messageId}`,
        },
      })
  }
}

export const StateProtocolWriterLive = Layer.succeed(
  StateProtocolWriter,
  StateProtocolWriter.of({
    open: options =>
      openDurableStreamProducer({
        streamUrl: options.streamUrl,
        producerId: options.writerId,
      }).pipe(
        Effect.map(producer => {
          const mapDurableProducerError = (
            op: string,
          ) =>
            Effect.mapError((cause: DurableStreamProducerError) =>
              writerError(op, options.writerId, cause))
          return {
            append: event =>
              producer.append(JSON.stringify(event)).pipe(
                mapDurableProducerError("state-protocol.append"),
              ),
            flush: producer.flush.pipe(mapDurableProducerError("state-protocol.flush")),
          }
        }),
      ),
  }),
)
