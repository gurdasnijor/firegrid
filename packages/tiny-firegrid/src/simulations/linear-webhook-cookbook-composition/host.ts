/* eslint-disable local/no-module-durable-cache -- simulation-local route URL handoff; durable state lives in VerifiedWebhookFactTable. */
import type { ServeError } from "@effect/platform/HttpServerError"
import { makeIngressChannel } from "@firegrid/protocol/channels"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { RuntimeContextChannelRouterLive } from "@firegrid/runtime/channels/router/live"
import { VerifiedWebhookFactCallerOwnedFactStreamsLive } from "@firegrid/runtime/channels/verified-webhook/live"
import { type FiregridHost, FiregridLocalHostLive } from "@firegrid/runtime/composition/host-live"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
} from "@firegrid/runtime/producers/codecs/mcp"
import {
  VerifiedWebhookFactChannel,
  VerifiedWebhookFactChannelTarget,
} from "@firegrid/protocol/channels"
import {
  LinearWebhookFactSchema,
  type LinearWebhookFact,
} from "@firegrid/protocol/verified-webhook"
import {
  ingestVerifiedWebhook,
  type VerifiedWebhookIngestError,
  VerifiedWebhookFactTable,
  verifiedWebhookFactTableLayerOptions,
} from "@firegrid/runtime/verified-webhook-ingest"
import { Effect, Layer, Schema, Stream } from "effect"
import type {
  DurableTableError,
} from "effect-durable-operators"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const linearWebhookSource = "linear-demo"
export const linearWebhookCookbookSecret = "linear-webhook-cookbook-secret"
const linearWebhookPath = "/webhooks/linear"
const encoder = new TextEncoder()

let resolveLinearWebhookRoute: (url: string) => void = () => {}
export const linearWebhookCookbookRouteUrl = new Promise<string>((resolve) => {
  resolveLinearWebhookRoute = resolve
})

const readRawBody = (
  request: IncomingMessage,
): Effect.Effect<Uint8Array, Error> =>
  Effect.async<Uint8Array, Error>((resume) => {
    const chunks: Array<Uint8Array> = []
    request.on("data", (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
    })
    request.on("end", () => {
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      const body = new Uint8Array(size)
      let offset = 0
      chunks.forEach((chunk) => {
        body.set(chunk, offset)
        offset += chunk.byteLength
      })
      resume(Effect.succeed(body))
    })
    request.on("error", error => resume(Effect.fail(error)))
  })

const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): Effect.Effect<void> =>
  Effect.sync(() => {
    response.statusCode = statusCode
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(payload))
  })

const handleLinearWebhook = (
  request: IncomingMessage,
  response: ServerResponse,
): Effect.Effect<void, never, VerifiedWebhookFactTable> =>
  Effect.gen(function*() {
    if (request.method !== "POST" || request.url?.split("?")[0] !== linearWebhookPath) {
      return yield* sendJson(response, 404, { error: "not found" })
    }
    const rawBody = yield* readRawBody(request)
    const result = yield* ingestVerifiedWebhook({
      source: linearWebhookSource,
      headers: request.headers,
      rawBody,
      receivedAt: "2026-05-20T00:00:00.100Z",
      config: {
        secret: linearWebhookCookbookSecret,
        signatureHeaderName: "x-linear-signature",
        selectedHeaderNames: [
          "linear-delivery",
          "x-linear-signature",
          "authorization",
        ],
      },
    })
    return yield* sendJson(response, 202, result)
  }).pipe(
    Effect.catchAll((error: Error | VerifiedWebhookIngestError) =>
      sendJson(response, 400, {
        error: error.message,
        ...("op" in error ? { op: error.op } : {}),
      })),
    Effect.withSpan("firegrid.demo.linear_webhook.route", {
      kind: "server",
      attributes: {
        "firegrid.webhook.source": linearWebhookSource,
        "firegrid.webhook.path": linearWebhookPath,
      },
    }),
  )

