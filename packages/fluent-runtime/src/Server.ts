import { FetchHttpClient, HttpApiBuilder } from "@effect/platform"
import { Layer } from "effect"
import { FluentRuntimeApiLive } from "./Api.ts"
import { FluentStoreLive, type StoreConfig } from "./Store.ts"

/**
 * The reusable fluent-runtime server layer: the full HTTP surface — the
 * `Sessions` group AND the `ControlPlane` group (send/tag/fork/read/head) —
 * backed by `FluentStore` over durable streams, served via `HttpApiBuilder`.
 *
 * Platform-agnostic: the CONSUMER provides the HTTP listener (e.g.
 * `NodeHttpServer.layer(createServer, { port })`). This is the product layer
 * firelab / Tooling import and launch instead of handrolling the
 * API + store + http-client composition in a sim host.
 *
 * `provideMerge` keeps `FluentStore` in the success channel so a launcher can
 * keep a concrete service in its layer's ROut (the firelab host pattern) with no
 * cast — every `fluent_runtime.store.*` span still fires host-side (forge-proof,
 * `firegrid.side != "driver"`).
 *
 * @example
 * ```ts
 * import { NodeHttpServer } from "@effect/platform-node"
 * import { createServer } from "node:http"
 *
 * FluentRuntimeServerLive({ durableStreamsBaseUrl, namespace }).pipe(
 *   Layer.provide(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
 *   Layer.launch,
 * )
 * ```
 */
export const FluentRuntimeServerLive = (config: StoreConfig) =>
  HttpApiBuilder.serve().pipe(
    Layer.provide(FluentRuntimeApiLive),
    Layer.provideMerge(FluentStoreLive(config)),
    Layer.provide(FetchHttpClient.layer),
  )
