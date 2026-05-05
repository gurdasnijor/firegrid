import { generateProcessId } from "../boot/identity.ts"
import type {
  AttachedHostPlan,
  EmbeddedDevHostPlan,
} from "../boot/plan.ts"
import type { HostProgramRuntime } from "./host-program-runtime.ts"
import type { SubstrateHostLiveOptions } from "./live.ts"
import type { HostProgramGraph } from "./program-graph.ts"

// launchable-substrate-host.HOST_CONFIGURATION.3
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
  readonly program?: HostProgramGraph<E, GraphRIn>
  readonly contentType?: string
}

export const buildAttachedPlan = <E, GraphRIn>(
  opts: AttachedHostOptions<E, GraphRIn>,
): AttachedHostPlan => ({
  _tag: "AttachedHost",
  processId: opts.processId ?? generateProcessId(),
  streamUrl: opts.streamUrl,
})

export const buildEmbeddedPlan = <E, GraphRIn>(
  opts: EmbeddedDevHostOptions<E, GraphRIn>,
): EmbeddedDevHostPlan => ({
  _tag: "EmbeddedDevHost",
  processId: opts.processId ?? generateProcessId(),
  durableStreams: {
    host: opts.durableStreamsHost ?? "127.0.0.1",
    port: opts.durableStreamsPort ?? 0,
    streamName: opts.streamName ?? "substrate",
  },
})

export const liveOptionsFrom = <E, GraphRIn>(opts: {
  readonly program?: HostProgramGraph<E, GraphRIn>
  readonly contentType?: string
}): SubstrateHostLiveOptions<E, GraphRIn> => ({
  ...(opts.program !== undefined ? { program: opts.program } : {}),
  ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
})
