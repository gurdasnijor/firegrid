/**
 * Public composition entrypoint for the durable-tools `wait_for` surface.
 *
 * Implements:
 *  - firegrid-durable-tools.RUNTIME_BOUNDARY.1 — once per runtime-host scope
 *  - firegrid-durable-tools.RUNTIME_BOUNDARY.4 — the runtime host provides
 *    the wait router and source-collection registry alongside the
 *    workflow-engine and ingress layers
 *  - firegrid-durable-tools.PUBLIC_SURFACE.5 — wait/completion rows stay
 *    runtime-only; this module is not re-exported from @firegrid/client
 */

import { Layer } from "effect"
import {
  DurableToolsTable,
  type DurableToolsTableOptions,
  durableToolsTableLayerOptions,
} from "./internal/table.ts"
import { SourceCollectionsLive } from "./internal/source-collections.ts"
import { WaitRouterLive } from "./internal/wait-router.ts"
import { DurableWaitStoreLive } from "./internal/durable-wait-store.ts"

export type DurableToolsWaitForLayerOptions = DurableToolsTableOptions

/**
 * Builds the composite Layer that wires `DurableToolsTable`,
 * `SourceCollections`, and the wait router. The router fork lives in
 * the layer scope and shuts down on scope close.
 *
 * Requirements (R) — `WorkflowEngine.WorkflowEngine` must be provided by the
 * runtime host alongside this layer.
 */
export const DurableToolsWaitForLive = (
  options: DurableToolsWaitForLayerOptions,
) => {
  const durableToolsTableLive = DurableToolsTable.layer(
    durableToolsTableLayerOptions(options),
  )
  const durableToolsCapabilities = DurableWaitStoreLive.pipe(
    Layer.provideMerge(SourceCollectionsLive),
  )
  const routerLive = WaitRouterLive.pipe(
    Layer.provide(durableToolsCapabilities),
  )
  return routerLive.pipe(
    Layer.provideMerge(durableToolsCapabilities),
    Layer.provideMerge(durableToolsTableLive),
  )
}
