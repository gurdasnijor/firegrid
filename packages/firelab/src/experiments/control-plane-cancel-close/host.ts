/**
 * control-plane-cancel-close host — composes through the single Firegrid host
 * composition root (tf-ll90.8.4). prod == sim: same `firegridHost(options)`,
 * differing only by options data. The gateway carries the creds-free fake ACP
 * agent; the driver provisions children via `session_new` and cancels/closes
 * them as MCP tool-calls over the durable-streams ingress.
 */

import { firegridHost } from "@firegrid/host-sdk"
import { DurableStreamsLive, local } from "@firegrid/protocol/launch"
import { defaultProductionAdapterLayer } from "@firegrid/runtime/unified"
import type { Layer } from "effect"
import type {
  FiregridHost,
  FirelabHostEnv,
} from "../../types.ts"

const pathFromHere = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname)

export const host = (
  env: FirelabHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  firegridHost({
    spec: { namespace: env.namespace },
    adapter: defaultProductionAdapterLayer(),
    backend: DurableStreamsLive.configuredWith({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    }),
    ingress: {
      transport: "durable-streams",
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      streamId: "control-plane-cancel-close",
      gatewayExternalKey: {
        source: "firelab",
        id: "control-plane-cancel-close-gateway",
      },
      gatewayRuntime: local.jsonl({
        agent: "fake-acp",
        argv: [
          process.execPath,
          pathFromHere("../../../../../node_modules/tsx/dist/cli.mjs"),
          pathFromHere("../../bin/fake-acp-agent-process.ts"),
        ],
        agentProtocol: "acp",
      }),
    },
  })
