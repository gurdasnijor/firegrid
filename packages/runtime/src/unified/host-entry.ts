/**
 * The single Firegrid host composition root (tf-ll90.8.4 / §12 "MCP is the
 * single ingress"). The Restate `node.ts` analog: callers pass config as DATA
 * and this composes EVERYTHING internally — `FiregridRuntime(spec, adapter)` +
 * the MCP ingress (`McpIngressLive`, private) + the backend Live. Nobody
 * hand-assembles layers; prod and sims call this same entry and differ ONLY by
 * the options data (adapter + backend Live + ingress transport).
 *
 * Home: this lives at `@firegrid/runtime/unified` (exported from its barrel)
 * — NOT `@firegrid/host-sdk` — because the runtime bins compose through it and
 * `host-sdk → runtime` already exists, so an entry in host-sdk would be a
 * dependency cycle; and the `host-sdk-public-composition-surface-only-unified`
 * dep-cruiser rule restricts the host-sdk barrel to re-exporting from
 * `runtime/unified` only. `@firegrid/host-sdk` re-exports it as the public surface.
 */

import type { DurableStreams } from "@firegrid/protocol/launch"
import { type Effect, Layer } from "effect"
import {
  FiregridRuntime,
  type FiregridRuntimeAdapterLayer,
  type FiregridRuntimeSpec,
} from "./host.ts"
import {
  McpIngressLive,
  type McpIngressDurableStreamsOptions,
  type McpIngressHttpOptions,
} from "./mcp-ingress.ts"

/** MCP ingress transport — the dual halves of `McpIngressLive`, as data. */
export type FiregridIngressOptions =
  | ({ readonly transport: "http" } & McpIngressHttpOptions)
  | ({ readonly transport: "durable-streams" } & McpIngressDurableStreamsOptions)

export interface FiregridHostOptions {
  /** Host-identity residue (namespace, hostId). */
  readonly spec: FiregridRuntimeSpec
  /** The session adapter (the prod/sim swap unit). */
  readonly adapter: FiregridRuntimeAdapterLayer
  /** The durable-streams backend Live — `DurableStreamsLive.configuredWith(...)` (prod) or `.embedded` (sim). */
  readonly backend: Layer.Layer<DurableStreams>
  /** The MCP ingress transport callers connect to. */
  readonly ingress: FiregridIngressOptions
}

const ingressLayer = (ingress: FiregridIngressOptions) =>
  ingress.transport === "http"
    ? McpIngressLive.http(ingress)
    : McpIngressLive.durableStreams(ingress)

/**
 * Compose a launchable Firegrid host from options. R-channel is `never` once the
 * backend Live closes the `DurableStreams` floor. The success channel is
 * inferred (the composed runtime + ingress Tags) so the result remains
 * assignable wherever a narrower `Layer<FiregridHost, …>` is expected.
 */
export const firegridHost = (options: FiregridHostOptions) => {
  const runtime = FiregridRuntime(options.spec, options.adapter).pipe(
    Layer.provide(options.backend),
  )
  return ingressLayer(options.ingress).pipe(Layer.provideMerge(runtime))
}

/** Compose + launch the host (runs until interrupted). */
export const runFiregridHost = (
  options: FiregridHostOptions,
): Effect.Effect<never, unknown, never> => Layer.launch(firegridHost(options))
