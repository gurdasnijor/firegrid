// @durable-agent-substrate/host — public root surface.
//
// launchable-substrate-host.PACKAGING.4
// launchable-substrate-host.PACKAGING.8
// launchable-substrate-host.PACKAGING.9
// launchable-substrate-host.HOST_PROCESS.8
//
// The host root exports the launchable Effect-native API: boot
// plans, constructors (including the development/test composition
// helper SubstrateHostBoot.withHost), the Live layer, the
// SubstrateHost Tag, and the Host Program Graph contract —
// HostProgramGraph plus HostPrograms Layer constructors and the
// narrow HostProgramRuntime service Tag. Host-managed runtime
// programs (timer / scheduled-work / projection-match subscribers
// and claim-before-side-effect operators) are wired through the
// `program: HostProgramGraph` option.
// Network host diagnostics and the process-runner / signal-
// handling concerns remain deferred to later slices. Embedded
// Durable Streams dev-server ownership lives in this package; no
// separate CLI/dev package is introduced.

export {
  bootPlanFromConfig,
  type ConfigError,
} from "./boot/from-config.js"

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
  HostProgramRuntime,
  type HostProgramRuntimeService,
} from "./host/host-program-runtime.js"

export {
  SubstrateHostLive,
  type SubstrateHostLiveOptions,
} from "./host/live.js"

export {
  HostProgramGraph,
} from "./host/program-graph.js"

export {
  HostPrograms,
  type GraphProjectionMatchEvaluator,
} from "./host/programs.js"

export {
  SubstrateHost,
  type SubstrateHostService,
  type SubstrateHostStreamIdentity,
} from "./host/service.js"
