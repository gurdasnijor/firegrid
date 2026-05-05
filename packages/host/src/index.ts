// @durable-agent-substrate/host — public root surface.
//
// launchable-substrate-host.PACKAGING.4
// launchable-substrate-host.PACKAGING.8
// launchable-substrate-host.PACKAGING.9
// launchable-substrate-host.HOST_PROCESS.8
//
// The host root exports the launchable Effect-native API: boot
// plans, constructors, Live layer, profile, and the SubstrateHost
// Tag. Host-managed timer and scheduled-work subscriber programs
// are wired through SubstrateHostLive and gated by the profile.
// Network host diagnostics are deferred — the first lifecycle
// status surface is in-process and read-only — and the
// withHost-style process-runner helper remains a later concern.
// Embedded Durable Streams dev-server ownership lives in this
// package; no separate CLI/dev package is introduced.

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
