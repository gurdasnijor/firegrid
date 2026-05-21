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
  SessionAgentOutputChannel,
  SessionAgentOutputChannelTarget,
  type SessionAgentOutputChannelRegistration,
  type SessionAgentOutputChannelService,
} from "@firegrid/protocol/channels"
export {
  SessionAgentOutputChannelLive,
  sessionAgentOutputChannel,
} from "./channels/session-agent-output/index.ts"
export {
  SessionPermissionAutoApproveLayer,
  SessionPermissionChannelLive,
  SessionPermissionDecisionMissing,
  makeSessionPermissionChannel,
} from "./channels/session-permission/index.ts"
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
  HostSessionsCreateOrLoadChannelLive,
} from "./channels/host-sessions-create-or-load-live.ts"

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
} from "@firegrid/protocol/launch"

export { RuntimeIngressError } from "@firegrid/runtime/errors"
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
  // TODO(tf-9sx9): lane 2 is migrating current consumers; keep this export until
  // that PR lands and the public-barrel compatibility window can close.
  hostProjectionObserver,
  type HostProjectionObserverOptions,
} from "./projection-observer.ts"
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
