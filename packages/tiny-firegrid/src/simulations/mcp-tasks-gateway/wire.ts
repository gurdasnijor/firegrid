import { FetchHttpClient } from "@effect/platform"
import { DurableStream } from "effect-durable-streams"
import { Effect, Option, Schema, Stream } from "effect"

export interface McpTasksWireOptions {
  readonly baseUrl: string
  readonly namespace: string
  readonly streamId: string
}

const streamUrl = (baseUrl: string, streamName: string) => {
  const trimmed = baseUrl.replace(/\/+$/, "")
  const separator = trimmed.includes("/v1/stream/") ? "/" : "/v1/stream/"
  return `${trimmed}${separator}${encodeURIComponent(streamName)}`
}

const wireStreamUrl = (options: McpTasksWireOptions, suffix: string) =>
  streamUrl(
    options.baseUrl,
    `${options.namespace}.tiny-firegrid.${options.streamId}.mcp-tasks.${suffix}`,
  )

const WireRpcMessageSchema = Schema.Struct({
  clientId: Schema.Number,
  message: Schema.Unknown,
}).annotations({
  identifier: "tiny-firegrid.mcpTasksGateway.wireRpcMessage",
})

export type WireRpcMessage = Schema.Schema.Type<typeof WireRpcMessageSchema>

const TaskEventSchema = Schema.Struct({
  taskId: Schema.String,
  status: Schema.Literal(
    "working",
    "input_required",
    "completed",
    "failed",
    "cancelled",
  ),
  statusMessage: Schema.optional(Schema.String),
  createdAt: Schema.String,
  lastUpdatedAt: Schema.String,
  ttl: Schema.Number,
  pollInterval: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  inputRequest: Schema.optional(Schema.Unknown),
}).annotations({
  identifier: "tiny-firegrid.mcpTasksGateway.taskEvent",
})

export type TaskEvent = Schema.Schema.Type<typeof TaskEventSchema>

const stream = <A, I>(
  options: McpTasksWireOptions,
  suffix: string,
  schema: Schema.Schema<A, I>,
) =>
  DurableStream.define({
    endpoint: {
      url: streamUrl(
        options.baseUrl,
        `${options.namespace}.tiny-firegrid.${options.streamId}.mcp-tasks.${suffix}`,
      ),
    },
    schema,
  })

const requestStream = (options: McpTasksWireOptions) =>
  stream(options, "requests", WireRpcMessageSchema)

export const responseStream = (options: McpTasksWireOptions) =>
  stream(options, "responses", WireRpcMessageSchema)

const taskEventStream = (options: McpTasksWireOptions) =>
  stream(options, "task-events", TaskEventSchema)

export const createWireStreams = (
  options: McpTasksWireOptions,
): Effect.Effect<void, unknown> =>
  Effect.all([
    requestStream(options).create().pipe(Effect.catchAll(() => Effect.void)),
    responseStream(options).create().pipe(Effect.catchAll(() => Effect.void)),
    taskEventStream(options).create().pipe(Effect.catchAll(() => Effect.void)),
  ], { discard: true }).pipe(Effect.provide(FetchHttpClient.layer))

export const appendTaskEvent = (
  options: McpTasksWireOptions,
  event: TaskEvent,
): Effect.Effect<void, unknown> =>
  taskEventStream(options).append(event).pipe(
    Effect.asVoid,
    Effect.provide(FetchHttpClient.layer),
  )

export const taskEvents = (
  options: McpTasksWireOptions,
): Stream.Stream<TaskEvent, unknown> =>
  taskEventStream(options).read({ live: true }).pipe(
    Stream.provideLayer(FetchHttpClient.layer),
  )

const readWireBatch = (
  options: McpTasksWireOptions,
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
  options: McpTasksWireOptions,
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
