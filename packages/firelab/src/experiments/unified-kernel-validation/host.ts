/**
 * unified-kernel-validation host — composes through the single Firegrid host
 * composition root (tf-ll90.8.4). prod == sim: same `firegridHost(options)`,
 * differing only by the options data (adapter + backend Live + ingress). No
 * per-sim layer assembly. The gateway carries the creds-free official-ACP-example
 * agent; the driver provisions a `session_new` child over the durable-streams
 * MCP ingress.
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

export const unifiedKernelValidationHost = (
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
      streamId: "unified-kernel-validation",
      gatewayExternalKey: {
        source: "firelab",
        id: "unified-kernel-validation-gateway",
      },
      gatewayRuntime: local.jsonl({
        agent: "official-acp-typescript-sdk-example",
        argv: [
          process.execPath,
          pathFromHere("../../../../../node_modules/tsx/dist/cli.mjs"),
          pathFromHere("../../bin/fake-acp-agent-process.ts"),
        ],
        agentProtocol: "acp",
      }),
    },
  })
