import { buildHostHeaders } from "../boot/headers.js"
import { generateProcessId } from "../boot/identity.js"
import type {
  AttachedHostPlan,
  EmbeddedDevHostPlan,
} from "../boot/plan.js"
import type { HostProgramRuntime } from "./host-program-runtime.js"
import type { SubstrateHostLiveOptions } from "./live.js"
import type { HostProgramGraph } from "./program-graph.js"
import type { SubstrateHostProfile } from "./profile.js"

// launchable-substrate-host.HOST_CONFIGURATION.3
// launchable-substrate-host.HOST_CONFIGURATION.10
// launchable-substrate-host.HOST_CONFIGURATION.11
//
// Shared option types and plan builders for the host constructors
// (`SubstrateHostBoot.{attached, embeddedDev, withHost, ...}`). These
// were previously private to constructors.ts; lifting them out lets
// the withHost composition helper reuse the exact same boot-plan
// derivation without creating a circular dependency between
// constructors.ts and with-host.ts.

export interface AttachedHostOptions<
  E = never,
  GraphRIn = HostProgramRuntime,
> {
  readonly streamUrl: string
  readonly processId?: string
  readonly authorization?: string
  readonly bearerToken?: string
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly profile?: SubstrateHostProfile
  readonly program?: HostProgramGraph<E, GraphRIn>
  readonly contentType?: string
}

export interface EmbeddedDevHostOptions<
  E = never,
  GraphRIn = HostProgramRuntime,
> {
  readonly streamName?: string
  readonly durableStreamsHost?: string
  readonly durableStreamsPort?: number
  readonly processId?: string
  readonly authorization?: string
  readonly bearerToken?: string
  readonly extraHeaders?: Readonly<Record<string, string>>
  readonly profile?: SubstrateHostProfile
  readonly program?: HostProgramGraph<E, GraphRIn>
  readonly contentType?: string
}

export const buildAttachedPlan = <E, GraphRIn>(
  opts: AttachedHostOptions<E, GraphRIn>,
): AttachedHostPlan => ({
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

export const buildEmbeddedPlan = <E, GraphRIn>(
  opts: EmbeddedDevHostOptions<E, GraphRIn>,
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

export const liveOptionsFrom = <E, GraphRIn>(opts: {
  readonly profile?: SubstrateHostProfile
  readonly program?: HostProgramGraph<E, GraphRIn>
  readonly contentType?: string
}): SubstrateHostLiveOptions<E, GraphRIn> => ({
  ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
  ...(opts.program !== undefined ? { program: opts.program } : {}),
  ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
})
