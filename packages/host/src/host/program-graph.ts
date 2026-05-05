import type { Layer } from "effect"
import type { HostProgramRuntime } from "./host-program-runtime.js"

// launchable-substrate-host.RUNTIME_COMPOSITION.1
// launchable-substrate-host.RUNTIME_COMPOSITION.2
// launchable-substrate-host.RUNTIME_COMPOSITION.3
// launchable-substrate-host.RUNTIME_COMPOSITION.8
// launchable-substrate-host.RUNTIME_COMPOSITION.9
// launchable-substrate-host.SERVER_RUNTIME_API.1
// launchable-substrate-host.SERVER_RUNTIME_API.2
// launchable-substrate-host.SERVER_RUNTIME_API.3
//
// HostProgramGraph is a named ordinary Effect Layer composition. It
// is the executable shape the launchable host runs against durable
// state: subscriber programs, projection-match evaluators, operator
// programs, event-plane layers, and adapter service layers, all
// composed through ordinary Layer.mergeAll / Layer.provide. It is
// not a registry, not a host mutation endpoint, not a durable
// catalog. It is supplied in process at host startup; serialized
// configuration may select a known graph by key from a caller-
// supplied local map, but the substrate does not load graphs from
// durable state and does not import modules dynamically.
//
// `layer` is launched for its scoped effects — its services-output
// channel is intentionally `never`. HostPrograms helpers return
// `Layer.scopedDiscard`-shaped layers; long-running runner fibers
// are forked into the surrounding scope and torn down by Effect
// finalization.
//
// `RIn` defaults to `HostProgramRuntime`, the narrow host-owned
// runtime service the host injects at launch time. An incompletely
// wired graph can keep extra requirements in `RIn` while tests or
// applications provide them via `Layer.provide`. The graph handed
// to SubstrateHostLive should be fully wired so that, after the
// host provides HostProgramRuntime, the launched layer has
// `RIn = never`. Construction failures flow through `E` into the
// host launch error channel rather than being converted to defects
// by default.

export interface HostProgramGraph<E = never, RIn = HostProgramRuntime> {
  readonly name: string
  readonly layer: Layer.Layer<never, E, RIn>
}

export const HostProgramGraph = {
  define: <E, RIn>(input: {
    readonly name: string
    readonly layer: Layer.Layer<never, E, RIn>
  }): HostProgramGraph<E, RIn> => ({
    name: input.name,
    layer: input.layer,
  }),
} as const
