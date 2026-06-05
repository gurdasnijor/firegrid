/**
 * The launched host: the REAL fluent-runtime served surface (#939's
 * `FluentRuntimeServerLive` — Sessions + ControlPlane over FluentStore) on a
 * local HTTP listener, backed by the durable-streams server the firelab runner
 * already stood up (`env.durableStreamsBaseUrl`). Because firelab launches this
 * layer as the host daemon (not inside the driver), every `fluent_runtime.store.*`
 * span fires host-side (`firegrid.side != "driver"`) — forge-proof. The driver
 * reaches it only over HTTP; that is what earns the verdict.
 */
import { NodeHttpServer } from "@effect/platform-node"
import { FluentRuntimeServerLive } from "@firegrid/fluent-runtime"
import { Layer } from "effect"
import { createServer } from "node:http"
import type { FiregridHost, FirelabHostEnv } from "../../types.ts"
import { WORKBENCH_PORT } from "./port.ts"

export const fluentRuntimeWorkbenchHost = (
  env: FirelabHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  FluentRuntimeServerLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
  }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: WORKBENCH_PORT, host: "127.0.0.1" })),
    // A host that can't bind its port is fatal, not a typed sim failure.
    Layer.orDie,
  )
