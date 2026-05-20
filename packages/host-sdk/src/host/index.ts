// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.1
export type {
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
  StartRuntimeResult,
} from "./types.ts"

export {
  ChannelDirectionSchema,
  ChannelInventory,
  ChannelInventoryLive,
  ChannelSourceClassSchema,
  ChannelTargetSchema,
  FactoryEventSchema,
  UnknownChannelTarget,
  channelMetadata,
  findChannel,
  makeChannelInventory,
  makeIngressChannel,
  makeBidirectionalChannel,
  makeCallableChannel,
  makeChannelTarget,
  makeEgressChannel,
  type IngressChannel,
  type AppendTargetBinding,
  type BidirectionalChannel,
  type CallableChannel,
  type CallTargetBinding,
  type ChannelDirection,
  type ChannelInventoryService,
  type ChannelMetadata,
  type ChannelRegistration,
  type ChannelSourceClass,
  type ChannelTarget,
  type EgressChannel,
  type FactoryEvent,
  type TypedStreamBinding,
} from "./channel.ts"
export {
  SessionSelfChannelsLive,
  SessionSelfCheckpointChannel,
  SessionSelfCheckpointChannelTarget,
  SessionSelfCheckpointEventSchema,
  SessionSelfLifecycleChannel,
  SessionSelfLifecycleChannelTarget,
  SessionSelfLifecycleEventSchema,
  makeSessionSelfChannels,
  type SessionSelfCheckpointEvent,
  type SessionSelfLifecycleEvent,
} from "./channels/session-self/index.ts"

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
  HostRuntimeObservationStreamsLive,
  RuntimeAgentToolExecutionLive,
} from "./runtime-substrate.ts"
export {
  EventChannelSourceClasses,
  eventChannel,
  eventChannelFromCollection,
  eventChannelTarget,
  type EventChannel,
} from "./event-channel.ts"
export {
  StateRowsChannel,
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
  SessionLogChannelTag,
  SessionLogChannelTarget,
  SessionLogRowSchema,
  sessionLogChannel,
  sessionLogChannelFromCollection,
  type SessionLogChannel,
  type SessionLogRow,
} from "./session-log-channel.ts"
export {
  RuntimeControlRequestReconciler,
  RuntimeControlRequestReconcilerDaemonLive,
  RuntimeControlRequestReconcilerLive,
  RuntimeControlRequestWorkflowEngine,
  RuntimeControlRequestWorkflowEngineLive,
  reconcileRuntimeControlRequestsOnce,
  runRuntimeControlRequestReconciler,
  runtimeControlRequestReconcilerDefaults,
  type RuntimeControlRequestReconcilerOptions,
  type RuntimeControlRequestReconcilerService,
} from "./control-request-reconciler.ts"
export {
  RuntimeContextProvisionWorkflow,
  RuntimeLifecycleWorkflow,
  RuntimeStartWorkflow,
  runtimeControlRequestWorkflowExecutionId,
  runtimeControlRequestWorkflowStreamUrl,
} from "@firegrid/runtime/workflows"
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
