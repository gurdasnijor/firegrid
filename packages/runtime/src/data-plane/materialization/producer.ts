import { IdempotentProducer } from "@durable-streams/client"
import { sessionStateSchema } from "@firegrid/protocol/session"
import type { Scope } from "effect"
import { Context, Effect, Layer, Option, Queue, Schema } from "effect"
import type {
  MaterializerChange,
  RuntimeOutputMaterializer,
} from "./types.ts"
import { makeJsonDurableStream } from "../stream.ts"

export class ProducerError extends Schema.TaggedError<ProducerError>()(
  "ProducerError",
  {
    op: Schema.String,
    producerId: Schema.optional(Schema.String),
    transient: Schema.Boolean,
    cause: Schema.Unknown,
  },
) {}

const isTransientProducerCause = (
  cause: unknown,
): boolean => {
  if (!(cause instanceof Error)) return false
  return /abort|connection|econn|fetch|network|timeout|timed out/i.test(
    `${cause.name} ${cause.message}`,
  )
}

const producerError = (
  op: string,
  producerId: string,
  cause: unknown,
): ProducerError =>
  new ProducerError({
    op,
    producerId,
    transient: isTransientProducerCause(cause),
    cause,
  })

export interface StateProtocolProducerHandle {
  /**
   * Queues an event into the IdempotentProducer buffer. Resolving means the
   * event was accepted locally; server-side failures may surface on a later
   * append or flush.
   */
  readonly append: (event: unknown) => Effect.Effect<void, ProducerError>
  /**
   * Drains the producer buffer and waits for server acknowledgement of all
   * preceding append calls.
   */
  readonly flush: Effect.Effect<void, ProducerError>
}

export interface StateProtocolProducerOpenOptions {
  readonly streamUrl: string
  readonly producerId: string
}

export class StateProtocolProducer extends Context.Tag("firegrid/StateProtocolProducer")<
  StateProtocolProducer,
  {
    readonly open: (
      options: StateProtocolProducerOpenOptions,
    ) => Effect.Effect<StateProtocolProducerHandle, ProducerError, Scope.Scope>
  }
>() {}

export const producerIdFor = (
  materializer: RuntimeOutputMaterializer,
  contextId: string,
): string =>
  `session-materializer:${materializer.name}:${materializer.version}:${contextId}`

/**
 * Builds a State Protocol upsert with a deterministic txid scoped to
 * (materializer.name, materializer.version, change.kind, primaryKey).
 *
 * Re-running the same materializer version produces the same txids and row
 * primary keys; changing versions produces fresh wire events for migration
 * while converging on the same materialized collections.
 */
export const toSessionStateEvent = (
  change: MaterializerChange,
  materializer: RuntimeOutputMaterializer,
): unknown => {
  // durable-records-and-projections.PROJECTIONS.3
  // Include the materializer version so a future fold change has a distinct
  // deterministic txid policy while retained re-runs of the same version remain
  // logically idempotent.
  switch (change.kind) {
    case "upsertSession":
      return sessionStateSchema.sessions.upsert({
        value: change.value,
        headers: {
          txid: `${materializer.name}:${materializer.version}:session:${change.value.sessionId}`,
        },
      })
    case "upsertMessage":
      return sessionStateSchema.messages.upsert({
        value: change.value,
        headers: {
          txid: `${materializer.name}:${materializer.version}:message:${change.value.messageId}`,
        },
      })
  }
}

export const StateProtocolProducerLive = Layer.succeed(
  StateProtocolProducer,
  StateProtocolProducer.of({
    open: options =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const errorQueue = yield* Queue.unbounded<Error>()
          const stream = makeJsonDurableStream(options.streamUrl)
          const producer = new IdempotentProducer(
            stream,
            options.producerId,
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
          ): Effect.Effect<void, ProducerError> =>
            Queue.poll(errorQueue).pipe(
              Effect.flatMap(Option.match({
                onNone: () => Effect.void,
                onSome: cause =>
                  Effect.fail(producerError(op, options.producerId, cause)),
              })),
            )

          return { producer, drainErrors }
        }),
        ({ producer }) =>
          Effect.tryPromise({
            try: () => producer.detach(),
            catch: cause =>
              producerError("state-protocol.detach", options.producerId, cause),
          }).pipe(Effect.ignore),
      ).pipe(
        Effect.map(({ producer, drainErrors }) => ({
          append: event =>
            Effect.try({
              try: () => producer.append(JSON.stringify(event)),
              catch: cause =>
                producerError("state-protocol.append", options.producerId, cause),
            }).pipe(Effect.zipRight(drainErrors("state-protocol.append"))),
          flush: Effect.tryPromise({
            try: () => producer.flush(),
            catch: cause =>
              producerError("state-protocol.flush", options.producerId, cause),
          }).pipe(Effect.zipRight(drainErrors("state-protocol.flush"))),
        })),
      ),
  }),
)
