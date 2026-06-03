import { HostPlaneSessionControlRouterLive } from "@firegrid/runtime/channels"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import {
  ContextResolverTag,
  defaultProductionAdapterLayer,
  DurableStreamsLive,
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridRuntime,
  RuntimeControlPlaneTable,
  ToolDispatchLive,
} from "@firegrid/runtime/unified"
import { Effect, Layer } from "effect"
import type { FiregridHost, TinyFiregridHostEnv } from "../../types.ts"

// Cross-agent delegation is reachable ONLY by an ACP agent that calls the
// host-bound runtime-context MCP server (a `"raw"`/stdio-jsonl agent has neither
// a wired tool_use dispatch nor an MCP slot — see
// docs/findings/tf-0awo-31-3-cross-agent-delegation.md). So the host must bind
// the real MCP server + the shared agent-tool dispatch (which lowers
// `session_new`), exactly as the accepted `codex-acp-tool-calls` host does. No
// sim-only backdoor: the executor is the production `ToolDispatchLive`.
const mcpHost = "127.0.0.1"
const mcpPort = 43792
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

export const host = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> => {
  const runtime = FiregridRuntime(
    {
      namespace: env.namespace,
    },
    defaultProductionAdapterLayer(
      RuntimeEnvResolverPolicy.withPolicy({
        authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
        lookupEnv: (name) => env.processEnv[name],
      }),
    ),
  ).pipe(
    Layer.provide(
      DurableStreamsLive.configuredWith({
        baseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      }),
    ),
  )
  // `session_new` lowers into host-plane create-or-load + prompt + start, which
  // the tool arm dispatches through the runtime-optional `HostPlaneChannelRouter`
  // (it fails "session tools require HostPlaneChannelRouter" without it — observed).
  // The router's host-plane channels resolve from the runtime below. (The
  // fact-stream / RuntimeChannelRouter machinery is only needed by `wait_for`,
  // not by `session_new`, so it is intentionally omitted.)
  const toolDispatch = ToolDispatchLive.pipe(
    Layer.provideMerge(contextResolverFromControlPlaneTable),
    Layer.provideMerge(HostPlaneSessionControlRouterLive),
  )
  const mcp = FiregridMcpServerLayer({
    host: mcpHost,
    port: mcpPort,
    path: ensurePathInput(mcpPath),
  }).pipe(
    Layer.provideMerge(contextResolverFromControlPlaneTable),
    Layer.provideMerge(toolDispatch),
    Layer.discard,
  )

  return mcp.pipe(Layer.provideMerge(runtime))
}
