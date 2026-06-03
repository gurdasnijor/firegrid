/**
 * makeVerifiedWebhookSource — lift the per-adapter boilerplate that
 * `tiny-firegrid/src/simulations/linear-webhook-cookbook-composition/host.ts`
 * demonstrates into a reusable helper.
 *
 * Goal: adding a new external webhook adapter (Linear, GitHub, Slack, …) is
 * one call to this factory plus a fact schema in `@firegrid/protocol`, not a
 * 250-line copy of the cookbook composition. Adapters still resolve through
 * the existing channel + caller-fact-streams + wait-router stack — no new
 * primitive is introduced. See
 * `docs/sdds/SDD_FIREGRID_RUNTIME_SOURCE_PRODUCER_ROLES.md` § Second Revision.
 *
 * What the helper composes for one source:
 *   1. The `VerifiedWebhookFactTable` table layer (consumes a stream URL).
 *   2. An `IngressChannel<Schema>` projection over the table rows (filter-
 *      decoded against the per-source `factSchema`), targeted at a
 *      caller-chosen `ChannelTarget`.
 *   3. A scoped `node:http` route that captures raw bytes, calls the
 *      existing `ingestVerifiedWebhook` adapter with per-source config
 *      (secret, signature header name, header selection, key paths), and
 *      writes the verified fact through `insertOrGet`.
 *
 * Multiple sources can share one `ChannelTarget` by composing their channel
 * projections together (see `mergeIngressChannels`), or use distinct targets
 * each with their own `CallerOwnedFactStreams` binding.
 */

import { makeIngressChannel, type IngressChannel } from "@firegrid/protocol/channels"
import type { ChannelTarget } from "@firegrid/protocol/channels"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer, Schema, Stream } from "effect"
// durable-lint-allow-control-plane: @effect/platform-node NodeHttpServer.layer listener
// factory (the documented `createServer` argument) — same pattern as mcp-host.ts.
import { createServer } from "node:http"
import {
  ingestVerifiedWebhook,
  type VerifiedWebhookIngestConfig,
  type VerifiedWebhookFactTable,
  type VerifiedWebhookFactTableService,
} from "../../verified-webhook-ingest/index.ts"

interface VerifiedWebhookRouteAddress {
  readonly host: string
  readonly port: number
  readonly path: string
}

interface VerifiedWebhookRouteBound {
  readonly url: string
  readonly host: string
  readonly port: number
  readonly path: string
}

interface MakeVerifiedWebhookSourceConfig<Fact> {
  /**
   * Stable source identifier written into every fact row's `factKey[0]`.
   * Examples: `"linear-prod"`, `"github-org-acme"`. Must be unique per
   * source/secret pair; this is also the key the agent matches on through
   * `wait_for({ whereFields: { source } })`.
   */
  readonly source: string

  /**
   * The schema concrete decoded fact rows must satisfy. Rows in
   * `VerifiedWebhookFactTable.verifiedWebhookFacts` that decode against this
   * schema flow through the channel; ones that don't are filtered out.
   * Use `LinearWebhookFactSchema` or a provider-specific fact schema.
   */
  readonly factSchema: Schema.Schema<Fact>

  /**
   * The `ingestVerifiedWebhook` config slice — secret, signature header name,
   * header selection, fact-key path, event-type path. See
   * `verified-webhook-ingest/adapter.ts` for the full surface.
   */
  readonly ingest: VerifiedWebhookIngestConfig

  /**
   * Channel target the projected stream registers at. Default:
   * `VerifiedWebhookFactChannelTarget` (`"firegrid.verifiedWebhooks"`).
   * Pass a distinct target to keep sources observable separately.
   */
  readonly channelTarget?: ChannelTarget | string

  /**
   * Where the helper binds the HTTP listener. `port: 0` lets the kernel
   * pick a free port (useful for tests and dev); production hosts set an
   * explicit port.
   */
  readonly route: VerifiedWebhookRouteAddress
}

interface VerifiedWebhookSourceBinding<Fact> {
  /** The same `source` identifier the config carried; surfaced for tests/observability. */
  readonly source: string

  /**
   * Pure projection over a bound `VerifiedWebhookFactTable` instance. Useful
   * when a host wants to compose the projection with extra Stream operators
   * before constructing the channel.
   */
  readonly project: (
    table: VerifiedWebhookFactTableService,
  ) => Stream.Stream<Fact, unknown, never>

  /**
   * Construct the `IngressChannel<Schema>` value from a bound table. The
   * channel's `binding.stream` is the projected row stream.
   */
  readonly channel: (
    table: VerifiedWebhookFactTableService,
  ) => IngressChannel<Schema.Schema<Fact>>

  /**
   * Scoped Layer that mounts the HTTP listener and resolves the bound URL
   * via `routeUrl`. Requires a `VerifiedWebhookFactTable` in context (the
   * caller provides the table layer once and passes it to every source's
   * `routeLayer`).
   */
  readonly routeLayer: Layer.Layer<never, never, VerifiedWebhookFactTable>

  /**
   * Effect that resolves to the bound URL after `routeLayer` has been built.
   * Mostly useful for tests; production hosts can ignore.
   */
  readonly routeUrl: Effect.Effect<VerifiedWebhookRouteBound>
}

