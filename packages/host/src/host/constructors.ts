import { Effect, Layer } from "effect"
import {
  bootPlanFromConfig,
  type ConfigError,
} from "../boot/from-config.js"
import { buildHostHeaders } from "../boot/headers.js"
import { generateProcessId } from "../boot/identity.js"
import type {
  AttachedHostPlan,
  EmbeddedDevHostPlan,
  SubstrateHostBootPlan,
} from "../boot/plan.js"
import { SubstrateHostLive, type SubstrateHostLiveOptions } from "./live.js"
import type { SubstrateHostProfile } from "./profile.js"
import { SubstrateHost } from "./service.js"

// launchable-substrate-host.HOST_CONFIGURATION.1
// launchable-substrate-host.HOST_CONFIGURATION.2
// launchable-substrate-host.HOST_CONFIGURATION.3
// launchable-substrate-host.HOST_CONFIGURATION.4
// launchable-substrate-host.HOST_CONFIGURATION.10
// launchable-substrate-host.HOST_CONFIGURATION.11
//
// Slice 4 host constructors: embeddedDev / attached for the supported
// boot modes, plus attachedFromConfig and bootPlanFromConfig for
// Effect Config decoding. Authorization > bearerToken precedence and
// bare-token Bearer materialization are honored. A withHost-style
// composition helper is intentionally NOT exported here; it lands in
// a later slice that owns process-runner concerns.

export interface AttachedHostOptions {
  readonly streamUrl: string
  readonly processId?: string
  readonly authorization?: string
  readonly bearerToken?: string
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly profile?: SubstrateHostProfile
  readonly contentType?: string
}

export interface EmbeddedDevHostOptions {
  readonly streamName?: string
  readonly durableStreamsHost?: string
  readonly durableStreamsPort?: number
  readonly processId?: string
  readonly authorization?: string
  readonly bearerToken?: string
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly profile?: SubstrateHostProfile
  readonly contentType?: string
}

const buildAttachedPlan = (opts: AttachedHostOptions): AttachedHostPlan => ({
  _tag: "AttachedHost",
  processId: opts.processId ?? generateProcessId(),
  headers: buildHostHeaders({
    ...(opts.authorization !== undefined
      ? { authorization: opts.authorization }
      : {}),
    ...(opts.bearerToken !== undefined
      ? { bearerToken: opts.bearerToken }
      : {}),
    ...(opts.extraHeaders !== undefined ? { extra: opts.extraHeaders } : {}),
  }),
  streamUrl: opts.streamUrl,
})

const buildEmbeddedPlan = (
  opts: EmbeddedDevHostOptions,
): EmbeddedDevHostPlan => ({
  _tag: "EmbeddedDevHost",
  processId: opts.processId ?? generateProcessId(),
  headers: buildHostHeaders({
    ...(opts.authorization !== undefined
      ? { authorization: opts.authorization }
      : {}),
    ...(opts.bearerToken !== undefined
      ? { bearerToken: opts.bearerToken }
      : {}),
    ...(opts.extraHeaders !== undefined ? { extra: opts.extraHeaders } : {}),
  }),
  durableStreams: {
    host: opts.durableStreamsHost ?? "127.0.0.1",
    port: opts.durableStreamsPort ?? 0,
    streamName: opts.streamName ?? "substrate",
  },
})

const liveOptionsFrom = (opts: {
  readonly profile?: SubstrateHostProfile
  readonly contentType?: string
}): SubstrateHostLiveOptions => ({
  ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
  ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
})

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
} as const
