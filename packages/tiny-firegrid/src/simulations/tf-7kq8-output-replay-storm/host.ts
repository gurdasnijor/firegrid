import { type FiregridHost, FiregridLocalHostLive } from "@firegrid/runtime/composition/host-live"
import { FiregridEnvBindingsFromEnv, FiregridLocalProcessFromEnv } from "@firegrid/runtime/producers/sandbox/local-process-from-env"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
} from "@firegrid/runtime/producers/codecs/mcp"
import { Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"

// tf-7kq8: production host composition (FiregridLocalHostLive + runtime-context
// MCP server) that allows the real claude-agent-acp backing agent to read
// ANTHROPIC_API_KEY. The driver supplies the agent runtime intent, so this host
// stays generic and exercises the real runtime-context workflow output path.
export const tf7kq8OutputReplayStormHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> => {
  const runtimeHost = FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace: env.namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    })),
  )
  const mcp = Layer.discard(
    FiregridMcpServerLayer({
      host: "127.0.0.1",
      port: 0,
      path: ensurePathInput("/mcp"),
    }),
  )
  return Layer.mergeAll(mcp).pipe(Layer.provideMerge(runtimeHost)) as Layer.Layer<
    FiregridHost,
    unknown,
    never
  >
}
