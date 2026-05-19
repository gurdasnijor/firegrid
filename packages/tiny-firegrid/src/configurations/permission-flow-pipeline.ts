import {
  FiregridRuntimeHostLive,
  type FiregridHost,
  type RuntimeHostTopologyOptions,
} from "@firegrid/host-sdk"
import type { Layer } from "effect"
import type { DurableTableError } from "effect-durable-operators"

interface PermissionFlowPipelineOptions {
  readonly baseUrl: string
  readonly namespace?: string
  readonly hostId?: string
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
}

export const tinyPermissionFlowPipeline = (
  options: PermissionFlowPipelineOptions,
): Layer.Layer<FiregridHost, DurableTableError> => {
  const namespace = options.namespace ?? `tiny-permission-flow-${crypto.randomUUID()}`
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
