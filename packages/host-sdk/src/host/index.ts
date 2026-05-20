// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.1
export type {
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
  StartRuntimeResult,
} from "./types.ts"

export {
  ChannelDirectionSchema,
  ChannelRegistry,
  ChannelRegistryLive,
  ChannelTargetSchema,
  FactoryEventSchema,
  FactoryEventsChannelTarget,
  UnknownChannelTarget,
  makeAfferentChannel,
  makeCallableChannel,
  makeChannelRegistry,
  makeChannelTarget,
  makeEfferentChannel,
  makeFactoryEventsChannel,
  type AfferentChannel,
  type AppendTargetBinding,
  type CallableChannel,
  type CallTargetBinding,
  type ChannelDirection,
  type ChannelMetadata,
  type ChannelRegistration,
  type ChannelRegistryService,
  type ChannelTarget,
  type EfferentChannel,
  type FactoryEvent,
  type TypedStreamBinding,
} from "./channel-registry.ts"

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
  stateChangesChannel,
  stateChangesChannelFromCollection,
  type StateChangesChannel,
} from "./state-changes-channel.ts"
export {
  HumanMessageSchema,
  dmChannel,
  humanChannelPair,
  humanChannelRegistrations,
  humanChannelTarget,
  notificationChannel,
  type HumanChannelKind,
  type HumanChannelPair,
  type HumanMessage,
} from "./human-channel.ts"
export {
  RuntimeControlRequestReconciler,
  RuntimeControlRequestReconcilerDaemonLive,
  RuntimeControlRequestReconcilerLive,
  RuntimeControlRequestWorkflowEngine,
  RuntimeControlRequestWorkflowEngineLive,
  RuntimeContextProvisionWorkflow,
  RuntimeLifecycleWorkflow,
  RuntimeStartWorkflow,
  reconcileRuntimeControlRequestsOnce,
  runRuntimeControlRequestReconciler,
  runtimeControlRequestWorkflowExecutionId,
  runtimeControlRequestWorkflowStreamUrl,
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
