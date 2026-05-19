import type { ServeError } from "@effect/platform/HttpServerError"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridRuntimeHostLive,
  type FiregridHost,
  RuntimeEnvResolverPolicy,
  type RuntimeHostTopologyOptions,
} from "@firegrid/host-sdk"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Layer, Schema } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { DurableTableError } from "effect-durable-operators"

const DarkFactoryFactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  externalEventKey: Schema.String,
  externalEntityKey: Schema.String,
  eventType: Schema.String,
  contextId: Schema.optional(Schema.String),
  correlationId: Schema.String,
  stage: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  parentFactId: Schema.optional(Schema.String),
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

export type DarkFactoryFactRow = Schema.Schema.Type<typeof DarkFactoryFactRowSchema>

export class DarkFactoryFactTable extends DurableTable("darkFactory", {
  facts: DarkFactoryFactRowSchema,
}) {}

export const darkFactoryFactTableLayerOptions = (options: {
  readonly baseUrl: string
  readonly namespace: string
}): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(options.baseUrl, `${options.namespace}.darkFactory`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

interface DarkFactoryPipelineOptions {
  readonly baseUrl: string
  readonly namespace?: string
  readonly hostId?: string
  readonly mcpHost?: string
  readonly mcpPort?: number
  readonly mcpPath?: string
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
  readonly envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>
}

export const darkFactoryClaudeAcpEnvPolicy = (
  env: NodeJS.ProcessEnv,
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    lookupEnv: name => env[name],
  })

export const tinyDarkFactoryPipeline = (
  options: DarkFactoryPipelineOptions,
): Layer.Layer<
  FiregridHost,
  DurableTableError | ServeError,
  never
> => {
  const namespace = options.namespace ?? `tiny-dark-factory-${crypto.randomUUID()}`
  const hostId = options.hostId ?? "host-a"
  const mcpHost = options.mcpHost ?? "127.0.0.1"
  const mcpPath = options.mcpPath ?? "/mcp"
  const host = FiregridRuntimeHostLive(
    {
      durableStreamsBaseUrl: options.baseUrl,
      namespace,
      hostId,
      hostSessionId: `${hostId}-session`,
      input: true,
      ...(options.localProcessEnv === undefined
        ? {}
        : { localProcessEnv: options.localProcessEnv }),
    },
    options.envPolicy ?? RuntimeEnvResolverPolicy.denyAll,
  )
  const facts = DarkFactoryFactTable.layer(
    darkFactoryFactTableLayerOptions({ baseUrl: options.baseUrl, namespace }),
  )

  // firegrid-observability.TINY_FIREGRID_SIMULATIONS.8
  // The fact table is app-owned simulation state composed beside the host; it
  // does not install a factory workflow engine or phase driver.
  // TFIND-005: production host factories still return a layer whose public
  // surface is `FiregridHost` but whose inferred output channel is `any`.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return Layer.discard(
    FiregridMcpServerLayer({
      host: mcpHost,
      port: options.mcpPort ?? 0,
      path: ensurePathInput(mcpPath),
    }),
  ).pipe(
    Layer.provideMerge(host),
    Layer.provideMerge(facts),
  )
}
