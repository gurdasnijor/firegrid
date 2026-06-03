import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import {
  ContextResolverTag,
  defaultProductionAdapterLayer,
  DurableStreamsLive,
  ensurePathInput,
  FiregridRuntime,
  FiregridMcpServerLayer,
  RuntimeControlPlaneTable,
  ToolDispatchLive,
} from "@firegrid/runtime/unified"
import { Effect, Layer } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

const mcpHost = "127.0.0.1"
const mcpPort = 43791
const mcpPath = "/mcp"

const contextResolverFromControlPlaneTable = Layer.effect(
  ContextResolverTag,
  Effect.gen(function*() {
    const control = yield* RuntimeControlPlaneTable
    return {
      resolve: (contextId: string) => control.contexts.get(contextId),
    }
  }),
)

export const codexAcpHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const host = FiregridRuntime(
    {
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(RuntimeEnvResolverPolicy.withPolicy({
      authorizedBindings: [["OPENAI_API_KEY", "OPENAI_API_KEY"]],
      lookupEnv: (name) => env.processEnv[name],
    })),
  ).pipe(
    Layer.provide(
      DurableStreamsLive.configuredWith({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
    ),
  )
  const mcp = FiregridMcpServerLayer({
    host: mcpHost,
    port: mcpPort,
    path: ensurePathInput(mcpPath),
  }).pipe(
    Layer.provide(Layer.merge(ToolDispatchLive, contextResolverFromControlPlaneTable)),
    Layer.discard,
  )

  return mcp.pipe(Layer.provideMerge(host))
}
