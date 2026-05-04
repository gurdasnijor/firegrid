import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Layer } from "effect"
import { bootModeOf, type SubstrateHostBootPlan } from "../boot/plan.js"
import { emptyProfile, type SubstrateHostProfile } from "./profile.js"
import {
  SubstrateHost,
  type SubstrateHostService,
  type SubstrateHostStreamIdentity,
} from "./service.js"

// launchable-substrate-host.HOST_PROCESS.1
// launchable-substrate-host.HOST_PROCESS.8
// launchable-substrate-host.HOST_CONFIGURATION.5
// launchable-substrate-host.HOST_CONFIGURATION.6
//
// SubstrateHostLive is the scoped Effect layer that resolves a
// SubstrateHost from a SubstrateHostBootPlan. Embedded-dev mode owns
// the DurableStreamTestServer lifetime through the layer scope; attached
// mode joins an existing Durable Streams endpoint and does NOT start or
// own the remote process.

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
    // handling (SIGINT/SIGTERM → scope close) is a higher-runtime
    // concern that lands with the public withHost helper in a later
    // slice; this layer alone is enough for Effect-scoped shutdown.
    (server) => Effect.promise(() => server.stop()),
  )

const ensureSubstrateStream = (streamUrl: string, contentType: string) =>
  Effect.tryPromise({
    try: () => DurableStream.create({ url: streamUrl, contentType }),
    catch: (cause) =>
      new HostStartupError(`creating substrate stream ${streamUrl}`, cause),
  })

export interface SubstrateHostLiveOptions {
  readonly profile?: SubstrateHostProfile
  readonly contentType?: string
}

export const SubstrateHostLive = (
  plan: SubstrateHostBootPlan,
  options: SubstrateHostLiveOptions = {},
): Layer.Layer<SubstrateHost> => {
  const profile = options.profile ?? emptyProfile
  const contentType = options.contentType ?? "application/json"
  const bootMode = bootModeOf(plan)

  return Layer.scoped(
    SubstrateHost,
    Effect.gen(function* () {
      // Internal startup failures (server start, stream create) become
      // defects via Effect.orDie below so the public Layer's error
      // channel stays empty. A failing embedded server / stream create
      // crashes the host process; that is the intended local-dev
      // behaviour.
      let streamIdentity: SubstrateHostStreamIdentity
      if (plan._tag === "EmbeddedDevHost") {
        // launchable-substrate-host.HOST_PROCESS.8
        // The host package owns embedded Durable Streams dev-server
        // startup. The OS-assigned port (when port=0) is read back
        // from the running server.
        const server = yield* acquireEmbeddedServer(
          plan.durableStreams.host,
          plan.durableStreams.port,
        )
        const url = new URL(server.url)
        const streamUrl = `${server.url}/substrate/${plan.durableStreams.streamName}`
        // Pre-create the substrate stream so client snapshots/observes
        // before the first write find a valid endpoint.
        yield* ensureSubstrateStream(streamUrl, contentType)
        streamIdentity = {
          streamUrl,
          streamName: plan.durableStreams.streamName,
          host: plan.durableStreams.host,
          port: Number(url.port) || plan.durableStreams.port,
        }
      } else {
        // launchable-substrate-host.HOST_CONFIGURATION.6
        // Attached mode joins an existing endpoint and does not own
        // the remote process. The substrate stream is assumed to be
        // managed by the operator of that endpoint.
        streamIdentity = { streamUrl: plan.streamUrl }
      }

      const service: SubstrateHostService = {
        processId: plan.processId,
        bootMode,
        streamIdentity,
        headers: plan.headers,
        profile,
        bootPlan: plan,
      }
      return service
    }).pipe(Effect.orDie),
  )
}
