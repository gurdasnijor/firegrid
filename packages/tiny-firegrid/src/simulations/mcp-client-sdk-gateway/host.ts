/**
 * mcp-client-sdk-gateway host — composes through the single Firegrid host
 * composition root (tf-ll90.8.4). prod == sim: same `firegridHost(options)`,
 * differing only by the options data (adapter + backend Live + ingress). The
 * gateway carries the `claude-acp` agent runtime; firegridHost seeds the parent
 * gateway context (`session:tiny-firegrid:mcp-client-sdk-gateway-gateway`) that
 * the driver previously registered by hand. The driver then provisions a
 * `session_new` child over the durable-streams MCP ingress via
 * `@firegrid/client-sdk/mcp`.
 */

import { firegridHost } from "@firegrid/host-sdk"
import { DurableStreamsLive, local } from "@firegrid/protocol/launch"
import { defaultProductionAdapterLayer } from "@firegrid/runtime/unified"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import type { Layer } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

export const host = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  firegridHost({
    spec: { namespace: env.namespace },
    adapter: defaultProductionAdapterLayer(
      RuntimeEnvResolverPolicy.withPolicy({
        authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
        lookupEnv: name => env.processEnv[name],
      }),
    ),
    backend: DurableStreamsLive.configuredWith({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    }),
    ingress: {
      transport: "durable-streams",
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      streamId: "mcp-client-sdk-gateway",
      gatewayExternalKey: {
        source: "tiny-firegrid",
        id: "mcp-client-sdk-gateway-gateway",
      },
      gatewayRuntime: local.jsonl({
        agent: "claude-acp",
        argv: [...claudeAcpArgv],
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [{ name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" }],
        runtimeContextMcp: { enabled: true },
      }),
    },
  })
