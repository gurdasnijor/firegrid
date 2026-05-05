import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Context, Effect, Layer } from "effect"
import { bootModeOf, type SubstrateHostBootPlan } from "../boot/plan.js"
import { HostProgramRuntime } from "./host-program-runtime.js"
import type { HostProgramGraph } from "./program-graph.js"
import { emptyProfile, type SubstrateHostProfile } from "./profile.js"
import {
  SubstrateHost,
  type SubstrateHostService,
  type SubstrateHostStreamIdentity,
} from "./service.js"
import {
  makeSubscriberLiveness,
  SubscriberLiveness,
  type SubscriberKind,
  type SubscriberLivenessService,
} from "./subscribers/liveness.js"
import { runScheduledWorkSubscriberProgram } from "./subscribers/scheduled-work.js"
import { runTimerSubscriberProgram } from "./subscribers/timer.js"

// SubscriberLiveness is a package-internal Tag — it is intentionally
// NOT re-exported from `@durable-agent-substrate/host`'s root entry
// point, and the package does not expose a subpath export for it.
// Tests reach it through internal relative imports of the host
// source modules. Public-facing factories therefore narrow the
// layer's output type to `Layer<SubstrateHost>` so the
// SubscriberLiveness symbol cannot leak into external consumers'
// type signatures. Internal callers (tests) use
// `_internalSubstrateHostLive` to keep the wider output in the
// type system.

// launchable-substrate-host.HOST_PROCESS.1
// launchable-substrate-host.HOST_PROCESS.3
// launchable-substrate-host.HOST_PROCESS.8
// launchable-substrate-host.HOST_CONFIGURATION.5
// launchable-substrate-host.HOST_CONFIGURATION.6
// launchable-substrate-host.AUTHORITY_BOUNDARY.2
// effect-native-api.EFFECT_SERVICES.9
//
// SubstrateHostLive is the scoped Effect layer that resolves a
// SubstrateHost from a SubstrateHostBootPlan. Embedded-dev mode owns
// the DurableStreamTestServer lifetime through the layer scope; attached
// mode joins an existing Durable Streams endpoint and does NOT start or
// own the remote process.
//
// The layer also forks per-kind subscriber runner programs into
// the same layer scope when enabled by the profile, and seeds the
// package-internal SubscriberLiveness service. The liveness Tag is
// not re-exported from the host root and not exposed as a subpath
// — only internal modules in this package see it — so callers
// cannot mistake liveness for durable subscriber progress
// authority.

class HostStartupError extends Error {
  readonly _tag = "HostStartupError"
  constructor(reason: string, cause?: unknown) {
    super(`substrate host startup failed: ${reason}${cause ? `: ${String(cause)}` : ""}`)
  }
}

const acquireEmbeddedServer = (host: string, port: number) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const server = new DurableStreamTestServer({ host, port })
        await server.start()
        return server
      },
      catch: (cause) =>
        new HostStartupError("embedded DurableStreamTestServer", cause),
    }),
    // Scope finalization stops the embedded server. Process-signal
    // handling (SIGINT/SIGTERM → scope close) remains a higher-
    // runtime concern and is not part of this slice.
    (server) => Effect.promise(() => server.stop()),
  )

const ensureSubstrateStream = (streamUrl: string, contentType: string) =>
  Effect.tryPromise({
    try: () => DurableStream.create({ url: streamUrl, contentType }),
    catch: (cause) =>
      new HostStartupError(`creating substrate stream ${streamUrl}`, cause),
  })

export interface SubstrateHostLiveOptions<E = never, GraphRIn = HostProgramRuntime> {
  readonly profile?: SubstrateHostProfile
  // launchable-substrate-host.RUNTIME_COMPOSITION.1
  // launchable-substrate-host.RUNTIME_COMPOSITION.2
  // launchable-substrate-host.RUNTIME_COMPOSITION.3
  // launchable-substrate-host.SERVER_RUNTIME_API.3
  //
  // When `program` is supplied the host launches the supplied
  // HostProgramGraph and ignores the transitional `profile`
  // subscriber booleans entirely (the host cannot inspect an opaque
  // Layer composition to know which kinds it covers). When only
  // `profile` is supplied, Slice 5 boolean wiring stays unchanged.
  //
  // The graph's `RIn` typically includes HostProgramRuntime (which
  // the host injects at launch time). It may additionally include
  // adapter / provider service Tags that the graph author closed
  // over but did not pre-provide. Those extra requirements remain
  // in the resulting host layer's `RIn` (computed as
  // `Exclude<GraphRIn, HostProgramRuntime>`) for the caller to
  // satisfy via Layer.provide before composing the host layer into
  // their program. Graph construction `E` flows through to the host
  // layer's typed error channel; startup defects from server /
  // stream creation are kept separate via inline orDie at their
  // call sites.
  readonly program?: HostProgramGraph<E, GraphRIn>
  readonly contentType?: string
}

const enabledKindsFrom = (profile: SubstrateHostProfile): ReadonlyArray<SubscriberKind> => {
  const kinds: Array<SubscriberKind> = []
  if (profile.subscribers?.timer === true) kinds.push("timer")
  if (profile.subscribers?.scheduledWork === true) kinds.push("scheduled_work")
  return kinds
}

