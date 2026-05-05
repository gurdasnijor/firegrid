import { Effect, Layer } from "effect"
import { generateProcessId } from "../boot/identity.ts"
import {
  attachedResolverLayer,
  DurableStreamAdminLive,
  embeddedResolverLayer,
  EmbeddedDurableStreamsLive,
  RuntimeStreamResolver,
} from "./internal/stream-resolver.ts"
import { RuntimeContext } from "./runtime-context.ts"
import {
  FiregridRuntime,
  type FiregridRuntimeService,
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
// `FiregridRuntimeBoot.{attached, embeddedDev}`. Both take explicit
// values and return Effect Layers. There is no boot-plan-from-env
// helper, no FiregridRuntimeBootPlan public type, no
// FiregridRuntimeLive public factory — those would only reify
// ceremony around process configuration that belongs at the binary
// process edge (bin/firegrid.ts).
//
// Internally, attached and embedded-dev are not bespoke runtime
// implementations. They are different live providers of the same
// internal `RuntimeStreamResolver` Tag (see
// `internal/stream-resolver.ts`); the core layer here resolves the
// stream identity through that Tag, builds the `FiregridRuntime`
// service, and provides `RuntimeContext` to the optional
// caller-supplied runtime program. Tests can drive the core via a
// fake resolver layer (see `runtime-foundations.test.ts`).

const buildCoreRuntimeLayer = <E, GraphRIn>(
  processId: string,
  contentType: string,
  runtime: Layer.Layer<never, E, GraphRIn> | undefined,
): Layer.Layer<
  FiregridRuntime,
  E,
  RuntimeStreamResolver | Exclude<GraphRIn, RuntimeContext>
> =>
  Layer.unwrapScoped(
    Effect.gen(function* () {
      const resolver = yield* RuntimeStreamResolver
      const { bootMode, streamIdentity } = yield* resolver.resolve

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
    const core = buildCoreRuntimeLayer<E, GraphRIn>(
      processId,
      contentType,
      opts.runtime,
    )
    // The internal `RuntimeStreamResolver` Tag is never part of
    // the caller's supplied GraphRIn, so eliminating it via
    // `Layer.provide` cleanly leaves only `Exclude<GraphRIn,
    // RuntimeContext>`. TS preserves the redundant
    // `Exclude<…, RuntimeStreamResolver>` peel; cast to the
    // user-visible signature.
    return Layer.provide(
      core,
      attachedResolverLayer(opts.streamUrl),
    ) as Layer.Layer<FiregridRuntime, E, Exclude<GraphRIn, RuntimeContext>>
  },

  embeddedDev: <E = never, GraphRIn = RuntimeContext>(
    opts: EmbeddedDevRuntimeOptions<E, GraphRIn> = {},
  ): Layer.Layer<FiregridRuntime, E, Exclude<GraphRIn, RuntimeContext>> => {
    const contentType = opts.contentType ?? "application/json"
    const processId = opts.processId ?? generateProcessId()
    const core = buildCoreRuntimeLayer<E, GraphRIn>(
      processId,
      contentType,
      opts.runtime,
    )
    const resolver = embeddedResolverLayer({
      host: opts.durableStreamsHost ?? "127.0.0.1",
      port: opts.durableStreamsPort ?? 0,
      streamName: opts.streamName ?? "substrate",
      contentType,
    })
    const infra = Layer.mergeAll(
      EmbeddedDurableStreamsLive,
      DurableStreamAdminLive,
    )
    return Layer.provide(
      core,
      Layer.provide(resolver, infra),
    ) as Layer.Layer<FiregridRuntime, E, Exclude<GraphRIn, RuntimeContext>>
  },
} as const
