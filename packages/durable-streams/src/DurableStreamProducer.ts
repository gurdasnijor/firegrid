import { IdempotentProducer } from "@durable-streams/client"
import type { Scope } from "effect"
import { Effect, Queue, Option, Schema } from "effect"
import { makeJsonDurableStream } from "./DurableStreamLog.ts"

export class DurableStreamProducerError extends Schema.TaggedError<DurableStreamProducerError>()(
  "DurableStreamProducerError",
  {
    op: Schema.String,
    producerId: Schema.String,
    transient: Schema.Boolean,
    cause: Schema.Unknown,
  },
) {}

export interface DurableStreamProducerOpenOptions {
  readonly streamUrl: string
  readonly producerId: string
  readonly contentType?: string
  readonly autoClaim?: boolean
  readonly lingerMs?: number
}

export interface DurableStreamProducerHandle {
  readonly append: (
    payload: string,
  ) => Effect.Effect<void, DurableStreamProducerError>
  readonly flush: Effect.Effect<void, DurableStreamProducerError>
}

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
): DurableStreamProducerError =>
  new DurableStreamProducerError({
    op,
    producerId,
    transient: isTransientProducerCause(cause),
    cause,
  })

export const openDurableStreamProducer = (
  options: DurableStreamProducerOpenOptions,
): Effect.Effect<DurableStreamProducerHandle, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const errorQueue = yield* Queue.unbounded<Error>()
      const stream = makeJsonDurableStream(
        options.streamUrl,
        options.contentType ?? "application/json",
      )
      const producer = new IdempotentProducer(
        stream,
        options.producerId,
        {
          autoClaim: options.autoClaim ?? true,
          lingerMs: options.lingerMs ?? 10,
          onError: error => {
            errorQueue.unsafeOffer(error)
          },
        },
      )

      const drainErrors = (
        op: string,
      ): Effect.Effect<void, DurableStreamProducerError> =>
        Queue.poll(errorQueue).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.void,
            onSome: cause =>
              Effect.fail(producerError(op, options.producerId, cause)),
          })),
        )

      return {
        producer,
        handle: {
          append: payload =>
            Effect.try({
              try: () => producer.append(payload),
              catch: cause =>
                producerError("producer.append", options.producerId, cause),
            }).pipe(Effect.zipRight(drainErrors("producer.append"))),
          flush: Effect.tryPromise({
            try: () => producer.flush(),
            catch: cause =>
              producerError("producer.flush", options.producerId, cause),
          }).pipe(Effect.zipRight(drainErrors("producer.flush"))),
        } satisfies DurableStreamProducerHandle,
      }
    }),
    ({ producer }) =>
      Effect.tryPromise({
        try: () => producer.detach(),
        catch: cause => producerError("producer.detach", options.producerId, cause),
      }).pipe(Effect.ignore),
  ).pipe(Effect.map(({ handle }) => handle))
