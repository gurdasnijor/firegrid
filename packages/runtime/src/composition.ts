import { Layer } from "effect"

export type FiregridRuntimeLayer = Layer.Layer<never, unknown, unknown>
export type FiregridRuntimeProviderLayer = Layer.Layer<never, unknown, unknown>

type LayerErrors<Layers extends readonly unknown[]> = {
  [K in keyof Layers]: Layers[K] extends Layer.Layer<
    infer _ROut,
    infer E,
    infer _RIn
  >
    ? E
    : never
}[number]

type LayerContexts<Layers extends readonly unknown[]> = {
  [K in keyof Layers]: Layers[K] extends Layer.Layer<
    infer _ROut,
    infer _E,
    infer RIn
  >
    ? RIn
    : never
}[number]

type LayerSuccesses<Layers extends readonly unknown[]> = {
  [K in keyof Layers]: Layers[K] extends Layer.Layer<
    infer ROut,
    infer _E,
    infer _RIn
  >
    ? ROut
    : never
}[number]

type RuntimeCompositionRuntimeContext<
  Handlers extends readonly FiregridRuntimeLayer[],
  Subscribers extends readonly FiregridRuntimeLayer[],
> = LayerContexts<Handlers> | LayerContexts<Subscribers>

type RuntimeCompositionError<
  Handlers extends readonly FiregridRuntimeLayer[],
  Subscribers extends readonly FiregridRuntimeLayer[],
  Providers extends readonly FiregridRuntimeProviderLayer[],
> = LayerErrors<Handlers> | LayerErrors<Subscribers> | LayerErrors<Providers>

type RuntimeCompositionContext<
  Handlers extends readonly FiregridRuntimeLayer[],
  Subscribers extends readonly FiregridRuntimeLayer[],
  Providers extends readonly FiregridRuntimeProviderLayer[],
> =
  | LayerContexts<Providers>
  | Exclude<
    RuntimeCompositionRuntimeContext<Handlers, Subscribers>,
    LayerSuccesses<Providers>
  >

export interface FiregridRuntimeCompositionOptions<
  Handlers extends readonly FiregridRuntimeLayer[] = readonly [],
  Subscribers extends readonly FiregridRuntimeLayer[] = readonly [],
  Providers extends readonly FiregridRuntimeProviderLayer[] = readonly [],
> {
  readonly handlers?: Handlers
  readonly subscribers?: Subscribers
  readonly provide?: Providers
}

export type FiregridRuntimeComposition<
  Handlers extends readonly FiregridRuntimeLayer[],
  Subscribers extends readonly FiregridRuntimeLayer[],
  Providers extends readonly FiregridRuntimeProviderLayer[],
> = Layer.Layer<
  never,
  RuntimeCompositionError<Handlers, Subscribers, Providers>,
  RuntimeCompositionContext<Handlers, Subscribers, Providers>
>

const mergeRuntimeLayers = <
  Layers extends readonly FiregridRuntimeLayer[],
>(
  layers: Layers,
): Layer.Layer<
  never,
  LayerErrors<Layers>,
  LayerContexts<Layers>
> => {
  if (layers.length === 0) {
    return Layer.empty
  }
  const [first, ...rest] = layers as unknown as readonly [
    FiregridRuntimeLayer,
    ...Array<FiregridRuntimeLayer>,
  ]
  return Layer.mergeAll(first, ...rest) as unknown as Layer.Layer<
    never,
    LayerErrors<Layers>,
    LayerContexts<Layers>
  >
}

// firegrid-runtime-process.RUNTIME_COMPOSITION.1
// firegrid-runtime-process.RUNTIME_COMPOSITION.2
// firegrid-runtime-process.RUNTIME_COMPOSITION.3
// firegrid-runtime-process.RUNTIME_COMPOSITION.4
// firegrid-runtime-process.RUNTIME_COMPOSITION.5
// firegrid-runtime-process.RUNTIME_COMPOSITION.6
export const composeRuntime = <
  const Handlers extends readonly FiregridRuntimeLayer[] = readonly [],
  const Subscribers extends readonly FiregridRuntimeLayer[] = readonly [],
  const Providers extends readonly FiregridRuntimeProviderLayer[] = readonly [],
>(
  options: FiregridRuntimeCompositionOptions<
    Handlers,
    Subscribers,
    Providers
  >,
): FiregridRuntimeComposition<Handlers, Subscribers, Providers> => {
  const runtimeLayers = [
    ...(options.handlers ?? []),
    ...(options.subscribers ?? []),
  ] as readonly [...Handlers, ...Subscribers]
  const runtime = mergeRuntimeLayers(runtimeLayers)
  const providers = options.provide ?? []
  if (providers.length === 0) {
    return runtime
  }
  return Layer.provide(runtime, providers as unknown as [
    FiregridRuntimeProviderLayer,
    ...Array<FiregridRuntimeProviderLayer>,
  ]) as FiregridRuntimeComposition<Handlers, Subscribers, Providers>
}
