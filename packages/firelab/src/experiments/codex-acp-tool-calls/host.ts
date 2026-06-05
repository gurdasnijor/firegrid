/**
 * codex-acp-tool-calls host — composes through the single Firegrid host
 * composition root (tf-ll90.8.4). prod == sim: `firegridHost(options)`,
 * differing only by the options data (adapter + backend Live + ingress).
 *
 * The gateway carries the REAL `@zed-industries/codex-acp` agent runtime (ACP,
 * OPENAI_API_KEY env binding, host-owned runtime-context MCP enabled). Child
 * sessions provisioned via `session_new` over the durable-streams MCP ingress
 * inherit this runtime — so the codex agent reaches the host's runtime-context
 * MCP server and can call the Firegrid `sleep` tool. Creds-gated (needs
 * OPENAI_API_KEY to actually RUN), but composes structurally without it.
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

const codexAcpArgv = [
  "npx",
  "-y",
  "@zed-industries/codex-acp@0.14.0",
] as const

export const codexAcpHost = (
  env: FirelabHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  firegridHost({
    spec: { namespace: env.namespace },
    adapter: defaultProductionAdapterLayer(
      RuntimeEnvResolverPolicy.withPolicy({
        authorizedBindings: [["OPENAI_API_KEY", "OPENAI_API_KEY"]],
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
      streamId: "codex-acp-tool-calls",
      gatewayExternalKey: {
        source: "firelab",
        id: "codex-acp-tool-calls-gateway",
      },
      gatewayRuntime: local.jsonl({
        argv: [...codexAcpArgv],
        agent: "codex-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "OPENAI_API_KEY", ref: "env:OPENAI_API_KEY" },
        ],
        // Host-owned runtime-context MCP attachment so the codex agent can call
        // the Firegrid `sleep` tool (the marker the driver asserts).
        runtimeContextMcp: { enabled: true },
      }),
    },
  })
