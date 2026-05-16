import { Context, Layer } from "effect"
import {
  RuntimeControlPlaneRecorderLive,
} from "../authorities/index.ts"
import {
  RuntimeIngressDeliveryTrackerLayer,
} from "../agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts"
import {
  RuntimeIngressInputStreamLayer,
} from "../agent-event-pipeline/authorities/runtime-ingress-appender.ts"
import {
  RuntimeOutputJournalLayer,
} from "../agent-event-pipeline/authorities/runtime-output-journal.ts"
import { RuntimeSourceRegistrationsLive } from "../source-registration/index.ts"
import { HostOwnedDurableToolsWaitForLive } from "./host-owned-durable-tools.ts"

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.2
// Shared host runtime observation substrate used by both host-scoped
// composition and codec-path tool lowering.
export const HostRuntimeObservationSubstrateLive = RuntimeSourceRegistrationsLive.pipe(
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
