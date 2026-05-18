import type { ServeError } from "@effect/platform/HttpServerError"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridRuntimeHostLive,
  type FiregridHost,
  type RuntimeHostTopologyOptions,
} from "@firegrid/host-sdk"
import { Layer } from "effect"
import type { DurableTableError } from "effect-durable-operators"

interface AgentAdapterDrivenPipelineOptions {
  readonly baseUrl: string
  readonly namespace?: string
  readonly hostId?: string
  readonly mcpHost?: string
  readonly mcpPort?: number
  readonly mcpPath?: string
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
}

export const agentAdapterDrivenMcpUrl = (
  input: {
    readonly host: string
    readonly port: number
    readonly path: string
    readonly contextId: string
  },
): string => {
  const route = `${ensurePathInput(input.path).replace(/\/+$/, "")}/runtime-context/${
    encodeURIComponent(input.contextId)
  }`
  return new URL(route, `http://${input.host}:${input.port}`).toString()
}

export const tinyAgentAdapterDrivenPipeline = (
  options: AgentAdapterDrivenPipelineOptions,
): Layer.Layer<
  FiregridHost,
  DurableTableError | ServeError,
  never
> => {
  const namespace = options.namespace ?? `tiny-agent-adapter-${crypto.randomUUID()}`
  const hostId = options.hostId ?? "host-a"
  const mcpHost = options.mcpHost ?? "127.0.0.1"
  const mcpPath = options.mcpPath ?? "/mcp"
  const host = FiregridRuntimeHostLive({
    durableStreamsBaseUrl: options.baseUrl,
    namespace,
    hostId,
    hostSessionId: `${hostId}-session`,
    input: true,
    ...(options.localProcessEnv === undefined
      ? {}
      : { localProcessEnv: options.localProcessEnv }),
  })
  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return FiregridMcpServerLayer({
    host: mcpHost,
    port: options.mcpPort ?? 0,
    path: ensurePathInput(mcpPath),
  }).pipe(
    Layer.provideMerge(host),
  )
}
