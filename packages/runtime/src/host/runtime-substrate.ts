import { Context, Layer } from "effect"
import {
  RuntimeControlPlaneRecorderLive,
  RuntimeIngressDeliveryTrackerLayer,
  RuntimeIngressInputStreamLayer,
  RuntimeOutputJournalLayer,
} from "../authorities/index.ts"
import { HostOwnedDurableToolsWaitForLive } from "./host-owned-durable-tools.ts"
import { RuntimeObservationSourcesLive } from "./observation-sources.ts"

// firegrid-runtime-boundary-reconciliation.HOST_SPLIT.4
// Shared host runtime observation substrate used by both host-scoped
// composition and codec-path tool lowering.
export const HostRuntimeObservationSubstrateLive = RuntimeObservationSourcesLive.pipe(
  Layer.provideMerge(HostOwnedDurableToolsWaitForLive),
  Layer.provideMerge(Layer.mergeAll(
    RuntimeOutputJournalLayer,
    RuntimeControlPlaneRecorderLive,
    RuntimeIngressInputStreamLayer,
    RuntimeIngressDeliveryTrackerLayer,
  )),
)

export class RuntimeCodecToolLoweringLayer extends Context.Tag(
  "@firegrid/runtime/RuntimeCodecToolLoweringLayer",
)<RuntimeCodecToolLoweringLayer, Layer.Layer<unknown, unknown, unknown>>() {}
