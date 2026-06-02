import { defaultProductionAdapterLayer, FiregridRuntime } from "@firegrid/runtime/unified"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const host = (
  env: TinyFiregridHostEnv,
): ReturnType<typeof FiregridRuntime> =>
  FiregridRuntime(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(),
  )
