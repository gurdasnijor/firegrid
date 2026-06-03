import { FetchHttpClient } from "@effect/platform"
import { DurableStream } from "effect-durable-streams"
import { Effect, Option, Schema, Stream } from "effect"

export interface McpTaskProjectionWireOptions {
  readonly baseUrl: string
  readonly namespace: string
  readonly streamId: string
}

const streamUrl = (baseUrl: string, streamName: string) => {
  const trimmed = baseUrl.replace(/\/+$/, "")
  const separator = trimmed.includes("/v1/stream/") ? "/" : "/v1/stream/"
  return `${trimmed}${separator}${encodeURIComponent(streamName)}`
}

const wireStreamUrl = (options: McpTaskProjectionWireOptions, suffix: string) =>
  streamUrl(
    options.baseUrl,
    `${options.namespace}.tiny-firegrid.${options.streamId}.mcp-task-projection.${suffix}`,
  )

const WireRpcMessageSchema = Schema.Struct({
  clientId: Schema.Number,
  message: Schema.Unknown,
}).annotations({
  identifier: "tiny-firegrid.mcpTaskProjection.wireRpcMessage",
})

export type WireRpcMessage = Schema.Schema.Type<typeof WireRpcMessageSchema>

const stream = <A, I>(
  options: McpTaskProjectionWireOptions,
  suffix: string,
  schema: Schema.Schema<A, I>,
) =>
  DurableStream.define({
    endpoint: {
      url: wireStreamUrl(options, suffix),
    },
    schema,
  })

const requestStream = (options: McpTaskProjectionWireOptions) =>
  stream(options, "requests", WireRpcMessageSchema)

export const responseStream = (options: McpTaskProjectionWireOptions) =>
  stream(options, "responses", WireRpcMessageSchema)

export const createWireStreams = (
  options: McpTaskProjectionWireOptions,
): Effect.Effect<void, unknown> =>
  Effect.all([
    requestStream(options).create().pipe(Effect.catchAll(() => Effect.void)),
    responseStream(options).create().pipe(Effect.catchAll(() => Effect.void)),
  ], { discard: true }).pipe(Effect.provide(FetchHttpClient.layer))

const readWireBatch = (
  options: McpTaskProjectionWireOptions,
  suffix: string,
  offset: string,
): Effect.Effect<{
  readonly items: ReadonlyArray<unknown>
  readonly nextOffset: string
}, unknown> =>
  Effect.tryPromise({
    try: async signal => {
      const url = new URL(wireStreamUrl(options, suffix))
      url.searchParams.set("offset", offset)
      url.searchParams.set("live", "long-poll")
      const response = await globalThis.fetch(url, {
        headers: { connection: "close" },
        signal,
      })
      if (response.status !== 200 && response.status !== 204) {
        throw new Error(`read ${suffix} failed with status ${response.status}`)
      }
      const nextOffset = response.headers.get("stream-next-offset") ?? offset
      if (response.status === 204) return { items: [], nextOffset }
      const body = await response.text()
      const parsed: unknown = body.trim() === "" ? [] : JSON.parse(body)
      return { items: Array.isArray(parsed) ? parsed : [parsed], nextOffset }
    },
    catch: cause => cause,
  })

export const readRequestMessages = (
  options: McpTaskProjectionWireOptions,
): Stream.Stream<WireRpcMessage, unknown> =>
  Stream.unfoldEffect("-1", offset =>
    readWireBatch(options, "requests", offset).pipe(
      Effect.map(result => Option.some([result.items, result.nextOffset] as const)),
    )).pipe(
      Stream.flatMap(items => Stream.fromIterable(items)),
      Stream.filter((event): event is WireRpcMessage =>
        typeof event === "object" &&
        event !== null &&
        "clientId" in event &&
        typeof event.clientId === "number" &&
        "message" in event),
    )
