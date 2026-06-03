import {
  makeIngressChannel,
  type ChannelRegistration,
} from "@firegrid/protocol/channels"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { FetchHttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import {
  LinearWebhookFactSchema,
} from "@firegrid/protocol/verified-webhook"
import {
  ingestVerifiedWebhook,
  VerifiedWebhookFactTable,
  VerifiedWebhookFactKeyEncoded,
  verifiedWebhookFactTableLayerOptions,
} from "@firegrid/runtime/verified-webhook-ingest"
import {
  defaultProductionAdapterLayer,
  FiregridRuntime,
} from "@firegrid/runtime/unified"
import { DurableTable } from "effect-durable-operators"
import { DurableStream } from "effect-durable-streams"
import { Effect, Layer, Option, Schema, Stream } from "effect"
// durable-lint-allow-control-plane: @effect/platform-node NodeHttpServer.layer listener
// factory (the documented `createServer` argument) — same pattern as mcp-host.ts.
import { createServer } from "node:http"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

const verifiedWebhookWaitSource = "linear-cap1"
const verifiedWebhookWaitSecret = "verified-webhook-wait-secret"
const verifiedWebhookWaitRouteChannel = "tiny.verifiedWebhookWait.route"
const verifiedWebhookWaitRouteReadyEvent = "webhook.route.ready"

const routePath = "/webhooks/linear"

const RouteReadyRowSchema = Schema.Struct({
  routeId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  url: Schema.String,
  path: Schema.String,
  boundAt: Schema.String,
})
type RouteReadyRow = typeof RouteReadyRowSchema.Type

const VerifiedWebhookFactStreamEventSchema = Schema.Struct({
  value: Schema.Unknown,
})

class RouteReadyTable extends DurableTable("tiny.firegrid.verifiedWebhookWaitRoute", {
  routes: RouteReadyRowSchema,
}) {}

const normalizeVerifiedWebhookFactRow = (row: unknown): unknown => {
  if (
    typeof row !== "object" ||
    row === null ||
    Array.isArray(row) ||
    typeof (row as Record<string, unknown>).factKey !== "string"
  ) {
    return row
  }
  const decoded = Schema.decodeUnknownOption(VerifiedWebhookFactKeyEncoded)(
    (row as Record<string, unknown>).factKey,
  )
  return Option.match(decoded, {
    onNone: () => row,
    onSome: factKey => ({ ...(row as Record<string, unknown>), factKey }),
  })
}

const routeReadyFact = (
  env: TinyFiregridHostEnv,
  url: string,
): RouteReadyRow => ({
  routeId: `${env.runId}:${verifiedWebhookWaitSource}`,
  source: verifiedWebhookWaitSource,
  eventType: verifiedWebhookWaitRouteReadyEvent,
  url,
  path: routePath,
  boundAt: env.runId,
})

const handleLinearWebhook: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | VerifiedWebhookFactTable
> = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (request.method !== "POST" || request.url.split("?")[0] !== routePath) {
    return HttpServerResponse.unsafeJson({ error: "not found" }, { status: 404 })
  }
  const rawBody = new Uint8Array(yield* request.arrayBuffer)
  const result = yield* ingestVerifiedWebhook({
    source: verifiedWebhookWaitSource,
    headers: request.headers,
    rawBody,
    receivedAt: "2026-06-02T00:00:00.000Z",
    config: {
      secret: verifiedWebhookWaitSecret,
      signatureHeaderName: "x-linear-signature",
      selectedHeaderNames: ["linear-delivery"],
    },
  })
  yield* Effect.annotateCurrentSpan({
    "firegrid.webhook.fact_key": result.fact.factKey.join(":"),
    "firegrid.webhook.event_type": result.fact.eventType,
    "firegrid.webhook.external_event_key": result.fact.externalEventKey,
    "firegrid.webhook.ingest_result": result._tag,
  })
  return HttpServerResponse.unsafeJson(result, { status: 202 })
}).pipe(
  Effect.catchAll((error: { readonly message: string; readonly op?: string }) =>
    Effect.succeed(
      HttpServerResponse.unsafeJson({
        error: error.message,
        ...("op" in error ? { op: error.op } : {}),
      }, { status: 400 }),
    )),
  Effect.catchAllCause((cause) =>
    Effect.succeed(
      HttpServerResponse.unsafeJson({ error: String(cause) }, { status: 500 }),
    )),
  Effect.withSpan("tiny_firegrid.verified_webhook_wait.route", {
    kind: "server",
    attributes: {
      "firegrid.webhook.source": verifiedWebhookWaitSource,
      "firegrid.webhook.path": routePath,
    },
  }),
)

