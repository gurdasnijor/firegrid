import {
  DurableStream,
  FetchError,
  stream as readStream,
} from "@durable-streams/client"
import { Effect, Schema } from "effect"

export class DurableStreamLogError extends Schema.TaggedError<DurableStreamLogError>()(
  "DurableStreamLogError",
  {
    op: Schema.String,
    streamUrl: Schema.optional(Schema.String),
    cause: Schema.Unknown,
  },
) {}

export interface CreateJsonDurableStreamOptions {
  readonly streamUrl: string
  readonly contentType?: string
}

export interface ReadRetainedJsonOptions {
  readonly streamUrl: string
  readonly offset?: string
}

export interface AppendJsonOptions {
  readonly streamUrl: string
  readonly event: unknown
  readonly contentType?: string
}

export interface EnsureJsonDurableStreamOptions {
  readonly streamUrl: string
  readonly contentType?: string
}

export const makeJsonDurableStream = (
  streamUrl: string,
  contentType = "application/json",
): DurableStream =>
  new DurableStream({
    url: streamUrl,
    contentType,
  })

const asError = (
  cause: unknown,
): Error =>
  cause instanceof Error ? cause : new Error(String(cause))

export const createJsonDurableStream = (
  options: CreateJsonDurableStreamOptions,
): Effect.Effect<void, DurableStreamLogError> =>
  Effect.tryPromise({
    try: async () => {
      await DurableStream.create({
        url: options.streamUrl,
        contentType: options.contentType ?? "application/json",
      })
    },
    catch: cause =>
      new DurableStreamLogError({
        op: "createJsonDurableStream",
        streamUrl: options.streamUrl,
        cause,
      }),
  })

export const ensureJsonDurableStream = (
  options: EnsureJsonDurableStreamOptions,
): Effect.Effect<void, DurableStreamLogError> =>
  Effect.tryPromise({
    try: async () => {
      await DurableStream.head({ url: options.streamUrl }).catch((cause: unknown) => {
        if (cause instanceof FetchError && cause.status === 404) {
          return DurableStream.create({
            url: options.streamUrl,
            contentType: options.contentType ?? "application/json",
          })
        }
        return Promise.reject(asError(cause))
      })
    },
    catch: cause =>
      new DurableStreamLogError({
        op: "ensureJsonDurableStream",
        streamUrl: options.streamUrl,
        cause,
      }),
  })

export const appendJson = (
  options: AppendJsonOptions,
): Effect.Effect<void, DurableStreamLogError> =>
  Effect.tryPromise({
    try: async () => {
      const stream = makeJsonDurableStream(
        options.streamUrl,
        options.contentType ?? "application/json",
      )
      await stream.append(JSON.stringify(options.event))
    },
    catch: cause =>
      new DurableStreamLogError({
        op: "appendJson",
        streamUrl: options.streamUrl,
        cause,
      }),
  })

export const readRetainedJson = <A = unknown>(
  options: ReadRetainedJsonOptions,
): Effect.Effect<ReadonlyArray<A>, DurableStreamLogError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await readStream<A>({
        url: options.streamUrl,
        offset: options.offset ?? "-1",
        live: false,
        json: true,
      })
      return await response.json()
    },
    catch: cause =>
      new DurableStreamLogError({
        op: "readRetainedJson",
        streamUrl: options.streamUrl,
        cause,
      }),
  })
