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
import {
  _internalSubstrateHostLive,
  SubstrateHostLive,
} from "./live.js"
import type { SubstrateHostProfile } from "./profile.js"
import { SubstrateHost } from "./service.js"
import type { SubscriberLiveness } from "./subscribers/liveness.js"
import { withHost, type WithHostOptions } from "./with-host.js"

// launchable-substrate-host.HOST_CONFIGURATION.1
// launchable-substrate-host.HOST_CONFIGURATION.2
// launchable-substrate-host.HOST_CONFIGURATION.3
// launchable-substrate-host.HOST_CONFIGURATION.4
// launchable-substrate-host.HOST_CONFIGURATION.10
// launchable-substrate-host.HOST_CONFIGURATION.11
// launchable-substrate-host.PACKAGING.6
//
// Host constructors namespace: embeddedDev / attached for the
// supported boot modes, attachedFromConfig and bootPlanFromConfig
// for Effect Config decoding, and withHost for development/test
// composition. Authorization > bearerToken precedence and bare-
// token Bearer materialization are honored. Plan and option
// helpers live in boot-options.ts so constructors.ts and
// with-host.ts share the same derivation without a cyclic import.

export type {
  AttachedHostOptions,
  EmbeddedDevHostOptions,
} from "./boot-options.js"

export const SubstrateHostBoot = {
  // launchable-substrate-host.HOST_CONFIGURATION.2
  // launchable-substrate-host.HOST_CONFIGURATION.6
  attached: (opts: AttachedHostOptions): Layer.Layer<SubstrateHost> =>
    SubstrateHostLive(buildAttachedPlan(opts), liveOptionsFrom(opts)),

  // launchable-substrate-host.HOST_CONFIGURATION.1
  // launchable-substrate-host.HOST_CONFIGURATION.5
  embeddedDev: (opts: EmbeddedDevHostOptions = {}): Layer.Layer<SubstrateHost> =>
    SubstrateHostLive(buildEmbeddedPlan(opts), liveOptionsFrom(opts)),

  // launchable-substrate-host.HOST_CONFIGURATION.4
  // attachedFromConfig builds an attached plan from Effect Config; if
  // `SUBSTRATE_STREAM_URL` is missing the underlying decoder selects
  // embedded-dev mode instead, matching the bootPlanFromConfig behaviour.
  attachedFromConfig: (
    opts: {
      readonly profile?: SubstrateHostProfile
      readonly contentType?: string
    } = {},
  ): Layer.Layer<SubstrateHost, ConfigError> =>
    Layer.unwrapEffect(
      Effect.map(bootPlanFromConfig, (plan: SubstrateHostBootPlan) =>
        SubstrateHostLive(plan, liveOptionsFrom(opts)),
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

// Package-internal constructors that retain SubscriberLiveness in
// the Layer's output type. NOT re-exported from the host root —
// host subscriber tests import this through internal relative paths. External
// consumers must use SubstrateHostBoot above, which narrows the
// public surface to Layer<SubstrateHost>.
export const _internalSubstrateHostBoot = {
  attached: (
    opts: AttachedHostOptions,
  ): Layer.Layer<SubstrateHost | SubscriberLiveness> =>
    _internalSubstrateHostLive(buildAttachedPlan(opts), liveOptionsFrom(opts)),

  embeddedDev: (
    opts: EmbeddedDevHostOptions = {},
  ): Layer.Layer<SubstrateHost | SubscriberLiveness> =>
    _internalSubstrateHostLive(buildEmbeddedPlan(opts), liveOptionsFrom(opts)),
} as const
