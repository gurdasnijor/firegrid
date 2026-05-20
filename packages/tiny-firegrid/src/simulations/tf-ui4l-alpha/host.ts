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

const FACT_SOURCE = "tf-ui4l.alpha.caller-facts"
const FACT_EVENT_TYPE_MATCH = "tf-ui4l.match"
const FACT_EVENT_TYPE_NOISE = "tf-ui4l.noise"
const FACT_CORRELATION_ID = "tf-ui4l-alpha"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

// Sugar α's "engine-owned emit cursor" — a side DurableTable that holds
// the activity's last-consumed offset. An engine-integrated
// Activity.streamed would store this in workflow state instead; the side
// table is a per-emit-write-rate proxy (design doc §6.5).
const AlphaCursorRowSchema = Schema.Struct({
  activityName: Schema.String.pipe(DurableTable.primaryKey),
  offset: Schema.Number,
  updatedAt: Schema.String,
})

class TfUi4lAlphaTables extends DurableTable("tfUi4lAlpha", {
  facts: FactRowSchema,
  alphaCursor: AlphaCursorRowSchema,
}) {}

const factTableLayerOptions = (
  baseUrl: string,
  namespace: string,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(baseUrl, `${namespace}.tfUi4lAlpha`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

// Use numeric prefix in factId so subscribeChanges' alphabetical
// initial-state ordering = insertion order. The experiment needs the
// match to arrive LAST (so the activity observes 3 noise rows before the
// match) — otherwise α's cursor-per-emit story is meaningless.
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

const MatchedFactSchema = Schema.Struct({
  factId: Schema.String,
  matchedValue: Schema.Unknown,
})

// Sugar α: workflow body sees `yield* FirstMatch` returning the matched
// row — IDENTICAL ergonomics to baseline. Sugar-α's delta is internal:
// the activity opens the stream itself, durably checkpoints a cursor per
// emit (engine-owned-cursor proxy). An engine-integrated
// Activity.streamed would seed from this cursor on restart instead of
// re-opening from head.
const FirstMatchActivityAlpha = Activity.make({
  name: "tf-ui4l.alpha.first-match",
  success: MatchedFactSchema,
  execute: Effect.gen(function*() {
    const tables = yield* TfUi4lAlphaTables

    // Resume seed: read durable cursor, fall back to 0 on first run.
    const cursorRow = yield* tables.alphaCursor.get(
      "tf-ui4l.alpha.first-match",
    )
    const seedOffset = Option.match(cursorRow, {
      onNone: () => 0,
      onSome: row => row.offset,
    })

    let offset = seedOffset
    const head = yield* Stream.runHead(
      tables.facts.rows().pipe(
        Stream.drop(seedOffset),
        // Per-emit durable cursor write — sugar's "engine tracks emit cursor".
        Stream.tap(_ =>
          Effect.gen(function*() {
            offset += 1
            yield* tables.alphaCursor.upsert({
              activityName: "tf-ui4l.alpha.first-match",
              offset,
              updatedAt: new Date().toISOString(),
            })
          }).pipe(
            Effect.withSpan("firegrid.tf_ui4l.alpha.cursor_write", {
              kind: "internal",
              attributes: { "firegrid.tf_ui4l.shape": "alpha" },
            }),
          ),
        ),
        Stream.filter(row => row.eventType === FACT_EVENT_TYPE_MATCH),
      ),
    )
    // See tf-ui4l-baseline host's note on getOrThrow.
    const row = Option.getOrThrow(head)
    return { factId: row.factId, matchedValue: row.payload }
  }).pipe(
    Effect.orDie,
    Effect.withSpan("firegrid.tf_ui4l.alpha.first_match.execute", {
      kind: "internal",
      attributes: {
        "firegrid.tf_ui4l.shape": "alpha",
        "firegrid.tf_ui4l.activity.kind": "streamed-with-cursor",
      },
    }),
  ),
})

const EmitMarkerActivityAlpha = (matched: typeof MatchedFactSchema.Type) =>
  Activity.make({
    name: "tf-ui4l.alpha.emit-marker",
    execute: Effect.annotateCurrentSpan({
      "firegrid.tf_ui4l.shape": "alpha",
      "firegrid.tf_ui4l.matched_fact_id": matched.factId,
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l.alpha.emit_marker", {
        kind: "internal",
      }),
    ),
  })

const AlphaWorkflowPayloadSchema = Schema.Struct({ id: Schema.String })

const AlphaWorkflow = Workflow.make({
  name: "tf-ui4l-alpha-workflow",
  payload: AlphaWorkflowPayloadSchema,
  success: MatchedFactSchema,
  idempotencyKey: (payload: typeof AlphaWorkflowPayloadSchema.Type) =>
    payload.id,
})

const alphaWorkflowLayer = AlphaWorkflow.toLayer(() =>
  Effect.gen(function*() {
    // Workflow body: SAME 3 lines as baseline. Sugar-α's delta lives in
    // the activity, not in the body.
    const matched = yield* FirstMatchActivityAlpha
    yield* EmitMarkerActivityAlpha(matched)
    return matched
  }),
)

export const tfUi4lAlphaHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const baseUrl = env.durableStreamsBaseUrl
  const namespace = env.namespace

  const factTable = TfUi4lAlphaTables.layer(
    factTableLayerOptions(baseUrl, namespace),
  )

  const seed = Layer.scopedDiscard(
    Effect.gen(function*() {
      const tables = yield* TfUi4lAlphaTables
      yield* Effect.forEach(
        seedRows(FACT_CORRELATION_ID),
        row => tables.facts.insertOrGet(row),
        { discard: true },
      )
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l_alpha.host.seed_facts", {
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
    Effect.map(TfUi4lAlphaTables, tables => ({
      streamFor: (stream: string) =>
        stream === FACT_SOURCE ? tables.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factTable))

  const engineLayer = DurableStreamsWorkflowEngine.layer({
    streamUrl: durableStreamUrl(baseUrl, `${namespace}.tfUi4lAlphaEngine`),
  })

  const runAlphaWorkflow = Layer.scopedDiscard(
    Effect.gen(function*() {
      const result = yield* AlphaWorkflow.execute({
        id: `${FACT_CORRELATION_ID}-${env.runId}`,
      })
      yield* Effect.annotateCurrentSpan({
        "firegrid.tf_ui4l.workflow_result.fact_id": result.factId,
      })
      yield* env.stopSignal.complete
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l_alpha.host.run_workflow", {
        kind: "internal",
        attributes: { "firegrid.tf_ui4l.shape": "alpha" },
      }),
      Effect.provide(
        alphaWorkflowLayer.pipe(Layer.provideMerge(engineLayer)),
      ),
    ),
  ).pipe(Layer.provide(factTable))

  const appFacts = Layer.mergeAll(
    factTable,
    callerFacts,
    seed,
    runAlphaWorkflow,
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
