/**
 * mcp-task-projection-gateway host — composes through the single Firegrid host
 * composition root (tf-ll90.8.4). The custom task-projection MCP protocol that
 * this sim originally hand-wired (`protocol.ts` / `wire.ts` — the SEP-2663-shaped
 * Tasks projection over its own durable-streams wire) has been PROMOTED into the
 * production MCP ingress (`runtime/unified/mcp-host/task-projection.ts`): the
 * standard durable-streams MCP ingress now natively projects MCP Tasks for
 * `session_prompt` from RuntimeContext output, with the same task-id encoding,
 * `tasks/get` / `tasks/result` / `tasks/update` permission round-trip, and
 * stateless rehydration. The sim-local copy therefore DUPLICATED firegridHost's
 * ingress and is dropped; this sim now composes the bare `firegridHost(options)`
 * and drives the task projection over `@firegrid/client-sdk/mcp`.
 *
 * The gateway carries the claude-acp agent (host-resolved `ANTHROPIC_API_KEY`)
 * so `session_new` children inherit it for the real prompt + permission probe.
 */

import { firegridHost } from "@firegrid/host-sdk"
import { DurableStreamsLive, local } from "@firegrid/protocol/launch"
import { defaultProductionAdapterLayer } from "@firegrid/runtime/unified"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
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

export const mcpTaskProjectionGatewayHost = (
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
      streamId: "mcp-task-projection-gateway",
      gatewayExternalKey: {
        source: "firelab",
        id: "mcp-task-projection-gateway-gateway",
      },
      gatewayRuntime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
      }),
    },
  })
