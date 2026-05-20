import type { ServeError } from "@effect/platform/HttpServerError"
import {
  CallerOwnedFactStreams,
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridRuntimeHostLive,
  type FiregridHost,
  RuntimeEnvResolverPolicy,
  durableStreamUrl,
} from "@firegrid/host-sdk"
import { Effect, Layer, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { DurableTableError } from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

const darkFactorySource = "linear.oauth"
const darkFactoryFactSource = "darkFactory.facts"
const repoHint = "gurdasnijor/firegrid"

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

type DarkFactoryFactRow = Schema.Schema.Type<typeof DarkFactoryFactRowSchema>

class DarkFactoryFactTable extends DurableTable("darkFactory", {
  facts: DarkFactoryFactRowSchema,
}) {}

const darkFactoryFactTableLayerOptions = (options: {
  readonly baseUrl: string
  readonly namespace: string
}): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(options.baseUrl, `${options.namespace}.darkFactory`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const darkFactoryEnvPolicy = (
  env: NodeJS.ProcessEnv,
): Layer.Layer<RuntimeEnvResolverPolicy> =>
  RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    lookupEnv: name => env[name],
  })

const makeFactoryRunKey = (env: TinyFiregridHostEnv): string =>
  `${darkFactorySource}:issue-${env.runId}`

const makeTriggerFact = (
  env: TinyFiregridHostEnv,
  factoryRunKey: string,
): DarkFactoryFactRow => {
  const externalEntityKey = `issue-${env.runId}`
  return {
    factId: `${darkFactorySource}:${env.runId}:factory.trigger.accepted`,
    source: darkFactorySource,
    externalEventKey: `trigger-${env.runId}`,
    externalEntityKey,
    eventType: "factory.trigger.accepted",
    correlationId: factoryRunKey,
    stage: "trigger",
    status: "accepted",
    acceptedAt: new Date().toISOString(),
    payload: {
      delivery: "tiny-firegrid.simulate",
      linearIssueId: externalEntityKey,
      linearIdentifier: "TF-SIM-1",
      title: "Dark Factory tiny-firegrid choreography simulation",
      url: "https://linear.example/tiny-firegrid/TF-SIM-1",
      description:
        "Exercise factory-vision section 6 through Firegrid agent tools. The planner owns sequencing and must report public-surface gaps instead of relying on app orchestration.",
      repoHint,
    },
  }
}

const seedTriggerFactLayer = (
  env: TinyFiregridHostEnv,
  facts: Layer.Layer<DarkFactoryFactTable, DurableTableError>,
) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const table = yield* DarkFactoryFactTable
      yield* table.facts.insertOrGet(
        makeTriggerFact(env, makeFactoryRunKey(env)),
      )
    }),
  ).pipe(Layer.provide(facts))

export const darkFactoryHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  // Substrate-driven early stop belongs here by yielding env.stopSignal.complete,
  // not in the client-surface driver. Dark-factory leaves that to a follow-up.
  const hostId = "host-a"
  const mcpHost = "127.0.0.1"
  const mcpPath = "/mcp"
  // tf-s8y P0 spike: pin MCP port so the driver can construct the same
  // URL it writes into the per-session .mcp.json. Production would
  // resolve via FiregridRuntimeContextMcpBaseUrl; this is intentional
  // spike hygiene — fail loud on port collision, no silent ephemeral
  // drift. The pinned value matches FIREGRID_SPIKE_MCP_PORT in the
  // driver.
  const mcpPort = 54321
  const facts = DarkFactoryFactTable.layer(
    darkFactoryFactTableLayerOptions({
      baseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
    }),
  ) as Layer.Layer<DarkFactoryFactTable, DurableTableError>
  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(DarkFactoryFactTable, table => ({
      streamFor: (stream: string) =>
        stream === darkFactoryFactSource ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(facts))
  const seedTriggerFact = seedTriggerFactLayer(env, facts)
  const appFacts = Layer.mergeAll(facts, callerFacts, seedTriggerFact)
  const host = FiregridRuntimeHostLive(
    {
      durableStreamsBaseUrl: env.durableStreamsBaseUrl,
      namespace: env.namespace,
      hostId,
      hostSessionId: `${hostId}-session`,
      input: true,
    },
    darkFactoryEnvPolicy(env.processEnv),
  ).pipe(Layer.provideMerge(appFacts))

  // firegrid-observability.TINY_FIREGRID_SIMULATIONS.8
  // Public host factories infer an internal layer surface wider than FiregridHost.
  return Layer.discard(
    FiregridMcpServerLayer({
      host: mcpHost,
      port: mcpPort,
      path: ensurePathInput(mcpPath),
    }),
  ).pipe(
    Layer.provideMerge(host),
    Layer.provideMerge(appFacts),
  ) as Layer.Layer<FiregridHost, DurableTableError | ServeError, never>
}
