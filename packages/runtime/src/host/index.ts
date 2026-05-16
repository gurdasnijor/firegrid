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

export {
  RuntimeObservationSourceNames,
  type RuntimeAgentOutputObservation,
  type RuntimeObservationSourceName,
} from "../source-registration/index.ts"
export { RuntimeIngressError } from "../runtime-errors.ts"
export {
  localProcessSpawnEnvFromHostEnv,
  type LocalProcessSandboxProviderOptions,
} from "../agent-event-pipeline/sources/sandbox/local-process.ts"
export {
  appendRuntimeIngress,
  RuntimeStartCapabilityLive,
  startRuntime,
} from "./commands.ts"
export {
  FiregridLocalHostLive,
  FiregridRuntimeHostLive,
  FiregridRuntimeHostWithWorkflowLive,
} from "./layers.ts"
export {
  FiregridRuntimeHostFromConfig,
  FiregridRuntimeHostWithWorkflowFromConfig,
  FiregridRuntimeHostWithWorkflowFromConfigWithEnvPolicy,
  RuntimeHostTopologyFromConfig,
} from "./config-live.ts"
export { RuntimeHostAgentToolHostLive } from "./agent-tool-host-live.ts"
