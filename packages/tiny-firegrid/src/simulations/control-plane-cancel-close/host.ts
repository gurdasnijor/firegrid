import { type FiregridHost, FiregridLocalHostLive } from "@firegrid/runtime/composition/host-live"
import { FiregridLocalProcessFromEnv } from "@firegrid/runtime/producers/sandbox/local-process-from-env"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"

// Standard local host (same composition as delegation-proof-cap4): it wires
// the runtime control-request dispatcher + side-effects (host-sdk layers.ts
// RuntimeControlRequestControlPlaneLive / RuntimeControlRequestSideEffectsLive),
// so the cancel/close lifecycle requests the parent agent appends are claimed
// and executed (firing the control-request-dispatcher / RuntimeLifecycleWorkflow
// / runtime-control spans this corpus scenario exists to cover).
export const controlPlaneCancelCloseHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> =>
  FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
  ) as Layer.Layer<FiregridHost, unknown, never>