export const _internalSubstrateHostLive = <
  E = never,
  GraphRIn = HostProgramRuntime,
>(
  plan: SubstrateHostBootPlan,
  options: SubstrateHostLiveOptions<E, GraphRIn> = {},
): Layer.Layer<
  SubstrateHost | SubscriberLiveness,
  E,
  Exclude<GraphRIn, HostProgramRuntime>
> => {
  const profile = options.profile ?? emptyProfile
  const contentType = options.contentType ?? "application/json"
  const bootMode = bootModeOf(plan)

  return Layer.scopedContext(
    Effect.gen(function* () {
      let streamIdentity: SubstrateHostStreamIdentity
      if (plan._tag === "EmbeddedDevHost") {
        // Embedded server / stream creation failures remain host-
        // startup defects — orDie at the call sites so they stay out
        // of the layer's typed error channel. Graph construction E
        // (below) is left to flow through.
        const server = yield* acquireEmbeddedServer(
          plan.durableStreams.host,
          plan.durableStreams.port,
        ).pipe(Effect.orDie)
        const url = new URL(server.url)
        const streamUrl = `${server.url}/substrate/${plan.durableStreams.streamName}`
        yield* ensureSubstrateStream(streamUrl, contentType).pipe(Effect.orDie)
        streamIdentity = {
          streamUrl,
          streamName: plan.durableStreams.streamName,
          host: plan.durableStreams.host,
          port: Number(url.port) || plan.durableStreams.port,
        }
      } else {
        streamIdentity = { streamUrl: plan.streamUrl }
      }

      const hostService: SubstrateHostService = {
        processId: plan.processId,
        bootMode,
        streamIdentity,
        headers: plan.headers,
        profile,
        bootPlan: plan,
      }

      // Build the package-internal liveness state seeded from the
      // profile-enabled kinds. When `program` supersedes the profile
      // booleans, no liveness entries are seeded — the
      // SubscriberLiveness snapshot is empty by design (Q4: liveness
      // is a transitional concern and not part of the public
      // HostProgramGraph contract).
      const enabledKinds =
        options.program !== undefined ? [] : enabledKindsFrom(profile)
      const livenessInternal = yield* makeSubscriberLiveness(enabledKinds)
      const livenessPublic: SubscriberLivenessService = {
        snapshot: livenessInternal.snapshot,
      }

      if (options.program !== undefined) {
        // Graph path: provide HostProgramRuntime into the program
        // graph's runtime and build the layer inside the host scope.
        // HostPrograms helpers fork their long-running runners via
        // Layer.scopedDiscard / Effect.forkScoped, so Layer.build
        // materializes them as fibers attached to this scope; layer
        // finalization on scope close interrupts and awaits them.
        // Graph construction `E` flows through to the host layer's
        // typed error channel rather than being dieed.
        const runtimeLayer = Layer.succeed(HostProgramRuntime, {
          streamUrl: streamIdentity.streamUrl,
          contentType,
          processId: plan.processId,
          streamIdentity,
        })
        const wired = options.program.layer.pipe(
          Layer.provide(runtimeLayer),
        ) as Layer.Layer<never, E, Exclude<GraphRIn, HostProgramRuntime>>
        yield* Layer.build(wired)
      } else {
        // Profile (boolean) path — Slice 5 unchanged. Each runner is
        // forkScoped, so layer finalization interrupts and awaits
        // cleanly. Runners never resolve through a control plane:
        // terminalization stays inside the substrate-owned
        // single-shot subscriber Effects.
        if (profile.subscribers?.timer === true) {
          yield* Effect.forkScoped(
            runTimerSubscriberProgram({
              streamUrl: streamIdentity.streamUrl,
              contentType,
              liveness: livenessInternal.handle("timer"),
            }),
          )
        }
        if (profile.subscribers?.scheduledWork === true) {
          yield* Effect.forkScoped(
            runScheduledWorkSubscriberProgram({
              streamUrl: streamIdentity.streamUrl,
              contentType,
              liveness: livenessInternal.handle("scheduled_work"),
            }),
          )
        }
      }

      return Context.empty().pipe(
        Context.add(SubstrateHost, hostService),
        Context.add(SubscriberLiveness, livenessPublic),
      )
    }),
  )
}

// Public host layer — narrow output type. Internally the layer also
// provides SubscriberLiveness, but that Tag is package-internal and
// must not leak into external consumers' type signatures. Graph E /
// R generics propagate through to the public Layer signature so
// program failures surface in the host launch error channel and
// adapter R requirements remain satisfiable via Layer.provide.
export const SubstrateHostLive = <
  E = never,
  GraphRIn = HostProgramRuntime,
>(
  plan: SubstrateHostBootPlan,
  options: SubstrateHostLiveOptions<E, GraphRIn> = {},
): Layer.Layer<SubstrateHost, E, Exclude<GraphRIn, HostProgramRuntime>> =>
  _internalSubstrateHostLive(plan, options) as Layer.Layer<
    SubstrateHost,
    E,
    Exclude<GraphRIn, HostProgramRuntime>
  >
