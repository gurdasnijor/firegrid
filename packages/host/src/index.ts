// @durable-agent-substrate/host — public root surface.
//
// launchable-substrate-host.PACKAGING.4
// launchable-substrate-host.PACKAGING.8
// launchable-substrate-host.PACKAGING.9
// launchable-substrate-host.HOST_PROCESS.8
//
// The host root exports the launchable Effect-native API: boot
// plans, constructors (including the development/test composition
// helper SubstrateHostBoot.withHost), the Live layer, profile, and
// the SubstrateHost Tag. Host-managed timer and scheduled-work
// subscriber programs are wired through SubstrateHostLive and
// gated by the profile. Network host diagnostics and the
// process-runner / signal-handling concerns remain deferred to
// later slices. Embedded Durable Streams dev-server ownership
// lives in this package; no separate CLI/dev package is
// introduced.

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
  type WithHostOptions,
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
