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
import { Effect, Layer, Schema, Stream } from "effect"
// durable-lint-allow-control-plane: per-source HTTP listener factory; mirrors composition/mcp-host.ts pattern
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import {
  ingestVerifiedWebhook,
  type VerifiedWebhookIngestConfig,
  type VerifiedWebhookIngestError,
  VerifiedWebhookFactTable,
  type VerifiedWebhookFactTableService,
} from "../../verified-webhook-ingest/index.ts"

const encoder = new TextEncoder()

export interface VerifiedWebhookRouteAddress {
  readonly host: string
  readonly port: number
  readonly path: string
}

export interface VerifiedWebhookRouteBound {
  readonly url: string
  readonly host: string
  readonly port: number
  readonly path: string
}

export interface MakeVerifiedWebhookSourceConfig<Fact> {
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

export interface VerifiedWebhookSourceBinding<Fact> {
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
    request.on("error", (error) => resume(Effect.fail(error)))
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

const sendNotFound = (response: ServerResponse): Effect.Effect<void> =>
  sendJson(response, 404, { error: "not found" })

const handleRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  config: MakeVerifiedWebhookSourceConfig<unknown>,
): Effect.Effect<void, never, VerifiedWebhookFactTable> =>
  Effect.gen(function*() {
    if (
      request.method !== "POST" ||
      request.url?.split("?")[0] !== config.route.path
    ) {
      return yield* sendNotFound(response)
    }
    const rawBody = yield* readRawBody(request)
    const result = yield* ingestVerifiedWebhook({
      source: config.source,
      headers: request.headers,
      rawBody,
      config: config.ingest,
    })
    return yield* sendJson(response, 202, result)
  }).pipe(
    Effect.catchAll((error: Error | VerifiedWebhookIngestError) =>
      sendJson(response, 400, {
        error: error.message,
        ...("op" in error ? { op: error.op } : {}),
      })),
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

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Layer.scopedDiscard widens R to `any` through Effect.async + acquireRelease inference; the gen body only consumes VerifiedWebhookFactTable
  const routeLayer: Layer.Layer<never, never, VerifiedWebhookFactTable> = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* VerifiedWebhookFactTable
      const server = createServer((request, response) => {
        Effect.runFork(
          handleRequest(
            request,
            response,
            config as MakeVerifiedWebhookSourceConfig<unknown>,
          ).pipe(
            Effect.provideService(VerifiedWebhookFactTable, table),
            Effect.catchAllCause((cause) =>
              sendJson(response, 500, { error: String(cause) })),
          ),
        )
      })
      yield* Effect.acquireRelease(
        Effect.async<VerifiedWebhookRouteBound, Error>((resume) => {
          server.once("error", (error) => resume(Effect.fail(error)))
          server.listen(config.route.port, config.route.host, () => {
            const address = server.address() as AddressInfo
            const bound: VerifiedWebhookRouteBound = {
              host: config.route.host,
              port: address.port,
              path: config.route.path,
              url: `http://${config.route.host}:${address.port}${config.route.path}`,
            }
            resolveBound(bound)
            resume(Effect.succeed(bound))
          })
        }).pipe(
          Effect.tap((bound) =>
            Effect.annotateCurrentSpan({
              "firegrid.webhook.source": config.source,
              "firegrid.webhook.url": bound.url,
            })),
          Effect.orDie,
        ),
        () =>
          Effect.async<void>((resume) => {
            server.closeAllConnections?.()
            server.close(() => resume(Effect.void))
          }),
      )
    }).pipe(
      Effect.withSpan("firegrid.webhook.route.acquire", {
        kind: "server",
        attributes: { "firegrid.webhook.source": config.source },
      }),
    ),
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
