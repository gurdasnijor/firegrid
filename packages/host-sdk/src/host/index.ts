// firegrid-runtime-boundary-reconciliation.HOST_HARDENING.1
export type {
  RuntimeHostTopologyOptions,
  StartRuntimeOptions,
  StartRuntimeResult,
} from "./types.ts"

export {
  UnknownChannelTarget,
  channelMetadata,
  findRuntimeContextMcpChannel,
  makeRuntimeContextMcpChannelCatalog,
  RuntimeContextMcpChannelCatalog,
  RuntimeContextMcpChannelCatalogLive,
  type ChannelMetadata,
  type RuntimeContextMcpChannelCatalogService,
} from "./channel.ts"
export * from "@firegrid/protocol/channels"
export {
  SessionAgentOutputChannelLive,
} from "./channels/session-agent-output/index.ts"
export {
  SessionPermissionAutoApproveLayer,
  SessionPermissionChannelLive,
  SessionPermissionDecisionMissing,
  makeSessionPermissionChannel,
} from "./channels/session-permission/index.ts"
export {
  SessionSelfChannelsLive,
} from "./channels/session-self/index.ts"
export {
  HostSessionsCreateOrLoadChannelLive,
} from "./channels/host-sessions-create-or-load-live.ts"
export { HostControlChannelsLive } from "./channels/host-control/index.ts"
export {
  VerifiedWebhookFactCallerOwnedFactStreamsLive,
  VerifiedWebhookFactChannelLive,
  verifiedWebhookFactChannel,
  verifiedWebhookFactRows,
} from "./channels/verified-webhook/index.ts"

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
  eventChannel,
  eventChannelFromCollection,
} from "./event-channel.ts"
export {
  stateChangesChannel,
  stateChangesChannelFromCollection,
} from "./state-changes-channel.ts"
export {
  dmChannel,
  humanChannelPair,
  notificationChannel,
} from "./human-channel.ts"
export {
  sessionLogChannel,
  sessionLogChannelFromCollection,
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
