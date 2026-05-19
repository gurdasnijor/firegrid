import {
  FiregridRuntimeHostLive,
  type FiregridHost,
} from "@firegrid/host-sdk"
import type { RuntimeHostTopologyOptions } from "@firegrid/host-sdk/host"
import type { Layer } from "effect"
import type { DurableTableError } from "effect-durable-operators"

interface MultiContextProductionConsumingPipelineOptions {
  readonly baseUrl: string
  readonly namespace?: string
  readonly hostId?: string
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
}

export const tinyMultiContextProductionConsumingPipeline = (
  options: MultiContextProductionConsumingPipelineOptions,
): Layer.Layer<FiregridHost, DurableTableError> => {
  const namespace = options.namespace ?? `tiny-multi-context-${crypto.randomUUID()}`
  const hostId = options.hostId ?? "host-a"
  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
   
  return FiregridRuntimeHostLive({
    durableStreamsBaseUrl: options.baseUrl,
    namespace,
    hostId,
    hostSessionId: `${hostId}-session`,
    input: true,
    ...(options.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: options.localProcessEnv }),
  })
}
