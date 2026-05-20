import type { ServeError } from "@effect/platform/HttpServerError"
import {
  CallerOwnedFactStreams,
  durableStreamUrl,
  ensurePathInput,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  FiregridMcpServerLayer,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { Effect, Layer, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableError,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

// Scenario constants the driver shares (NOT a substrate API — just the
// names the prompt needs to know).
export const factSource = "wait-pre-attach.facts"
export const factCorrelationId = "wait-pre-attach-roundtrip"
export const factEventType = "human.gate.approved"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

class WaitPreAttachFactTable extends DurableTable("waitPreAttach", {
  facts: FactRowSchema,
}) {}

const factTableLayerOptions = (
  baseUrl: string,
  namespace: string,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(baseUrl, `${namespace}.waitPreAttach`),
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
    note: "pre-attached before agent attaches its wait_for",
  },
  acceptedAt: new Date().toISOString(),
})

// The pre-seed runs as part of the host layer's acquire. The fact is in
// the durable stream BEFORE the agent process is spawned, BEFORE the
// agent issues `wait_for`, BEFORE the runtime registers the wait. That's
// the "pre-attach" scenario the tf-pra bead asks about: does the wait
// router scan existing rows on attach, or does it only deliver
// future-arriving rows?
export const waitPreAttachHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const baseUrl = env.durableStreamsBaseUrl
  const namespace = env.namespace
  const mcpHost = "127.0.0.1"
  const mcpPath = "/mcp"

  const factTable = WaitPreAttachFactTable.layer(
    factTableLayerOptions(baseUrl, namespace),
  )

  // Host pre-seeds the fact at layer acquire. Span-instrumented so the
  // exact pre-seed timestamp is visible in the trace alongside the
  // agent's later wait_for activity.
  const seed = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* WaitPreAttachFactTable
      const row = preSeed()
      yield* table.facts.insertOrGet(row)
    }).pipe(
      Effect.withSpan("firegrid.wait_pre_attach.host.seed_fact", {
        kind: "internal",
        attributes: {
          "firegrid.wait_pre_attach.fact_source": factSource,
          "firegrid.wait_pre_attach.correlation_id": factCorrelationId,
          "firegrid.wait_pre_attach.event_type": factEventType,
        },
      }),
    ),
  ).pipe(Layer.provide(factTable))

  // Bind the durable table as the CallerOwnedFactStreams source for the
  // configured stream name. The runtime's wait_router reads from here
  // when the agent's wait_for source is `{ _tag: "CallerFact", stream }`.
  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(WaitPreAttachFactTable, table => ({
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
