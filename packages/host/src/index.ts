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
} from "./boot/from-config.ts"

export { generateProcessId } from "./boot/identity.ts"

export {
  bootModeOf,
  type AttachedHostPlan,
  type BootMode,
  type EmbeddedDevHostPlan,
  type SubstrateHostBootPlan,
} from "./boot/plan.ts"

export {
  SubstrateHostBoot,
  type AttachedHostOptions,
  type EmbeddedDevHostOptions,
  type WithHostOptions,
} from "./host/constructors.ts"

export {
  HostProgramRuntime,
  type HostProgramRuntimeService,
} from "./host/host-program-runtime.ts"

export {
  SubstrateHostLive,
  type SubstrateHostLiveOptions,
} from "./host/live.ts"

export {
  HostProgramGraph,
} from "./host/program-graph.ts"

export {
  HostPrograms,
  type GraphProjectionMatchEvaluator,
} from "./host/programs.ts"

export {
  SubstrateHost,
  type SubstrateHostService,
  type SubstrateHostStreamIdentity,
} from "./host/service.ts"
