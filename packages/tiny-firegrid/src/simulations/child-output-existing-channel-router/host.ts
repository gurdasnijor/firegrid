import type { FiregridHost, TinyFiregridHostEnv } from "../../types.ts"
import {
  defaultProductionAdapterLayer,
  FiregridRuntime,
} from "@firegrid/runtime/unified"
import type { Layer } from "effect"

export const host = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  FiregridRuntime(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(),
  )
