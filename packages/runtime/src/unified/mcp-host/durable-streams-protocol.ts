import { FetchHttpClient } from "@effect/platform"
import { RpcServer } from "@effect/rpc"
import type * as RpcMessage from "@effect/rpc/RpcMessage"
import { Data, Effect, Layer, Mailbox, Option, Schema, Stream } from "effect"

export interface FiregridMcpDurableStreamsWireOptions {
  readonly baseUrl: string
  readonly namespace: string
  readonly streamId: string
}

export const firegridMcpDurableStreamName = (
  options: FiregridMcpDurableStreamsWireOptions,
  suffix: "requests" | "responses",
): string =>
  `${options.namespace}.firegrid.mcp.${options.streamId}.${suffix}`

const streamUrl = (baseUrl: string, streamName: string) => {
  const trimmed = baseUrl.replace(/\/+$/, "")
  const separator = trimmed.includes("/v1/stream/") ? "/" : "/v1/stream/"
  return `${trimmed}${separator}${encodeURIComponent(streamName)}`
}

export const firegridMcpDurableStreamUrl = (
  options: FiregridMcpDurableStreamsWireOptions,
  suffix: "requests" | "responses",
): string =>
  streamUrl(options.baseUrl, firegridMcpDurableStreamName(options, suffix))

export const WireRpcMessageSchema = Schema.Struct({
  clientId: Schema.Number,
  message: Schema.Unknown,
}).annotations({
  identifier: "firegrid.mcp.durableStreams.wireRpcMessage",
})

export type WireRpcMessage = Schema.Schema.Type<typeof WireRpcMessageSchema>

class McpDurableStreamsProtocolError extends Data.TaggedError(
  "McpDurableStreamsProtocolError",
)<{
  readonly message: string
}> {}

const protocolError = (cause: unknown): McpDurableStreamsProtocolError =>
  new McpDurableStreamsProtocolError({ message: String(cause) })

const createWireStream = (
  options: FiregridMcpDurableStreamsWireOptions,
  suffix: "requests" | "responses",
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: signal =>
      globalThis.fetch(firegridMcpDurableStreamUrl(options, suffix), {
        method: "PUT",
        headers: { "content-type": "application/json", connection: "close" },
        signal,
      }).then(async response => {
        await response.arrayBuffer()
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`create ${suffix} failed with status ${response.status}`)
        }
      }),
    catch: protocolError,
  })

export const createFiregridMcpDurableStreams = (
  options: FiregridMcpDurableStreamsWireOptions,
): Effect.Effect<void, unknown> =>
  Effect.all([
    createWireStream(options, "requests").pipe(Effect.catchAll(() => Effect.void)),
    createWireStream(options, "responses").pipe(Effect.catchAll(() => Effect.void)),
  ], { discard: true }).pipe(Effect.provide(FetchHttpClient.layer))

interface StreamReadResult {
  readonly items: ReadonlyArray<unknown>
  readonly nextOffset: string
}

const readWireBatch = (
  options: FiregridMcpDurableStreamsWireOptions,
  suffix: "requests" | "responses",
  offset: string,
): Effect.Effect<StreamReadResult, unknown> =>
  Effect.tryPromise({
    try: async signal => {
      const url = new URL(firegridMcpDurableStreamUrl(options, suffix))
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
    catch: protocolError,
  })

export const readFiregridMcpDurableRequests = (
  options: FiregridMcpDurableStreamsWireOptions,
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

export const appendFiregridMcpDurableResponse = (
  options: FiregridMcpDurableStreamsWireOptions,
  response: WireRpcMessage,
): Effect.Effect<void, unknown> =>
  Effect.tryPromise({
    try: async signal => {
      const result = await globalThis.fetch(firegridMcpDurableStreamUrl(options, "responses"), {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
        body: JSON.stringify(response),
        signal,
      })
      await result.arrayBuffer()
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`append response failed with status ${result.status}`)
      }
    },
    catch: protocolError,
  }).pipe(Effect.provide(FetchHttpClient.layer))

export interface DurableStreamsProtocolRequestHandlerInput {
  readonly clientId: number
  readonly message: RpcMessage.FromClientEncoded
  readonly writeRequest: (
    clientId: number,
    message: RpcMessage.FromClientEncoded,
  ) => Effect.Effect<void, unknown>
  readonly sendToClient: (
    clientId: number,
    message: RpcMessage.FromServerEncoded,
  ) => Effect.Effect<void, never>
}

export interface DurableStreamsProtocolResponseHandlerInput {
  readonly clientId: number
  readonly response: RpcMessage.FromServerEncoded
  readonly sendToClient: (
    clientId: number,
    message: RpcMessage.FromServerEncoded,
  ) => Effect.Effect<void, never>
}

export interface DurableStreamsProtocolHandlers {
  readonly onRequest: (
    input: DurableStreamsProtocolRequestHandlerInput,
  ) => Effect.Effect<void, unknown>
  readonly onResponse?: (
    input: DurableStreamsProtocolResponseHandlerInput,
  ) => Effect.Effect<void, never>
}

export const makeDurableStreamsProtocol = (
  options: FiregridMcpDurableStreamsWireOptions,
  handlers: DurableStreamsProtocolHandlers,
) =>
  Effect.gen(function*() {
    yield* createFiregridMcpDurableStreams(options)
    const clientIds = new Set<number>([1])
    const disconnects = yield* Mailbox.make<number>()

    return yield* RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function*() {
        const sendToClient = (clientId: number, response: RpcMessage.FromServerEncoded) =>
          appendFiregridMcpDurableResponse(options, { clientId, message: response }).pipe(
            Effect.orDie,
          )
        const handleRequest = (event: WireRpcMessage) =>
          handlers.onRequest({
            clientId: event.clientId,
            message: event.message as RpcMessage.FromClientEncoded,
            writeRequest,
            sendToClient,
          }).pipe(
            Effect.catchAllCause(cause =>
              Effect.logError(`mcp durable-streams request failed: ${cause.toString()}`)),
          )

        yield* readFiregridMcpDurableRequests(options).pipe(
          Stream.runForEach(handleRequest),
          Effect.forkScoped,
        )

        return {
          disconnects,
          send: (clientId: number, response: RpcMessage.FromServerEncoded) =>
            handlers.onResponse === undefined
              ? sendToClient(clientId, response)
              : handlers.onResponse({ clientId, response, sendToClient }),
          end: (_clientId: number) => Effect.void,
          clientIds: Effect.succeed(clientIds),
          initialMessage: Effect.succeed(Option.none()),
          supportsAck: false,
          supportsTransferables: false,
          supportsSpanPropagation: false,
        }
      }))
  })

export const layerProtocolDurableStreams = (
  options: FiregridMcpDurableStreamsWireOptions,
): Layer.Layer<RpcServer.Protocol> =>
  Layer.scoped(
    RpcServer.Protocol,
    makeDurableStreamsProtocol(options, {
      onRequest: ({ clientId, message, writeRequest }) =>
        writeRequest(clientId, message),
    }).pipe(Effect.orDie),
  )
