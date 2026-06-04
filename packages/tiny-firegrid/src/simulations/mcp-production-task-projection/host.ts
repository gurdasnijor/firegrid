/**
 * mcp-production-task-projection host — composes through the single Firegrid
 * host composition root (tf-ll90.8.4). `firegridHost(options)` provides the MCP
 * ingress (server + tool-dispatch + host-plane router + context-resolver +
 * agent-output/contexts views) and the `FiregridRuntime`; the gateway carries
 * the production claude-acp agent so `session_new` children inherit it. There is
 * no per-sim layer assembly — prod == sim, differing only by the options data.
 *
 * NOTE: this host was previously REUSED by the mcp-client-sdk-gateway and
 * mcp-client-sdk-observations sims; those now own their own hosts, so this is
 * self-contained and serves THIS sim only. Both exported symbols are retained.
 *
 * Imports: firegridHost from "@firegrid/host-sdk", DurableStreamsLive + local
 * from "@firegrid/protocol/launch", defaultProductionAdapterLayer from
 * "@firegrid/runtime/unified".
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

const streamId = "mcp-production-task-projection"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

interface McpProductionTaskProjectionHostOptions {
  readonly streamId: string
}

const makeMcpProductionTaskProjectionHost = (
  options: McpProductionTaskProjectionHostOptions,
): ((
  env: TinyFiregridHostEnv,
) => Layer.Layer<FiregridHost, unknown>) =>
  (env: TinyFiregridHostEnv): Layer.Layer<FiregridHost, unknown> =>
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
        streamId: options.streamId,
        gatewayExternalKey: {
          source: "tiny-firegrid",
          id: "mcp-production-task-projection-gateway",
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

export const mcpProductionTaskProjectionHost =
  makeMcpProductionTaskProjectionHost({
    streamId,
  })