const LinearWebhookCookbookRouteLive = (
  options: {
    readonly host: string
    readonly port: number
    readonly path: string
  },
) =>
  Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* VerifiedWebhookFactTable
      const server = createServer((request, response) => {
        Effect.runFork(
          handleLinearWebhook(request, response).pipe(
            Effect.provideService(VerifiedWebhookFactTable, table),
            Effect.catchAllCause(cause =>
              sendJson(response, 500, { error: String(cause) })),
          ),
        )
      })
      yield* Effect.acquireRelease(
        Effect.async<string, Error>((resume) => {
          server.once("error", error => resume(Effect.fail(error)))
          server.listen(options.port, options.host, () => {
            const address = server.address() as AddressInfo
            const url = `http://${options.host}:${address.port}${options.path}`
            resolveLinearWebhookRoute(url)
            resume(Effect.succeed(url))
          })
        }).pipe(
          Effect.tap(url =>
            Effect.annotateCurrentSpan("firegrid.demo.linear_webhook.url", url)),
          Effect.orDie,
        ),
        () =>
          Effect.async<void>((resume) => {
            server.closeAllConnections?.()
            server.close(() => resume(Effect.void))
          }),
      )
    }).pipe(
      Effect.withSpan("firegrid.demo.linear_webhook.route.acquire", {
        kind: "server",
      }),
    ),
  )

const verifiedWebhookFactTableLayer = (
  env: TinyFiregridHostEnv,
) =>
  VerifiedWebhookFactTable.layer(
    verifiedWebhookFactTableLayerOptions({
      streamUrl: durableStreamUrl(
        env.durableStreamsBaseUrl,
        `${env.namespace}.linearWebhookCookbook.verifiedWebhookFacts`,
      ),
    }),
  ) as Layer.Layer<VerifiedWebhookFactTable, DurableTableError>

const verifiedWebhookLinearProjectionChannel = (
  factTable: Layer.Layer<VerifiedWebhookFactTable, DurableTableError>,
) => {
  const rows = Stream.unwrap(
    Effect.map(VerifiedWebhookFactTable, table =>
      (table.verifiedWebhookFacts.rows() as Stream.Stream<unknown, unknown, never>).pipe(
        Stream.filterMap(Schema.decodeUnknownOption(LinearWebhookFactSchema)),
      )).pipe(Effect.provide(factTable)) as unknown as Effect.Effect<
        Stream.Stream<LinearWebhookFact, unknown, never>,
        unknown,
        never
      >,
  )
  return makeIngressChannel({
    target: VerifiedWebhookFactChannelTarget,
    schema: LinearWebhookFactSchema,
    sourceClass: "static-source",
    stream: rows,
  })
}

export const linearWebhookCookbookHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const mcpHost = "127.0.0.1"
  const mcpPath = "/mcp"
  const factTable = verifiedWebhookFactTableLayer(env)
  const verifiedWebhookChannel = verifiedWebhookLinearProjectionChannel(factTable)
  const verifiedWebhookChannelLive = Layer.succeed(
    VerifiedWebhookFactChannel,
    verifiedWebhookChannel,
  )
  const callerFacts = VerifiedWebhookFactCallerOwnedFactStreamsLive.pipe(
    Layer.provide(verifiedWebhookChannelLive),
  )
  const route = LinearWebhookCookbookRouteLive({
    host: "127.0.0.1",
    port: 0,
    path: linearWebhookPath,
  }).pipe(Layer.provide(factTable))
  const appFacts = Layer.mergeAll(
    factTable,
    verifiedWebhookChannelLive,
    callerFacts,
    route,
  )
  const channelsLive = RuntimeContextChannelRouterLive([
    verifiedWebhookChannel,
  ])
  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
    localProcessEnv: env.processEnv,
    mcpChannels: [verifiedWebhookChannel],
  })

  // firegrid-verified-webhook-ingest.PRODUCTION_SURFACE.1
  return Layer.discard(
    FiregridMcpServerLayer({
      host: mcpHost,
      port: 0,
      path: ensurePathInput(mcpPath),
    }),
  ).pipe(
    Layer.provideMerge(host),
    Layer.provideMerge(appFacts),
    Layer.provideMerge(channelsLive),
  ) as Layer.Layer<FiregridHost, DurableTableError | ServeError, never>
}
