import {
  FiregridRuntimeHostLive,
  type RuntimeHostTopologyOptions,
} from "@firegrid/host-sdk"

interface StdioJsonlToolExecutionPipelineOptions {
  readonly baseUrl: string
  readonly namespace?: string
  readonly hostId?: string
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
}

export const tinyStdioJsonlToolExecutionPipeline = (
  options: StdioJsonlToolExecutionPipelineOptions,
) => {
  const namespace = options.namespace ?? `tiny-stdio-jsonl-tool-${crypto.randomUUID()}`
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
