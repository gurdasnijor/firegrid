/**
 * tf-ll90.5.1 / tf-ll90.8.4 — shape-c terminal-ordering proof host.
 *
 * Composes through the single Firegrid host composition root
 * (`firegridHost(options)`, prod == sim). The gateway carries the REAL
 * `claude-acp` agent: the driver provisions a `session_new` child off that
 * gateway, prompts it, observes a full turn of raw agent_output, then closes
 * it. The terminal-ordering invariant (terminal completion binds the durable
 * lifecycle — `terminal_signal` precedes `adapter.deregister`, NOT a raw
 * agent_output) lives entirely in the production close binding this host
 * composes unchanged.
 *
 * The only host-level configuration is the env-binding resolver policy that
 * authorizes `ANTHROPIC_API_KEY` for the real `claude-acp` spawn — the same
 * production `RuntimeEnvResolverPolicy` every real-ACP sim uses. It is host
 * composition, not a behavioral backdoor.
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

export const shapeCTerminalOrderingHost = (
  env: FirelabHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  firegridHost({
    spec: { namespace: env.namespace },
    adapter: defaultProductionAdapterLayer(
      RuntimeEnvResolverPolicy.withPolicy({
        authorizedBindings: [
          ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
        ],
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
      streamId: "shape-c-terminal-ordering",
      gatewayExternalKey: {
        source: "firelab",
        id: "shape-c-terminal-ordering-gateway",
      },
      gatewayRuntime: local.jsonl({
        agent: "claude-acp",
        argv: [...claudeAcpArgv],
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
      }),
    },
  })