const verifiedWebhookFactTableLayer = (
  env: TinyFiregridHostEnv,
) =>
  VerifiedWebhookFactTable.layer(
    verifiedWebhookFactTableLayerOptions({
      streamUrl: durableStreamUrl(
        env.durableStreamsBaseUrl,
        `${env.namespace}.verified-webhook-wait.facts`,
      ),
    }),
  )

const routeReadyTableLayer = (
  env: TinyFiregridHostEnv,
) =>
  RouteReadyTable.layer({
    streamOptions: {
      url: durableStreamUrl(
        env.durableStreamsBaseUrl,
        `${env.namespace}.verified-webhook-wait.routes`,
      ),
      contentType: "application/json",
    },
  })

const routeLayer = (
  env: TinyFiregridHostEnv,
) => {
  let resolveRoute: (url: string) => void = () => {}
  const routeUrl = new Promise<string>((resolve) => {
    resolveRoute = resolve
  })

  const http = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* VerifiedWebhookFactTable
      yield* HttpServer.serveEffect(
        handleLinearWebhook.pipe(Effect.provideService(VerifiedWebhookFactTable, table)),
      )
      yield* HttpServer.addressWith((address) =>
        Effect.sync(() => {
          const port = address._tag === "TcpAddress" ? address.port : 0
          const url = `http://127.0.0.1:${port}${routePath}`
          resolveRoute(url)
        }))
    }).pipe(
      Effect.tap(() =>
        Effect.annotateCurrentSpan({
          "firegrid.webhook.source": verifiedWebhookWaitSource,
        })),
      Effect.withSpan("tiny_firegrid.verified_webhook_wait.route.acquire", {
        kind: "server",
      }),
    ),
  ).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    // A bind failure is an unrecoverable host defect (as in the previous
    // raw-`node:http` implementation's `Effect.orDie` on listen).
    Layer.orDie,
  )

  const publishRoute = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* RouteReadyTable
      const url = yield* Effect.promise(() => routeUrl)
      const fact = routeReadyFact(env, url)
      yield* table.routes.insertOrGet(fact).pipe(Effect.orDie)
      yield* Effect.annotateCurrentSpan({
        "firegrid.webhook.source": fact.source,
        "firegrid.webhook.route_channel": verifiedWebhookWaitRouteChannel,
        "firegrid.webhook.route_url": fact.url,
      })
    }).pipe(
      Effect.withSpan("tiny_firegrid.verified_webhook_wait.route_ready", {
        kind: "internal",
      }),
    ),
  )

  return { http, publishRoute }
}

const routeReadyChannel = (
  env: TinyFiregridHostEnv,
): ChannelRegistration =>
  makeIngressChannel({
    target: verifiedWebhookWaitRouteChannel,
    schema: RouteReadyRowSchema,
    sourceClass: "static-source",
    stream: Stream.unwrap(
      Effect.map(RouteReadyTable, table => table.routes.rows()).pipe(
        Effect.provide(routeReadyTableLayer(env)),
      ),
    ),
  })

const verifiedWebhookChannel = (
  env: TinyFiregridHostEnv,
): ChannelRegistration =>
  makeIngressChannel({
    target: "firegrid.verifiedWebhooks",
    schema: LinearWebhookFactSchema,
    sourceClass: "static-source",
    stream: DurableStream.read({
      endpoint: {
        url: durableStreamUrl(
          env.durableStreamsBaseUrl,
          `${env.namespace}.verified-webhook-wait.facts`,
        ),
      },
      schema: VerifiedWebhookFactStreamEventSchema,
      live: true,
    }).pipe(
      Stream.map(event => event.value),
      Stream.map(normalizeVerifiedWebhookFactRow),
      Stream.filterMap(Schema.decodeUnknownOption(LinearWebhookFactSchema)),
      Stream.provideLayer(FetchHttpClient.layer),
    ),
  })

export const verifiedWebhookWaitChannels = (
  env: TinyFiregridHostEnv,
): ReadonlyArray<ChannelRegistration> => [
  routeReadyChannel(env),
  verifiedWebhookChannel(env),
]

export const verifiedWebhookWaitHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const host = FiregridRuntime(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(),
  )
  const factTable = verifiedWebhookFactTableLayer(env)
  const routeTable = routeReadyTableLayer(env)
  const route = routeLayer(env)
  return Layer.mergeAll(
    host,
    factTable,
    routeTable,
    route.http.pipe(Layer.provide(factTable)),
    route.publishRoute.pipe(Layer.provide(routeTable)),
  )
}
