import type { ServeError } from "@effect/platform/HttpServerError"
import {
  durableStreamUrl,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  type FiregridHost,
} from "@firegrid/host-sdk"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
} from "@firegrid/runtime/producers/codecs/mcp"
import { CallerOwnedFactStreams } from "@firegrid/runtime/streams"
import { Effect, Layer, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableError,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const factSource = "workflow-core-paths.facts"
export const factCorrelationId = "workflow-core-paths"
export const factEventType = "shape-a.empirical.wait-ready"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

class WorkflowCorePathsFactTable extends DurableTable("workflowCorePaths", {
  facts: FactRowSchema,
}) {}

const factTableLayerOptions = (
  baseUrl: string,
  namespace: string,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(baseUrl, `${namespace}.workflowCorePaths`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const preSeed = () => ({
  factId: `${factSource}:${factCorrelationId}:${factEventType}`,
  source: factSource,
  eventType: factEventType,
  correlationId: factCorrelationId,
  payload: {
    decision: "approved",
    note: "seeded before wait_for registration for replay-path measurement",
  },
  acceptedAt: new Date().toISOString(),
})

export const workflowCorePathsHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const baseUrl = env.durableStreamsBaseUrl
  const namespace = env.namespace
  const mcpHost = "127.0.0.1"
  const mcpPath = "/mcp"

  const factTable = WorkflowCorePathsFactTable.layer(
    factTableLayerOptions(baseUrl, namespace),
  )

  const seed = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* WorkflowCorePathsFactTable
      yield* table.facts.insertOrGet(preSeed())
    }).pipe(
      Effect.withSpan("firegrid.workflow_core_paths.host.seed_fact", {
        kind: "internal",
        attributes: {
          "firegrid.workflow_core_paths.fact_source": factSource,
          "firegrid.workflow_core_paths.correlation_id": factCorrelationId,
          "firegrid.workflow_core_paths.event_type": factEventType,
        },
      }),
    ),
  ).pipe(Layer.provide(factTable))

  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(WorkflowCorePathsFactTable, table => ({
      // firegrid-runtime-boundary-reconciliation.SOURCE_COLLECTIONS.2
      streamFor: (stream: string) =>
        stream === factSource ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factTable))

  const appFacts = Layer.mergeAll(factTable, callerFacts, seed)

  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: baseUrl,
    namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    })),
  )

  const mcp = Layer.discard(
    FiregridMcpServerLayer({
      host: mcpHost,
      port: 0,
      path: ensurePathInput(mcpPath),
    }),
  )

  return mcp.pipe(
    Layer.provideMerge(host),
    Layer.provideMerge(appFacts),
  ) as Layer.Layer<FiregridHost, DurableTableError | ServeError, never>
}
