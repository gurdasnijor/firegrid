import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Context, Effect, Layer } from "effect"
import { bootModeOf, type SubstrateHostBootPlan } from "../boot/plan.ts"
import { HostProgramRuntime } from "./host-program-runtime.ts"
import type { HostProgramGraph } from "./program-graph.ts"
import {
  SubstrateHost,
  type SubstrateHostService,
  type SubstrateHostStreamIdentity,
} from "./service.ts"

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
// The layer launches an optional HostProgramGraph inside the same
// scope. Timer / scheduled-work subscribers, projection-match
// subscribers, and operators are all ordinary HostProgramGraph
// layers; there is no separate profile or mode switch.

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
  // launchable-substrate-host.RUNTIME_COMPOSITION.1
  // launchable-substrate-host.RUNTIME_COMPOSITION.2
  // launchable-substrate-host.RUNTIME_COMPOSITION.3
  // launchable-substrate-host.SERVER_RUNTIME_API.3
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

export const SubstrateHostLive = <
  E = never,
  GraphRIn = HostProgramRuntime,
>(
  plan: SubstrateHostBootPlan,
  options: SubstrateHostLiveOptions<E, GraphRIn> = {},
): Layer.Layer<SubstrateHost, E, Exclude<GraphRIn, HostProgramRuntime>> => {
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
        ...(options.program !== undefined
          ? { programName: options.program.name }
          : {}),
        streamIdentity,
        bootPlan: plan,
      }

      if (options.program !== undefined) {
        // Provide HostProgramRuntime into the program graph's runtime
        // and build the layer inside the host scope.
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
        )
        yield* Layer.build(wired)
      }

      return Context.empty().pipe(
        Context.add(SubstrateHost, hostService),
      )
    }),
  )
}
