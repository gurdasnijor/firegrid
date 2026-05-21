import {
  type HostStreamPrefix,
  RuntimeOutputTable,
  runtimeContextOutputStreamUrl,
} from "@firegrid/protocol/launch"
import type { DurableTableHeaders } from "effect-durable-operators"

// tf-bffo: shared per-context RuntimeOutputTable layer builder used by the durable
// channel implementations + the per-context output wiring (single source of truth
// for the context output stream URL + table options).
export const runtimeContextOutputTableLayer = (
  options: {
    readonly durableStreamsBaseUrl: string
    readonly streamPrefix: HostStreamPrefix
    readonly contextId: string
    readonly headers?: DurableTableHeaders
  },
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeContextOutputStreamUrl({
        baseUrl: options.durableStreamsBaseUrl,
        prefix: options.streamPrefix,
        contextId: options.contextId,
      }),
      contentType: "application/json",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    },
  })

// Convenience over the above for the common `(config, context)` call shape used by
// the per-context output wiring and the host-control snapshot reads.
export const runtimeContextOutputTableLayerForContext = (
  config: { readonly durableStreamsBaseUrl: string; readonly headers?: DurableTableHeaders },
  context: { readonly contextId: string; readonly host: { readonly streamPrefix: HostStreamPrefix } },
) =>
  runtimeContextOutputTableLayer({
    durableStreamsBaseUrl: config.durableStreamsBaseUrl,
    streamPrefix: context.host.streamPrefix,
    contextId: context.contextId,
    ...(config.headers === undefined ? {} : { headers: config.headers }),
  })
