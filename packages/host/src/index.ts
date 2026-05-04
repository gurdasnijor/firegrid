// @durable-agent-substrate/host — public root surface.
//
// launchable-substrate-host.PACKAGING.4
// launchable-substrate-host.PACKAGING.8
// launchable-substrate-host.PACKAGING.9
// launchable-substrate-host.HOST_PROCESS.8
//
// v1 host root exports the launchable Effect-native API (boot plans,
// constructors, Live layer, profile placeholder) needed by Slices 4-6.
// Subscriber/operator wiring lands in Slice 5; HTTP diagnostics + the
// withHost dev helper land in Slice 6. Embedded Durable Streams
// dev-server ownership lives in this package; no separate CLI/dev
// package is introduced.

export {
  bootPlanFromConfig,
  type ConfigError,
} from "./boot/from-config.js"

export { buildHostHeaders, type HeaderInput } from "./boot/headers.js"

export { generateProcessId } from "./boot/identity.js"

export {
  bootModeOf,
  type AttachedHostPlan,
  type BootMode,
  type EmbeddedDevHostPlan,
  type SubstrateHostBootPlan,
} from "./boot/plan.js"

export {
  SubstrateHostBoot,
  type AttachedHostOptions,
  type EmbeddedDevHostOptions,
} from "./host/constructors.js"

export {
  SubstrateHostLive,
  type SubstrateHostLiveOptions,
} from "./host/live.js"

export { emptyProfile, type SubstrateHostProfile } from "./host/profile.js"

export {
  SubstrateHost,
  type SubstrateHostService,
  type SubstrateHostStreamIdentity,
} from "./host/service.js"
