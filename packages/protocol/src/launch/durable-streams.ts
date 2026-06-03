/**
 * Seam 1 (Firegrid Composition SDD §12) — the `DurableStreams` backend Tag.
 *
 * The backend is a Tag that resolves a **closed set of logical stream names**
 * to physical stream options. The URL arithmetic lives in exactly one place
 * (delegating to the canonical `durableStreamUrl` encoder), and the resolver
 * has **no `contextId` parameter** — so a per-context output stream is not a
 * thing that can be asked for. This is §3.1 resolved structurally: the shape
 * that minted a divergent per-context output URL is no longer expressible.
 *
 * Placement (Seam 1b import-graph rule): this Tag + `StreamName` + the *pure*
 * `configured` Live live in `@firegrid/protocol` (browser-safe — `configured`
 * only calls the pure `durableStreamUrl` string encoder and reads `Config`).
 * The `embedded` in-memory Live is **sim-side**, never here, because it owns a
 * server lifecycle. `protocol` ships the Tag + the configured Live but no
 * transport-specific embedded backend, so it stays browser-safe and the
 * `client-sdk → protocol` (no edge to `runtime`) boundary is preserved.
 */

import { Config, type ConfigError, Context, Effect, Layer } from "effect"
import type { DurableTableHeaders } from "effect-durable-operators"
import {
  durableStreamUrl,
  namespaceRuntimeOutputStreamName,
  namespaceRuntimeStreamName,
} from "./authority.ts"

/**
 * The closed set of logical, host-owned durable stream names. There is no
 * `contextId`-parameterized name — per-context-ness is a row column plus a
 * `Stream.filter`, never a distinct stream (Seam 1 / §3.1).
 */
export const StreamName = {
  ControlPlane: "control-plane",
  Output: "output",
  Signals: "signals",
  Unified: "unified",
  Engine: "engine",
} as const
export type StreamName = (typeof StreamName)[keyof typeof StreamName]

/**
 * Physical stream options the backend resolves a logical name to. Structurally
 * a `DurableStreamOptions` (the shape `DurableTable.layer` / the workflow
 * engine consume), kept narrow here so `protocol` need not depend on the
 * `@durable-streams/client` transport types directly.
 */
export interface StreamOptions {
  readonly url: string
  readonly contentType: string
  readonly headers?: DurableTableHeaders
}

export interface DurableStreamsService {
  /** Resolve a logical stream name → physical options. No `contextId`, ever. */
  readonly streamOptions: (name: StreamName) => StreamOptions
}

export class DurableStreams extends Context.Tag("firegrid/DurableStreams")<
  DurableStreams,
  DurableStreamsService
>() {}

/**
 * Map a logical `StreamName` → the physical durable-stream name. The
 * control-plane and output streams MUST resolve to the canonical names the
 * client-sdk reads from (`runtime` / `runtimeOutput`, via
 * `namespaceRuntimeStreamName` / `namespaceRuntimeOutputStreamName`), or the
 * host floor and the client would point at divergent streams. unified/engine
 * match the names the pre-§12 `tableLayer` / `engineLayer` built inline; signals
 * is reserved (not yet a distinct host stream — signals ride the unified table).
 */
const physicalStreamName = (namespace: string, name: StreamName): string =>
  ({
    [StreamName.ControlPlane]: namespaceRuntimeStreamName(namespace),
    [StreamName.Output]: namespaceRuntimeOutputStreamName(namespace),
    [StreamName.Signals]: `${namespace}.firegrid.signals`,
    [StreamName.Unified]: `${namespace}.firegrid.unified`,
    [StreamName.Engine]: `${namespace}.firegrid.engine`,
  })[name]

const streamOptionsFor = (
  cfg: { readonly baseUrl: string; readonly namespace: string; readonly headers?: DurableTableHeaders },
) =>
  (name: StreamName): StreamOptions => ({
    // delegate to the canonical encoder — do NOT inline URL arithmetic.
    // `durableStreamUrl` handles generic vs Electric service-scoped roots and
    // /v1/stream/ encoding. The logical→physical name map (`physicalStreamName`)
    // keeps the host floor on the SAME streams the client-sdk reads.
    url: durableStreamUrl(cfg.baseUrl, physicalStreamName(cfg.namespace, name)),
    contentType: "application/json",
    ...(cfg.headers === undefined ? {} : { headers: cfg.headers }),
  })

/**
 * Config-driven `configured` Live — the floor is where the host's external
 * configuration enters the graph, so it is the natural place to start
 * Config-as-law (Seam 1). A test or sim that wants the *real* backend with
 * test config supplies a `ConfigProvider` layer instead of mutating
 * `process.env`. R-channel: `never` (`ConfigProvider` is a default service);
 * E-channel: `ConfigError` if the env vars are absent.
 */
const configured: Layer.Layer<DurableStreams, ConfigError.ConfigError> = Layer.effect(
  DurableStreams,
  Effect.map(
    Config.all({
      baseUrl: Config.string("DURABLE_STREAMS_BASE_URL"),
      namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE"),
    }),
    (cfg) => DurableStreams.of({ streamOptions: streamOptionsFor(cfg) }),
  ),
)

/**
 * Direct `configured` constructor — same physical resolver, values passed
 * explicitly rather than read from `Config`. For callers that already hold the
 * `{ baseUrl, namespace }` pair (e.g. the back-compat `FiregridHost` shim that
 * still threads `spec.durableStreamsBaseUrl`).
 */
const configuredWith = (
  cfg: { readonly baseUrl: string; readonly namespace: string; readonly headers?: DurableTableHeaders },
): Layer.Layer<DurableStreams> =>
  Layer.succeed(DurableStreams, { streamOptions: streamOptionsFor(cfg) })

export const DurableStreamsLive = {
  configured,
  configuredWith,
  // `embedded` (the in-memory `makeInMemoryBackend` Live) is sim-side: it owns
  // a server lifecycle and must not pull a transport server into browser-safe
  // `protocol`. See the spike test for the sim-side embedded Live.
} as const
