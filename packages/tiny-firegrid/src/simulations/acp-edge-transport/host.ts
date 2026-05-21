import {
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  acpStdioEdge,
  FiregridHostPlaneEdgesLive,
} from "./edge.ts"
import { inMemoryAcpEdgeHarness } from "./harness.ts"

export const acpEdgeTransportHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const runtimeHost = FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
  )
  const edgeTopology = {
    context: {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    },
    edges: [
      acpStdioEdge({
        input: inMemoryAcpEdgeHarness.edgeInput,
        output: inMemoryAcpEdgeHarness.edgeOutput,
      }),
    ],
  }
  const acpEdge = FiregridHostPlaneEdgesLive(edgeTopology)

  return Layer.mergeAll(runtimeHost, acpEdge) as Layer.Layer<
    FiregridHost,
    unknown,
    never
  >
}
