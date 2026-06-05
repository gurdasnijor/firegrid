/**
 * cross-agent-delegation host — composes through the single Firegrid host
 * composition root (tf-ll90.8.4). prod == sim: same `firegridHost(options)`,
 * differing only by the options data (adapter policy + backend Live + ingress).
 *
 * The gateway carries a REAL off-the-shelf claude-acp planner agent with its
 * per-context runtime MCP server enabled (`runtimeContextMcp.enabled: true`) so
 * the spawned planner can reach the Firegrid `session_new` tool and delegate to
 * a CHILD agent. `firegridHost` now provides ALL of the MCP host internals
 * (FiregridMcpServerLayer + ToolDispatchLive + ContextResolver) — the dispatch
 * arms call the host-control channel bindings directly (tf-s9uj, no host-plane
 * router); the old host hand-bound those; that wiring is DROPPED.
 *
 * Creds-gated: the gateway runtime binds ANTHROPIC_API_KEY from the host env
 * policy; without the key the spawned claude-acp agent halts `blocked` (the
 * structural shape is unchanged — creds-gating is not a gap).
 */

import { firegridHost } from "@firegrid/host-sdk"
import { DurableStreamsLive, local } from "@firegrid/protocol/launch"
import { defaultProductionAdapterLayer } from "@firegrid/runtime/unified"
import { RuntimeEnvResolverPolicy } from "@firegrid/runtime/sources/sandbox"
import type { Layer } from "effect"
import type { FiregridHost, FirelabHostEnv } from "../../types.ts"

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
        lookupEnv: (name) => env.processEnv[name],
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
      streamId: "cross-agent-delegation",
      gatewayExternalKey: {
        source: "firelab",
        id: "cross-agent-delegation-gateway",
      },
      // The gateway planner is a real claude-acp agent with its per-context MCP
      // server enabled so it can call `session_new` to delegate to a child.
      gatewayRuntime: local.jsonl({
        agent: "claude-acp",
        argv: [...claudeAcpArgv],
        agentProtocol: "acp",
        cwd: process.cwd(),
        envBindings: [{ name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" }],
        runtimeContextMcp: { enabled: true },
      }),
    },
  })
