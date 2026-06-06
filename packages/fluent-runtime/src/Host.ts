import { FetchHttpClient } from "@effect/platform"
import { Layer } from "effect"
import {
  FluentControlSurfaceLive,
  type FluentControlSurface,
} from "./ControlSurface.ts"
import {
  FluentEventIngressLive,
  type FluentEventIngress,
} from "./EventIngress.ts"
import {
  FluentSourcesLive,
  type FluentSources,
} from "./Sources.ts"
import {
  FluentStoreLive,
  type FluentStore,
  type StoreConfig,
} from "./Store.ts"

export type FluentRuntimeConfig = StoreConfig

export type FluentRuntimeServices =
  | FluentStore
  | FluentSources
  | FluentEventIngress
  | FluentControlSurface

export const FluentRuntimeLive = (
  config: FluentRuntimeConfig,
): Layer.Layer<FluentRuntimeServices> => {
  const store = FluentStoreLive(config).pipe(
    Layer.provide(FetchHttpClient.layer),
  )
  const sources = FluentSourcesLive.pipe(
    Layer.provide(store),
  )
  const ingress = FluentEventIngressLive.pipe(
    Layer.provide(Layer.mergeAll(store, sources)),
  )
  const control = FluentControlSurfaceLive.pipe(
    Layer.provide(store),
  )
  return Layer.mergeAll(store, sources, ingress, control)
}
