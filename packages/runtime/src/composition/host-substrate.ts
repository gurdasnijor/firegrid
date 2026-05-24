// Relocated from deleted `host-sdk/src/host/runtime-substrate.ts` (Class
// F3 host composition support). The `HostRuntimeContextExecutionEnv`
// type union + shared observation-substrate Layers. No host-sdk-internal
// imports.

import { Layer } from "effect"
import {
  RuntimeControlPlaneRecorderLive,
} from "../tables/runtime-control-plane.ts"
import {
  type CurrentHostSession,
  type RuntimeControlPlaneTable,
  type RuntimeOutputTable,
} from "@firegrid/protocol/launch"
import { type RuntimeHostConfig } from "../channels/runtime-host-config.ts"
import {
  type RuntimeAgentOutputAfterEvents,
  RuntimeAgentOutputEventsLayer,
} from "../tables/runtime-output-public.ts"
import {
  type RuntimeContextStateStore,
} from "../tables/runtime-context-state.ts"
import {
  RuntimeObservationStreamsLive,
} from "../streams/index.ts"
import {
  PerContextRuntimeAgentOutputAfterEventsLive,
  RuntimeContextStateStoreLive,
} from "./per-context-host-live.ts"
import {
  SessionAgentOutputChannelLive,
} from "../channels/session-agent-output/live.ts"

// TFIND-031: the host-provided runtime context that a per-context
// workflow execution genuinely requires. Deferred-execution seams
// (`Effect.context<…>()` captured at Layer-build time and re-provided
// into closures that run later) MUST capture this set instead of
// `never`. These tags are always satisfied at runtime by the composed
// Firegrid host layer (`FiregridRuntimeHostLive`); annotating `never`
// was only ever sound because `DurableTable.layer` leaked `any` and
// collapsed the requirements channel. With precise `.layer` typing the
// real requirement surfaces — declare it honestly here rather than
// re-erase it.
export type HostRuntimeContextExecutionEnv =
  | RuntimeControlPlaneTable
  | RuntimeOutputTable
  | RuntimeAgentOutputAfterEvents
  | RuntimeContextStateStore
  | CurrentHostSession
  | RuntimeHostConfig

// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.2
// firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
// firegrid-typed-wait-source-redesign.REJECTION.2
// Shared host runtime observation substrate used by workflow support layers.
// Runtime-owned workflows consume typed observation tags directly; host-sdk
// installs the host-backed providers at the composition boundary.
export const HostRuntimeObservationSubstrateLive = PerContextRuntimeAgentOutputAfterEventsLive.pipe(
  Layer.provideMerge(RuntimeContextStateStoreLive),
  Layer.provideMerge(SessionAgentOutputChannelLive),
  Layer.provideMerge(RuntimeAgentOutputEventsLayer),
  Layer.provideMerge(RuntimeControlPlaneRecorderLive),
  Layer.withSpan("firegrid.host.runtime_substrate.observation.layer", {
    kind: "internal",
  }),
)

export const HostRuntimeObservationStreamsLive = RuntimeObservationStreamsLive.pipe(
  Layer.provideMerge(HostRuntimeObservationSubstrateLive),
  Layer.withSpan("firegrid.host.runtime_substrate.observation_streams.layer", {
    kind: "internal",
  }),
)
