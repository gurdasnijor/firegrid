import {
  RuntimeOutputTable,
  runtimeOutputStreamUrl,
} from "@firegrid/protocol/launch"
import type { DurableTableHeaders } from "effect-durable-operators"

export const runtimeOutputTableLayer = (
  options: {
    readonly durableStreamsBaseUrl: string
    readonly namespace: string
    readonly headers?: DurableTableHeaders
  },
) =>
  RuntimeOutputTable.layer({
    streamOptions: {
      url: runtimeOutputStreamUrl({
        baseUrl: options.durableStreamsBaseUrl,
        namespace: options.namespace,
      }),
      contentType: "application/json",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    },
  })
