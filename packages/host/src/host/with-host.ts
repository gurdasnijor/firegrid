import {
  type SubstrateClient,
  SubstrateClientLive,
} from "@durable-agent-substrate/client"
import { Effect, Layer } from "effect"
import {
  buildAttachedPlan,
  buildEmbeddedPlan,
  liveOptionsFrom,
  type AttachedHostOptions,
  type EmbeddedDevHostOptions,
} from "./boot-options.ts"
import type { HostProgramRuntime } from "./host-program-runtime.ts"
import { SubstrateHostLive } from "./live.ts"
import { SubstrateHost } from "./service.ts"

// launchable-substrate-host.PACKAGING.6
// launchable-substrate-host.RUNTIME_COMPOSITION.5
// launchable-substrate-host.RUNTIME_COMPOSITION.6
// launchable-substrate-host.RUNTIME_COMPOSITION.7
// launchable-substrate-host.CLIENT_COMPATIBILITY.4
// launchable-substrate-host.NO_CONTROL_PLANE.1
//
// SubstrateHostBoot.withHost is a development/test composition
// helper. It runs an Effect program inside a single scope that
// provides both SubstrateHost and SubstrateClient — the same
// SubstrateClient capability exposed by the standalone client
// package, configured against the host's resolved streamIdentity.
//
// The helper is intentionally narrow: it owns local scope
// composition only. It does not introduce mutation endpoints, a
// network diagnostics listener, a runtime registry, dynamic
// profile loading, or any non-Effect surface. Process-signal
// handling and host lifecycle status surfaces remain deferred to
// later slices and must not be claimed here.

// `clientId` is the SubstrateClient's identity for the program's
// duration; it mirrors the standalone SubstrateClientLive config.
//
// The mode discriminator selects boot mode. When omitted, withHost
// defaults to embedded-dev (matching bootPlanFromConfig's fallback
// when SUBSTRATE_STREAM_URL is missing). Attached mode requires
// streamUrl on the options object — structurally enforced by
// AttachedHostOptions.
export type WithHostEmbeddedDevOptions<
  E = never,
  GraphRIn = HostProgramRuntime,
> = EmbeddedDevHostOptions<E, GraphRIn> & {
  readonly mode?: "embedded-dev"
  readonly clientId: string
}

export type WithHostAttachedOptions<
  E = never,
  GraphRIn = HostProgramRuntime,
> = AttachedHostOptions<E, GraphRIn> & {
  readonly mode: "attached"
  readonly clientId: string
}

export type WithHostOptions<E = never, GraphRIn = HostProgramRuntime> =
  | WithHostEmbeddedDevOptions<E, GraphRIn>
  | WithHostAttachedOptions<E, GraphRIn>

const buildHostLayer = <E, GraphRIn>(
  options: WithHostOptions<E, GraphRIn>,
): Layer.Layer<SubstrateHost, E, Exclude<GraphRIn, HostProgramRuntime>> =>
  options.mode === "attached"
    ? SubstrateHostLive<E, GraphRIn>(
        buildAttachedPlan(options),
        liveOptionsFrom(options),
      )
    : SubstrateHostLive<E, GraphRIn>(
        buildEmbeddedPlan(options),
        liveOptionsFrom(options),
      )

const buildClientLayer = <E, GraphRIn>(
  options: WithHostOptions<E, GraphRIn>,
): Layer.Layer<SubstrateClient, never, SubstrateHost> =>
  Layer.unwrapEffect(
    Effect.map(SubstrateHost, (host) =>
      SubstrateClientLive({
        streamUrl: host.streamIdentity.streamUrl,
        clientId: options.clientId,
        ...(options.contentType !== undefined
          ? { contentType: options.contentType }
          : {}),
      }),
    ),
  )

// withHost composes the host layer (which resolves streamIdentity
// at scope acquisition) with a SubstrateClient layer that derives
// its streamUrl from the resolved host. The combined layer
// provides both Tags so the program can yield* either. There is no
// extra writer surface and no network listener — the return value
// is an Effect, not a server handle.
//
// `GraphE` / `GraphRIn` flow from the optional HostProgramGraph
// `program` option through the host layer. Graph construction
// failures surface as Exit failures in the returned Effect's error
// channel; adapter / provider service requirements (the residual
// after HostProgramRuntime is provided by the host) remain in the
// returned Effect's RIn for the caller to satisfy.
export const withHost = <
  A,
  E,
  R,
  GraphE = never,
  GraphRIn = HostProgramRuntime,
>(
  program: Effect.Effect<A, E, R>,
  options: WithHostOptions<GraphE, GraphRIn>,
): Effect.Effect<
  A,
  E | GraphE,
  | Exclude<GraphRIn, HostProgramRuntime>
  | Exclude<R, SubstrateClient | SubstrateHost>
> => {
  const composed = Layer.provideMerge(
    buildClientLayer(options),
    buildHostLayer(options),
  )
  return Effect.scoped(program.pipe(Effect.provide(composed)))
}
