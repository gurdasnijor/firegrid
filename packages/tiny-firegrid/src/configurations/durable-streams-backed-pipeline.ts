import { FiregridRuntimeHostLive } from "@firegrid/host-sdk"
import type { RuntimeHostTopologyOptions } from "@firegrid/host-sdk/host"

interface DurableStreamsBackedPipelineOptions {
  readonly baseUrl: string
  readonly namespace?: string
  readonly hostId?: string
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
}

export const tinyDurableStreamsBackedPipeline = (
  options: DurableStreamsBackedPipelineOptions,
) => {
  const namespace = options.namespace ?? `tiny-${crypto.randomUUID()}`
  const hostId = options.hostId ?? "host-a"
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