// The per-source webhook handler as an `@effect/platform` HttpApp: read the
// raw request bytes (HMAC verification needs the exact bytes), hand them to the
// existing `ingestVerifiedWebhook` adapter, and map outcomes to JSON responses
// (202 verified / 400 rejected / 404 wrong route / 500 defect). Mirrors the
// previous raw-`node:http` handler's status semantics.
const webhookApp = (
  config: MakeVerifiedWebhookSourceConfig<unknown>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | VerifiedWebhookFactTable
> =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (
      request.method !== "POST" ||
      request.url.split("?")[0] !== config.route.path
    ) {
      return HttpServerResponse.unsafeJson({ error: "not found" }, { status: 404 })
    }
    const rawBody = new Uint8Array(yield* request.arrayBuffer)
    const result = yield* ingestVerifiedWebhook({
      source: config.source,
      headers: request.headers,
      rawBody,
      config: config.ingest,
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
    Effect.withSpan("firegrid.webhook.route", {
      kind: "server",
      attributes: {
        "firegrid.webhook.source": config.source,
        "firegrid.webhook.path": config.route.path,
      },
    }),
  )

export const makeVerifiedWebhookSource = <Fact>(
  config: MakeVerifiedWebhookSourceConfig<Fact>,
): VerifiedWebhookSourceBinding<Fact> => {
  let resolveBound: (bound: VerifiedWebhookRouteBound) => void = () => {}
  const boundPromise = new Promise<VerifiedWebhookRouteBound>((resolve) => {
    resolveBound = resolve
  })

  const project = (
    table: VerifiedWebhookFactTableService,
  ): Stream.Stream<Fact, unknown, never> =>
    (table.verifiedWebhookFacts.rows() as Stream.Stream<unknown, unknown, never>)
      .pipe(
        Stream.filterMap(Schema.decodeUnknownOption(config.factSchema)),
        Stream.withSpan("firegrid.host.channel.verified_webhook", {
          kind: "internal",
          attributes: { "firegrid.webhook.source": config.source },
        }),
      )

  const channel = (
    table: VerifiedWebhookFactTableService,
  ): IngressChannel<Schema.Schema<Fact>> =>
    makeIngressChannel<Schema.Schema<Fact>>({
      target: config.channelTarget ?? "firegrid.verifiedWebhooks",
      schema: config.factSchema,
      sourceClass: "static-source",
      stream: project(table),
    })

  // Serve the per-source HttpApp on its own loopback NodeHttpServer (the
  // server's lifetime is the Layer scope — the platform layer closes the
  // listener on release), then resolve the kernel-chosen bound address back
  // into `routeUrl`. `VerifiedWebhookFactTable` flows through as the layer's
  // sole requirement (the caller provides it). A bind failure is an
  // unrecoverable host defect (`Layer.orDie`), as in the previous raw-`node:http`
  // implementation's `Effect.orDie` on listen.
  const routeLayer: Layer.Layer<never, never, VerifiedWebhookFactTable> = Layer.mergeAll(
    HttpServer.serve(webhookApp(config as MakeVerifiedWebhookSourceConfig<unknown>)),
    Layer.scopedDiscard(
      HttpServer.addressWith((address) =>
        Effect.sync(() => {
          const port = address._tag === "TcpAddress" ? address.port : config.route.port
          resolveBound({
            host: config.route.host,
            port,
            path: config.route.path,
            url: `http://${config.route.host}:${port}${config.route.path}`,
          })
        })).pipe(
          Effect.withSpan("firegrid.webhook.route.acquire", {
            kind: "server",
            attributes: { "firegrid.webhook.source": config.source },
          }),
        ),
    ),
  ).pipe(
    Layer.provide(
      NodeHttpServer.layer(createServer, {
        port: config.route.port,
        host: config.route.host,
      }),
    ),
    Layer.orDie,
  )

  return {
    source: config.source,
    project,
    channel,
    routeLayer,
    routeUrl: Effect.promise(() => boundPromise),
  }
}

/**
 * Compose multiple `VerifiedWebhookSourceBinding` projections into a single
 * `IngressChannel` so they all observe through one `CallerOwnedFactStreams`
 * target. Useful when a host wants to register `firegrid.verifiedWebhooks`
 * once and have Linear, GitHub, … all flow through it.
 *
 * Each binding's `factSchema` must produce rows that satisfy the merged
 * `mergedSchema`. Typically `Schema.Union(LinearFact, GithubFact, …)`.
 */
export const mergeWebhookSourceChannels = <Fact>(
  bindings: ReadonlyArray<VerifiedWebhookSourceBinding<Fact>>,
  options: {
    readonly mergedSchema: Schema.Schema<Fact>
    readonly channelTarget?: ChannelTarget | string
  },
) =>
(table: VerifiedWebhookFactTableService): IngressChannel<Schema.Schema<Fact>> => {
  const stream: Stream.Stream<Fact, unknown, never> = Stream.mergeAll(
    bindings.map((binding) => binding.project(table)),
    { concurrency: bindings.length || 1 },
  )
  return makeIngressChannel<Schema.Schema<Fact>>({
    target: options.channelTarget ?? "firegrid.verifiedWebhooks",
    schema: options.mergedSchema,
    sourceClass: "static-source",
    stream,
  })
}
