/**
 * `@firegrid/runtime/node` — the Node host composition surface (the restate
 * `cli/src/app.rs` shape: resolution vs composition separated).
 *
 * `firegridNodeHost(resolvedOptions)` is PURE data composition: it takes a
 * fully-resolved options bundle (`FiregridHostOptions` + a resolved OTel
 * destination descriptor + a devtools boolean) and wires `firegridHost(options)`
 * with the observability/devtools/logger layers and `orDie`s the
 * infra-acquisition defects.
 *
 * The IMPURE half — reading `process.env`, resolving absolute OTel file paths
 * (`node:path`), and choosing the embedded-vs-configured durable-streams backend
 * (`@durable-streams/server`) — lives at the `bin/` boundary (`bin/_resolve.ts`,
 * the `CliEnv::load`/`init` analog) and is gate-legal there. This module reads no
 * env, touches no filesystem, and imports no Node-only durable-streams server —
 * so it passes the runtime-core gates with NO eslint override.
 */

import { FiregridOtelLive, type FiregridOtelDestination } from "@firegrid/observability/node"
import * as DevTools from "@effect/experimental/DevTools"
import { Layer, Logger } from "effect"
import { firegridHost, type FiregridHostOptions } from "./unified/host-entry.ts"

const OTEL_SERVICE_NAME = "firegrid-acp"

export interface FiregridNodeHostOptions extends FiregridHostOptions {
  /**
   * Resolved OTel destination descriptor — the absolute file path is already
   * computed at the bin boundary. `undefined` skips OTel entirely. (OTLP is
   * selected from env-config inside `FiregridOtelLive`; this descriptor is the
   * file/console fallback.)
   */
  readonly otel?: FiregridOtelDestination
  /**
   * Whether to install the Effect Dev Tools tracer. Resolved from
   * `FIREGRID_EFFECT_DEVTOOLS` at the bin boundary — never read here.
   */
  readonly devtools?: boolean
}

/**
 * Compose a launchable Firegrid Node host from a fully-resolved options bundle.
 * Pure: no `process.env`, no `node:path`, no `@durable-streams/server`.
 */
export const firegridNodeHost = (options: FiregridNodeHostOptions) => {
  const { otel, devtools, ...hostOptions } = options
  const otelLayer = otel === undefined
    ? Layer.empty
    : FiregridOtelLive({ resource: { serviceName: OTEL_SERVICE_NAME }, destination: otel })
  // Dev-only: stream this process's Effect spans to the VS Code "Effect Dev Tools"
  // Tracer panel. `DevTools.layer()` is a `Layer<never>` that installs the Effect
  // Tracer; it owns the single Tracer slot, so it is used INSTEAD of an active
  // OTel exporter. The toggle is resolved (from env) at the bin boundary.
  const devToolsLayer = devtools === true ? DevTools.layer() : Layer.empty
  return firegridHost(hostOptions).pipe(
    Layer.provideMerge(devToolsLayer),
    Layer.provideMerge(otelLayer),
    Layer.provide(Logger.remove(Logger.defaultLogger)),
    // The composition's only errors are infra-acquisition defects, surfaced as an
    // untyped `unknown`: OTel exporter setup (FiregridOtelLive) and the MCP HTTP
    // server bind (NodeHttpServer.layer inside FiregridMcpServerLayer). orDie them
    // at this composition boundary — a host that cannot acquire its substrate is a
    // startup defect, not a typed domain failure — so the bin's edge stays
    // launchable (E → never) without an `as unknown as` cast (tf-0awo.21 §6).
    Layer.orDie,
  )
}
