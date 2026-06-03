import { FetchHttpClient } from "@effect/platform"
import type { HttpClient } from "@effect/platform"
import { RpcServer } from "@effect/rpc"
import type { RpcMessage } from "@effect/rpc"
import { DurableStream } from "effect-durable-streams"
import { Effect, Layer, Mailbox, Schema, Stream } from "effect"

const durableStreamUrl = (
  baseUrl: string,
  streamName: string,
): string => `${baseUrl.replace(/\/+$/, "")}/v1/stream/${encodeURIComponent(streamName)}`

const messageSchema = Schema.Unknown

interface DurableMcpTransportSpec {
  readonly durableStreamsBaseUrl: string
  readonly namespace: string
  readonly transportId: string
}

const streamName = (
  spec: DurableMcpTransportSpec,
  direction: "client-to-server" | "server-to-client",
): string => `${spec.namespace}.tiny-firegrid.mcp-durable.${spec.transportId}.${direction}`

const streamFor = (
  spec: DurableMcpTransportSpec,
  direction: "client-to-server" | "server-to-client",
) =>
  DurableStream.define({
    endpoint: {
      url: durableStreamUrl(spec.durableStreamsBaseUrl, streamName(spec, direction)),
    },
    schema: messageSchema,
  })

const ensureStreams = (
  spec: DurableMcpTransportSpec,
) =>
  Effect.all([
    streamFor(spec, "client-to-server").create({ contentType: "application/json" }).pipe(
      Effect.ignore,
    ),
    streamFor(spec, "server-to-client").create({ contentType: "application/json" }).pipe(
      Effect.ignore,
    ),
  ]).pipe(
    Effect.withSpan("tiny_firegrid.mcp_durable.transport.ensure_streams", {
      attributes: {
        "firegrid.mcp_durable.transport_id": spec.transportId,
        "firegrid.mcp_durable.client_to_server_stream": streamName(spec, "client-to-server"),
        "firegrid.mcp_durable.server_to_client_stream": streamName(spec, "server-to-client"),
      },
    }),
  )

const provideFetch = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, HttpClient.HttpClient>> =>
  effect.pipe(Effect.provide(FetchHttpClient.layer))

export const layerProtocolDurableStreamsServer = (
  spec: DurableMcpTransportSpec,
): Layer.Layer<RpcServer.Protocol> =>
  Layer.scoped(
    RpcServer.Protocol,
    Effect.gen(function*() {
      yield* provideFetch(ensureStreams(spec)).pipe(Effect.orDie)
      const clientToServer = streamFor(spec, "client-to-server")
      const serverToClient = streamFor(spec, "server-to-client")
      const disconnects = yield* Mailbox.make<number>()

      return RpcServer.Protocol.of({
        run: (onRequest) =>
          provideFetch(clientToServer.read({ live: "long-poll" }).pipe(
            Stream.runForEach(message =>
              onRequest(1, message as RpcMessage.FromClientEncoded).pipe(
                Effect.withSpan("tiny_firegrid.mcp_durable.server.receive", {
                  attributes: {
                    "firegrid.mcp_durable.transport_id": spec.transportId,
                    "firegrid.mcp_durable.message_tag": (message as { readonly _tag?: string })._tag ?? "",
                  },
                }),
              )),
            Effect.forever,
            Effect.orDie,
          )),
        disconnects,
        send: (_clientId, response) =>
          provideFetch(serverToClient.append(response)).pipe(
            Effect.withSpan("tiny_firegrid.mcp_durable.server.send", {
              attributes: {
                "firegrid.mcp_durable.transport_id": spec.transportId,
                "firegrid.mcp_durable.message_tag": response._tag,
              },
            }),
            Effect.orDie,
          ),
        end: (clientId) => disconnects.offer(clientId).pipe(Effect.asVoid),
        clientIds: Effect.succeed(new Set([1])),
        initialMessage: Effect.succeedNone,
        supportsAck: false,
        supportsTransferables: false,
        supportsSpanPropagation: false,
      })
    }),
  )
