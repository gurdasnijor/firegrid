import {
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import { FiregridAcpStdioHostEdgeLive } from "./edge.ts"
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
  const acpEdge = FiregridAcpStdioHostEdgeLive({
    input: inMemoryAcpEdgeHarness.edgeInput,
    output: inMemoryAcpEdgeHarness.edgeOutput,
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
  })

  return Layer.mergeAll(runtimeHost, acpEdge) as Layer.Layer<
    FiregridHost,
    unknown,
    never
  >
}
