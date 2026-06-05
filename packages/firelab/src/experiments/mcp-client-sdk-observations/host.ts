/**
 * mcp-client-sdk-observations host — composes through the single Firegrid host
 * composition root (tf-ll90.8.4). `firegridHost(options)` provides the MCP
 * ingress (server + tool-dispatch + host-plane router + context-resolver +
 * agent-output/contexts views) and the `FiregridRuntime`; the gateway carries
 * the production claude-acp agent so `session_new` children inherit it. There is
 * no per-sim layer assembly — prod == sim, differing only by the options data.
 *
 * This sim is now self-contained (previously it reused
 * mcp-production-task-projection/host.ts and seeded its parent gateway via the
 * legacy firegrid.ts client surface). The gateway is now firegridHost-seeded.
 *
 * Imports: firegridHost from "@firegrid/host-sdk", DurableStreamsLive + local
 * from "@firegrid/protocol/launch", defaultProductionAdapterLayer from
 * "@firegrid/runtime/unified", RuntimeEnvResolverPolicy from
 * "@firegrid/runtime/sources/sandbox".
 */

import { firegridHost } from "@firegrid/host-sdk"
import { DurableStreamsLive, local } from "@firegrid/protocol/launch"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import { defaultProductionAdapterLayer } from "@firegrid/runtime/unified"
import type { Layer } from "effect"
import type {
  FiregridHost,
  FirelabHostEnv,
} from "../../types.ts"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

export const host = (
  env: FirelabHostEnv,
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
      streamId: "mcp-client-sdk-observations",
      gatewayExternalKey: {
        source: "firelab",
        id: "mcp-client-sdk-observations-gateway",
      },
      gatewayRuntime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
        runtimeContextMcp: { enabled: true },
      }),
    },
  })
