import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, type Scope, Layer } from "effect"
import { generateProcessId } from "../boot/identity.ts"
import { RuntimeContext } from "./runtime-context.ts"
import {
  FiregridRuntime,
  type BootMode,
  type FiregridRuntimeService,
  type FiregridRuntimeStreamIdentity,
} from "./service.ts"

// firegrid-architecture-boundary.AUTHORITY.4
// firegrid-architecture-boundary.SURFACE_AREA.2
// firegrid-runtime-process.RUNTIME_PACKAGE.1
// firegrid-runtime-process.RUNTIME_PACKAGE.2
// firegrid-runtime-process.RUNTIME_PACKAGE.4
// firegrid-runtime-process.CONFIG_SURFACE.1
// firegrid-runtime-process.CONFIG_SURFACE.2
// firegrid-runtime-process.CONFIG_SURFACE.3
//
// Single public construction surface for the Firegrid runtime:
// `FiregridRuntimeBoot.{attached, embeddedDev}`. Both take
// explicit values and return Effect Layers. There is no
// boot-plan-from-env helper, no FiregridRuntimeBootPlan public
// type, no FiregridRuntimeLive public factory — those would only
// reify ceremony around process configuration that belongs at the
// binary process edge (bin/firegrid.ts).
//
// Runtime composition uses ordinary `Layer.mergeAll` /
// `Layer.provide`. The optional `runtime` Layer is launched inside
// the runtime's scope; RuntimeContext is injected so helpers can
// read streamUrl / contentType / processId / streamIdentity.

class RuntimeStartupError extends Error {
  readonly _tag = "RuntimeStartupError"
  constructor(reason: string, cause?: unknown) {
    super(
      `firegrid runtime startup failed: ${reason}${cause ? `: ${String(cause)}` : ""}`,
    )
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
        new RuntimeStartupError("embedded DurableStreamTestServer", cause),
    }),
    (server) => Effect.promise(() => server.stop()),
  )

const ensureSubstrateStream = (streamUrl: string, contentType: string) =>
  Effect.tryPromise({
    try: () => DurableStream.create({ url: streamUrl, contentType }),
    catch: (cause) =>
      new RuntimeStartupError(
        `creating substrate stream ${streamUrl}`,
        cause,
      ),
  })

interface ResolvedIdentity {
  readonly bootMode: BootMode
  readonly streamIdentity: FiregridRuntimeStreamIdentity
}

const buildRuntimeLayer = <E, GraphRIn>(
  acquireIdentity: Effect.Effect<ResolvedIdentity, never, Scope.Scope>,
  processId: string,
  contentType: string,
  runtime: Layer.Layer<never, E, GraphRIn> | undefined,
): Layer.Layer<FiregridRuntime, E, Exclude<GraphRIn, RuntimeContext>> =>
  Layer.unwrapScoped(
    Effect.gen(function* () {
      const { bootMode, streamIdentity } = yield* acquireIdentity

      const runtimeService: FiregridRuntimeService = {
        processId,
        bootMode,
        streamIdentity,
      }
      const serviceLayer = Layer.succeed(FiregridRuntime, runtimeService)

      if (runtime === undefined) {
        return serviceLayer as Layer.Layer<
          FiregridRuntime,
          E,
          Exclude<GraphRIn, RuntimeContext>
        >
      }

      const runtimeContextLayer = Layer.succeed(RuntimeContext, {
        streamUrl: streamIdentity.streamUrl,
        contentType,
        processId,
        streamIdentity,
      })
      const wired = runtime.pipe(Layer.provide(runtimeContextLayer))
      return Layer.mergeAll(serviceLayer, wired)
    }),
  )

export interface AttachedRuntimeOptions<
  E = never,
  GraphRIn = RuntimeContext,
> {
  readonly streamUrl: string
  readonly processId?: string
  readonly runtime?: Layer.Layer<never, E, GraphRIn>
  readonly contentType?: string
}

export interface EmbeddedDevRuntimeOptions<
  E = never,
  GraphRIn = RuntimeContext,
> {
  readonly streamName?: string
  readonly durableStreamsHost?: string
  readonly durableStreamsPort?: number
  readonly processId?: string
  readonly runtime?: Layer.Layer<never, E, GraphRIn>
  readonly contentType?: string
}

export const FiregridRuntimeBoot = {
  attached: <E = never, GraphRIn = RuntimeContext>(
    opts: AttachedRuntimeOptions<E, GraphRIn>,
  ): Layer.Layer<FiregridRuntime, E, Exclude<GraphRIn, RuntimeContext>> => {
    const contentType = opts.contentType ?? "application/json"
    const processId = opts.processId ?? generateProcessId()
    const acquireIdentity: Effect.Effect<
      ResolvedIdentity,
      never,
      Scope.Scope
    > = Effect.succeed({
      bootMode: "attached",
      streamIdentity: { streamUrl: opts.streamUrl },
    })
    return buildRuntimeLayer<E, GraphRIn>(
      acquireIdentity,
      processId,
      contentType,
      opts.runtime,
    )
  },

  embeddedDev: <E = never, GraphRIn = RuntimeContext>(
    opts: EmbeddedDevRuntimeOptions<E, GraphRIn> = {},
  ): Layer.Layer<FiregridRuntime, E, Exclude<GraphRIn, RuntimeContext>> => {
    const contentType = opts.contentType ?? "application/json"
    const processId = opts.processId ?? generateProcessId()
    const host = opts.durableStreamsHost ?? "127.0.0.1"
    const port = opts.durableStreamsPort ?? 0
    const streamName = opts.streamName ?? "substrate"
    const acquireIdentity = Effect.gen(function* () {
      const server = yield* acquireEmbeddedServer(host, port).pipe(
        Effect.orDie,
      )
      const url = new URL(server.url)
      const streamUrl = `${server.url}/substrate/${streamName}`
      yield* ensureSubstrateStream(streamUrl, contentType).pipe(Effect.orDie)
      return {
        bootMode: "embedded-dev" as const,
        streamIdentity: {
          streamUrl,
          streamName,
          host,
          port: Number(url.port) || port,
        },
      }
    })
    return buildRuntimeLayer<E, GraphRIn>(
      acquireIdentity,
      processId,
      contentType,
      opts.runtime,
    )
  },
} as const
