import {
  ensurePathInput,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  FiregridMcpServerLayer,
} from "@firegrid/host-sdk"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const codexAcpHost = (
  env: TinyFiregridHostEnv,
) => {
  const namespace = env.namespace
  const mcpHost = "127.0.0.1"
  const mcpPath = "/mcp"
  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["OPENAI_API_KEY", "OPENAI_API_KEY"]],
    })),
  )
  const mcp = Layer.discard(
    FiregridMcpServerLayer({
      host: mcpHost,
      port: 0,
      path: ensurePathInput(mcpPath),
    }),
  )
  return Layer.mergeAll(
    mcp,
  ).pipe(
    Layer.provideMerge(host),
  )
}
