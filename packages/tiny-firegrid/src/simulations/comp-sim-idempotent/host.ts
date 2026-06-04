/**
 * comp-sim-idempotent host — composes through the single Firegrid host
 * composition root (tf-ll90.8.4). prod == sim: same `firegridHost(options)`,
 * differing only by options data.
 *
 * The driver only PROVISIONS participant rows via the idempotent
 * `session_create_or_load` MCP tool (caller external-key insert-or-get); it
 * never prompts or spawns, so the gateway carries the creds-free fake ACP agent
 * purely to satisfy the ingress seed (tf-focr).
 */

import { firegridHost } from "@firegrid/host-sdk"
import { DurableStreamsLive, local } from "@firegrid/protocol/launch"
import { defaultProductionAdapterLayer } from "@firegrid/runtime/unified"
import type { Layer } from "effect"
import type {
  FiregridHost,
  TinyFiregridHostEnv,
} from "../../types.ts"

const pathFromHere = (relative: string): string =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname)

export const host = (
  env: TinyFiregridHostEnv,
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
      streamId: "comp-sim-idempotent",
      gatewayExternalKey: {
        source: "tiny-firegrid",
        id: "comp-sim-idempotent-gateway",
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
