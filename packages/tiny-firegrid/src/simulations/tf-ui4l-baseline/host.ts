import type { ServeError } from "@effect/platform/HttpServerError"
import { Activity, Workflow } from "@effect/workflow"
import {
  CallerOwnedFactStreams,
  durableStreamUrl,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  type FiregridHost,
} from "@firegrid/host-sdk"
import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableError,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

export const FACT_SOURCE = "tf-ui4l.caller-facts"
export const FACT_EVENT_TYPE_MATCH = "tf-ui4l.match"
export const FACT_EVENT_TYPE_NOISE = "tf-ui4l.noise"
export const FACT_CORRELATION_ID = "tf-ui4l-baseline"

export const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

export class TfUi4lFactTable extends DurableTable("tfUi4lBaseline", {
  facts: FactRowSchema,
}) {}

export const factTableLayerOptions = (
  baseUrl: string,
  namespace: string,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(baseUrl, `${namespace}.tfUi4lBaseline`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

// Numeric prefix in factId so subscribeChanges' alphabetical
// initial-state ordering = insertion order (match arrives LAST).
const seedRows = (correlationId: string) => {
  const ts = new Date().toISOString()
  return [
    {
      factId: `01-noise-${correlationId}`,
      source: FACT_SOURCE,
      eventType: FACT_EVENT_TYPE_NOISE,
      correlationId,
      payload: { kind: "noise", index: 1 },
      acceptedAt: ts,
    },
    {
      factId: `02-noise-${correlationId}`,
      source: FACT_SOURCE,
      eventType: FACT_EVENT_TYPE_NOISE,
      correlationId,
      payload: { kind: "noise", index: 2 },
      acceptedAt: ts,
    },
    {
      factId: `03-noise-${correlationId}`,
      source: FACT_SOURCE,
      eventType: FACT_EVENT_TYPE_NOISE,
      correlationId,
      payload: { kind: "noise", index: 3 },
      acceptedAt: ts,
    },
    {
      factId: `04-match-${correlationId}`,
      source: FACT_SOURCE,
      eventType: FACT_EVENT_TYPE_MATCH,
      correlationId,
      payload: { kind: "match", value: "the-needle" },
      acceptedAt: ts,
    },
  ]
}

// Output schema for the baseline workflow: the matched fact's identity.
const MatchedFactSchema = Schema.Struct({
  factId: Schema.String,
  matchedValue: Schema.Unknown,
})

// Baseline workflow's body: today's Activity.make + Stream.runHead pattern.
// Activity.make stores the entire Effect's exit durably; on replay, the
// stored Option<row> is returned without re-consuming the stream. If the
// activity is interrupted mid-stream, on resume it RE-OPENS the source
// from the head (no cursor) — the restart-replay weakness α addresses.
const FirstMatchActivity = Activity.make({
  name: "tf-ui4l.baseline.first-match",
  success: MatchedFactSchema,
  execute: Effect.gen(function*() {
    const table = yield* TfUi4lFactTable
    const head = yield* Stream.runHead(
      table.facts.rows().pipe(
        Stream.filter(row => row.eventType === FACT_EVENT_TYPE_MATCH),
      ),
    )
    return yield* Option.match(head, {
      onNone: () =>
        Effect.die(
          "tf-ui4l-baseline: stream completed with no matching row",
        ),
      onSome: row =>
        Effect.succeed({
          factId: row.factId,
          matchedValue: row.payload,
        }),
    })
  }).pipe(
    Effect.orDie,
    Effect.withSpan("firegrid.tf_ui4l.baseline.first_match.execute", {
      kind: "internal",
      attributes: {
        "firegrid.tf_ui4l.shape": "baseline",
        "firegrid.tf_ui4l.activity.kind": "value-terminator",
      },
    }),
  ),
})

const EmitMarkerActivity = (matched: typeof MatchedFactSchema.Type) =>
  Activity.make({
    name: "tf-ui4l.baseline.emit-marker",
    execute: Effect.annotateCurrentSpan({
      "firegrid.tf_ui4l.shape": "baseline",
      "firegrid.tf_ui4l.matched_fact_id": matched.factId,
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l.baseline.emit_marker", {
        kind: "internal",
      }),
    ),
  })

const BaselineWorkflowPayloadSchema = Schema.Struct({ id: Schema.String })

const BaselineWorkflow = Workflow.make({
  name: "tf-ui4l-baseline-workflow",
  payload: BaselineWorkflowPayloadSchema,
  success: MatchedFactSchema,
  idempotencyKey: (payload: typeof BaselineWorkflowPayloadSchema.Type) =>
    payload.id,
})

const baselineWorkflowLayer = BaselineWorkflow.toLayer(() =>
  Effect.gen(function*() {
    // Workflow body: 3 lines (today's Activity-as-value-terminator + emit).
    const matched = yield* FirstMatchActivity
    yield* EmitMarkerActivity(matched)
    return matched
  }),
)

export const tfUi4lBaselineHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const baseUrl = env.durableStreamsBaseUrl
  const namespace = env.namespace

  const factTable = TfUi4lFactTable.layer(
    factTableLayerOptions(baseUrl, namespace),
  )

  const seed = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* TfUi4lFactTable
      for (const row of seedRows(FACT_CORRELATION_ID)) {
        yield* table.facts.insertOrGet(row)
      }
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l_baseline.host.seed_facts", {
        kind: "internal",
        attributes: {
          "firegrid.tf_ui4l.fact_source": FACT_SOURCE,
          "firegrid.tf_ui4l.correlation_id": FACT_CORRELATION_ID,
          "firegrid.tf_ui4l.seed_count": 4,
        },
      }),
    ),
  ).pipe(Layer.provide(factTable))

  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(TfUi4lFactTable, table => ({
      streamFor: (stream: string) =>
        stream === FACT_SOURCE ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factTable))

  const engineLayer = DurableStreamsWorkflowEngine.layer({
    streamUrl: durableStreamUrl(baseUrl, `${namespace}.tfUi4lBaselineEngine`),
  })

  const runBaselineWorkflow = Layer.scopedDiscard(
    Effect.gen(function*() {
      const result = yield* BaselineWorkflow.execute({
        id: `${FACT_CORRELATION_ID}-${env.runId}`,
      })
      yield* Effect.annotateCurrentSpan({
        "firegrid.tf_ui4l.workflow_result.fact_id": result.factId,
      })
      yield* env.stopSignal.complete
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l_baseline.host.run_workflow", {
        kind: "internal",
        attributes: { "firegrid.tf_ui4l.shape": "baseline" },
      }),
      Effect.provide(
        baselineWorkflowLayer.pipe(Layer.provideMerge(engineLayer)),
      ),
    ),
  ).pipe(Layer.provide(factTable))

  const appFacts = Layer.mergeAll(
    factTable,
    callerFacts,
    seed,
    runBaselineWorkflow,
  )

  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: baseUrl,
    namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [],
    })),
  )

  return host.pipe(
    Layer.provideMerge(appFacts),
  ) as Layer.Layer<FiregridHost, DurableTableError | ServeError, never>
}
