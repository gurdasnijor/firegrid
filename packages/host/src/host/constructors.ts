import { Effect, Layer } from "effect"
import {
  bootPlanFromConfig,
  type ConfigError,
} from "../boot/from-config.js"
import type { SubstrateHostBootPlan } from "../boot/plan.js"
import {
  buildAttachedPlan,
  buildEmbeddedPlan,
  liveOptionsFrom,
  type AttachedHostOptions,
  type EmbeddedDevHostOptions,
} from "./boot-options.js"
import type { HostProgramRuntime } from "./host-program-runtime.js"
import {
  SubstrateHostLive,
} from "./live.js"
import type { HostProgramGraph } from "./program-graph.js"
import { SubstrateHost } from "./service.js"
import { withHost, type WithHostOptions } from "./with-host.js"

// launchable-substrate-host.HOST_CONFIGURATION.1
// launchable-substrate-host.HOST_CONFIGURATION.2
// launchable-substrate-host.HOST_CONFIGURATION.3
// launchable-substrate-host.HOST_CONFIGURATION.4
// launchable-substrate-host.PACKAGING.6
//
// Host constructors namespace: embeddedDev / attached for the
// supported boot modes, attachedFromConfig and bootPlanFromConfig
// for Effect Config decoding, and withHost for development/test
// composition. Plan and option helpers live in boot-options.ts so
// constructors.ts and with-host.ts share the same derivation without
// a cyclic import. Auth/header transport is deferred.

export type {
  AttachedHostOptions,
  EmbeddedDevHostOptions,
} from "./boot-options.js"

export const SubstrateHostBoot = {
  // launchable-substrate-host.HOST_CONFIGURATION.2
  // launchable-substrate-host.HOST_CONFIGURATION.6
  attached: <E = never, GraphRIn = HostProgramRuntime>(
    opts: AttachedHostOptions<E, GraphRIn>,
  ): Layer.Layer<SubstrateHost, E, Exclude<GraphRIn, HostProgramRuntime>> =>
    SubstrateHostLive<E, GraphRIn>(
      buildAttachedPlan(opts),
      liveOptionsFrom(opts),
    ),

  // launchable-substrate-host.HOST_CONFIGURATION.1
  // launchable-substrate-host.HOST_CONFIGURATION.5
  embeddedDev: <E = never, GraphRIn = HostProgramRuntime>(
    opts: EmbeddedDevHostOptions<E, GraphRIn> = {},
  ): Layer.Layer<SubstrateHost, E, Exclude<GraphRIn, HostProgramRuntime>> =>
    SubstrateHostLive<E, GraphRIn>(
      buildEmbeddedPlan(opts),
      liveOptionsFrom(opts),
    ),

  // launchable-substrate-host.HOST_CONFIGURATION.4
  // attachedFromConfig builds an attached plan from Effect Config; if
  // `SUBSTRATE_STREAM_URL` is missing the underlying decoder selects
  // embedded-dev mode instead, matching the bootPlanFromConfig behaviour.
  attachedFromConfig: <E = never, GraphRIn = HostProgramRuntime>(
    opts: {
      readonly program?: HostProgramGraph<E, GraphRIn>
      readonly contentType?: string
    } = {},
  ): Layer.Layer<
    SubstrateHost,
    E | ConfigError,
    Exclude<GraphRIn, HostProgramRuntime>
  > =>
    Layer.unwrapEffect(
      Effect.map(bootPlanFromConfig, (plan: SubstrateHostBootPlan) =>
        SubstrateHostLive<E, GraphRIn>(plan, liveOptionsFrom(opts)),
      ),
    ),

  // launchable-substrate-host.HOST_CONFIGURATION.4
  // Re-export the Effect.Config decoder so callers can compose it
  // directly when they want the resolved plan as a value.
  bootPlanFromConfig,

  // launchable-substrate-host.PACKAGING.6
  // launchable-substrate-host.RUNTIME_COMPOSITION.5
  // launchable-substrate-host.RUNTIME_COMPOSITION.6
  // launchable-substrate-host.RUNTIME_COMPOSITION.7
  // launchable-substrate-host.CLIENT_COMPATIBILITY.4
  withHost,
} as const

export type { WithHostOptions } from "./with-host.js"
