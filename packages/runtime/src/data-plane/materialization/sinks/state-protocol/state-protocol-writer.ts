import { IdempotentProducer } from "@durable-streams/client"
import { sessionStateSchema } from "@firegrid/protocol/session"
import type { Scope } from "effect"
import { Context, Effect, Layer, Option, Queue, Schema } from "effect"
import type { EventProjectorIdentity } from "../../event-pipeline.ts"
import { makeJsonDurableStream } from "../../../stream.ts"
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
  if (!(cause instanceof Error)) return false
  return /abort|connection|econn|fetch|network|timeout|timed out/i.test(
    `${cause.name} ${cause.message}`,
  )
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
      Effect.acquireRelease(
        Effect.gen(function* () {
          const errorQueue = yield* Queue.unbounded<Error>()
          const stream = makeJsonDurableStream(options.streamUrl)
          const producer = new IdempotentProducer(
            stream,
            options.writerId,
            {
              autoClaim: true,
              lingerMs: 10,
              onError: error => {
                errorQueue.unsafeOffer(error)
              },
            },
          )

          const drainErrors = (
            op: string,
          ): Effect.Effect<void, StateProtocolWriterError> =>
            Queue.poll(errorQueue).pipe(
              Effect.flatMap(Option.match({
                onNone: () => Effect.void,
                onSome: cause =>
                  Effect.fail(writerError(op, options.writerId, cause)),
              })),
            )

          return { producer, drainErrors }
        }),
        ({ producer }) =>
          Effect.tryPromise({
            try: () => producer.detach(),
            catch: cause =>
              writerError("state-protocol.detach", options.writerId, cause),
          }).pipe(Effect.ignore),
      ).pipe(
        Effect.map(({ producer, drainErrors }) => ({
          append: event =>
            Effect.try({
              try: () => producer.append(JSON.stringify(event)),
              catch: cause =>
                writerError("state-protocol.append", options.writerId, cause),
            }).pipe(Effect.zipRight(drainErrors("state-protocol.append"))),
          flush: Effect.tryPromise({
            try: () => producer.flush(),
            catch: cause =>
              writerError("state-protocol.flush", options.writerId, cause),
          }).pipe(Effect.zipRight(drainErrors("state-protocol.flush"))),
        })),
      ),
  }),
)

