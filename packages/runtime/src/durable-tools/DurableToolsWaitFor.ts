/**
 * Public composition entrypoint for the durable-tools `wait_for` surface.
 *
 * Implements:
 *  - firegrid-durable-tools.RUNTIME_BOUNDARY.1 — once per runtime-host scope
 *  - firegrid-durable-tools.RUNTIME_BOUNDARY.4 — the runtime host provides
 *    the wait router and durable wait store alongside the workflow-engine
 *    and ingress layers
 *  - firegrid-durable-tools.PUBLIC_SURFACE.5 — wait/completion rows stay
 *    runtime-only; this module is not re-exported from @firegrid/client
 *  - firegrid-typed-wait-source-redesign.WAIT_ROUTER.1 — the router consumes
 *    `RuntimeWaitStreams`; the runtime-owned observation tags it needs remain
 *    requirements satisfied by the host substrate
 */

import { Layer } from "effect"
import {
  DurableToolsTable,
  type DurableToolsTableOptions,
  durableToolsTableLayerOptions,
} from "./internal/table.ts"
import { RuntimeWaitStreamsLive } from "./internal/runtime-wait-streams.ts"
import { WaitRouterLive } from "./internal/wait-router.ts"
import { DurableWaitStoreLive } from "./internal/durable-wait-store.ts"

export type DurableToolsWaitForLayerOptions = DurableToolsTableOptions

/**
 * Builds the composite Layer that wires `DurableToolsTable`, the durable wait
 * store, and the wait router. The router fork lives in the layer scope and
 * shuts down on scope close.
 *
 * Requirements (R) — `WorkflowEngine.WorkflowEngine` plus the runtime
 * observation tags (`RuntimeAgentOutputEvents`, `RuntimeRuns`) consumed by
 * `RuntimeWaitStreamsLive` must be provided by the runtime host alongside
 * this layer.
 */
export const DurableToolsWaitForLive = (
  options: DurableToolsWaitForLayerOptions,
) => {
  const durableToolsTableLive = DurableToolsTable.layer(
    durableToolsTableLayerOptions(options),
  )
  const durableToolsCapabilities = DurableWaitStoreLive
  const routerLive = WaitRouterLive.pipe(
    Layer.provide(durableToolsCapabilities),
    Layer.provide(RuntimeWaitStreamsLive),
  )
  return routerLive.pipe(
    Layer.provideMerge(durableToolsCapabilities),
    Layer.provideMerge(durableToolsTableLive),
  )
}
