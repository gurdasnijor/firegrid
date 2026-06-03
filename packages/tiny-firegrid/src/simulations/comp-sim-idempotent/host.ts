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

// Real production host composition (no backdoor). `createOrLoad` materializes
// the participant row through the host-owned HostSessionsCreateOrLoadChannel
// (insertOrGet); the adapter only matters at start(), which this sim never calls.
export const host = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  FiregridRuntime(
    { namespace: env.namespace },
    defaultProductionAdapterLayer(),
  ).pipe(
    Layer.provide(
      DurableStreamsLive.configuredWith({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
    ),
  )
