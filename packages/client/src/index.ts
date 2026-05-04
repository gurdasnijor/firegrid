// @durable-agent-substrate/client — public root surface.
//
// launchable-substrate-host.CLIENT_SURFACE.1
// launchable-substrate-host.CLIENT_SURFACE.2
// launchable-substrate-host.CLIENT_SURFACE.7
// launchable-substrate-host.PACKAGING.3
// launchable-substrate-host.PACKAGING.7
//
// Effect-native client tag, live layer factory, work intent surface,
// and curated read handle types. Operator/testing/diagnostic escape
// hatches will live under explicit subpaths in later slices
// (CLIENT_SURFACE.8); the v1 root surface is intentionally narrow.
export {
  SubstrateClient,
  SubstrateClientLive,
  type SubstrateClientConfig,
  type SubstrateClientService,
} from "./client/service.js"

export type {
  DeclareWorkInput,
  DeclareWorkResult,
  SubstrateClientWork,
  SubstrateWorkHandle,
  WorkObservation,
} from "./client/work.js"
