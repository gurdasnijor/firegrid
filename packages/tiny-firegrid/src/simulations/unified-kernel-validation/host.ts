import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"
import {
  defaultProductionAdapterLayer,
  DurableStreamsLive,
  FiregridRuntime,
} from "@firegrid/runtime/unified"
import { Layer } from "effect"

export const unifiedKernelValidationHost = (
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
