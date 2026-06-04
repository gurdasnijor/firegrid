/**
 * tf-r06u.36 / tf-ll90.8.4 — natural-exit terminal-deregister proof host.
 * Composes through the single Firegrid host composition root. The gateway
 * carries the one-shot self-exiting ACP agent; the driver provisions a
 * `session_new` child which answers once then EXITS → byte-pipe EOF →
 * `Terminated` → the production observer runs `adapter.deregister`.
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

export const naturalExitTerminalHost = (
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
      streamId: "natural-exit-terminal",
      gatewayExternalKey: {
        source: "firelab",
        id: "natural-exit-terminal-gateway",
      },
      gatewayRuntime: local.jsonl({
        agent: "self-exiting-acp-agent",
        argv: [
          process.execPath,
          pathFromHere("../../../../../node_modules/tsx/dist/cli.mjs"),
          pathFromHere("../../bin/self-exiting-acp-agent-process.ts"),
        ],
        agentProtocol: "acp",
      }),
    },
  })
