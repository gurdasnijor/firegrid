import { defaultProductionAdapterLayer, DurableStreamsLive, FiregridRuntime } from "@firegrid/runtime/unified"
import { Layer } from "effect"
import type { FiregridHost, TinyFiregridHostEnv } from "../../types.ts"

export const host = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  FiregridRuntime(
    {
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(),
  ).pipe(
    Layer.provide(
      DurableStreamsLive.configuredWith({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
    ),
  )
