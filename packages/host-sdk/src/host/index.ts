// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.1
export type {
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
  StartRuntimeResult,
} from "./types.ts"

export {
  ContextNotFound,
  ContextNotLocal,
  CurrentHostSession,
  CurrentHostStopped,
  CurrentRuntimeContext,
  durableStreamUrl,
  findRuntimeContext,
  hostOwnedStreamUrl,
  provideRuntimeContext,
  requireLocalContext,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/protocol/launch"

export type {
  RuntimeAgentOutputObservation,
} from "@firegrid/runtime/runtime-output"
export { RuntimeIngressError } from "@firegrid/runtime/errors"
// CallerOwnedFactStreams is a host-side capability: the host provides
// the implementation, runtime observation consumers resolve CallerFact
// streams through it. Hosts (including tests / sims that compose a host
// layer) need this tag to bind their durable streams without reaching
// into the retired durable-tools surface.
export { CallerOwnedFactStreams } from "@firegrid/runtime/streams"
export {
  localProcessSpawnEnvFromHostEnv,
  type LocalProcessSandboxProviderOptions,
} from "@firegrid/runtime/sources/sandbox"
export {
  RuntimeEnvResolverPolicy,
  type RuntimeEnvResolverPolicyValue,
} from "@firegrid/runtime/sources/sandbox"
export {
  decodeRunConfig,
  firegridRunCreatedBy,
  runConfigRequiresInput,
  runConfigToIngressRequest,
  runConfigToRuntimeContextIntent,
  type RunConfig,
} from "./sync-run.ts"
export {
  appendRuntimeIngress,
  RuntimeStartCapabilityLive,
  startRuntime,
} from "./commands.ts"
export {
  hostProjectionObserver,
  type HostProjectionObserverOptions,
} from "./projection-observer.ts"
export {
  RuntimeControlRequestReconciler,
  RuntimeControlRequestReconcilerDaemonLive,
  RuntimeControlRequestReconcilerLive,
  reconcileRuntimeControlRequestsOnce,
  runRuntimeControlRequestReconciler,
  runtimeControlRequestReconcilerDefaults,
  type RuntimeControlRequestReconcilerOptions,
  type RuntimeControlRequestReconcilerService,
} from "./control-request-reconciler.ts"
export {
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcess,
  FiregridLocalProcessFromEnv,
  FiregridRuntimeHostLive,
  FiregridRuntimeHostWithWorkflowLive,
  type FiregridHost,
} from "./layers.ts"
export {
  FiregridRuntimeHostFromConfig,
  FiregridRuntimeHostWithWorkflowFromConfig,
  FiregridRuntimeHostWithWorkflowFromConfigWithEnvPolicy,
  RuntimeHostTopologyFromConfig,
} from "./config-live.ts"
export { RuntimeHostAgentToolHostLive } from "./agent-tool-host-live.ts"
