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

export const FACT_SOURCE = "tf-ui4l.beta.caller-facts"
export const FACT_EVENT_TYPE_MATCH = "tf-ui4l.match"
export const FACT_EVENT_TYPE_NOISE = "tf-ui4l.noise"
export const FACT_CORRELATION_ID = "tf-ui4l-beta"

export const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

// Sugar β's "engine-owned subscription ack cursor" — a side DurableTable
// holding the last event-offset the handler has successfully processed.
// Engine-integrated Activity.subscribed would persist this in workflow
// state. Side table is a per-event-durability proxy (design doc §6.5).
const BetaAckRowSchema = Schema.Struct({
  activityName: Schema.String.pipe(DurableTable.primaryKey),
  lastAckOffset: Schema.Number,
  updatedAt: Schema.String,
})

export class TfUi4lBetaTables extends DurableTable("tfUi4lBeta", {
  facts: FactRowSchema,
  betaAck: BetaAckRowSchema,
}) {}

export const factTableLayerOptions = (
  baseUrl: string,
  namespace: string,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(baseUrl, `${namespace}.tfUi4lBeta`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

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

// Sugar β: `(event) => Effect<Option<A>>` handler shape. Engine drives
// the subscription, calls handler per event, durably acks each one, and
// terminates when the handler returns Option.some(value). The workflow
// body sees `yield* Subscription` returning the Some-value that
// terminated the fold.
//
// NOTE: this is what the bead defines β as (subscribed + last-ack
// cursor). The Option<A> termination IS the value channel — once we add
// it (we have to, for "find-first-match"), β collapses ergonomically
// toward γ. See design doc §3.5 — that observation IS the FINDING.
const SubscribeActivityBeta = Activity.make({
  name: "tf-ui4l.beta.subscribe",
  success: MatchedFactSchema,
  execute: Effect.gen(function*() {
    const tables = yield* TfUi4lBetaTables

    // Resume seed: read last-ack cursor.
    const ackRow = yield* tables.betaAck.get("tf-ui4l.beta.subscribe")
    const seedOffset = Option.match(ackRow, {
      onNone: () => 0,
      onSome: row => row.lastAckOffset,
    })

    let offset = seedOffset

    // β user-facing handler — `(event) => Effect<Option<MatchedFact>>`.
    // Option.some terminates with value; Option.none continues.
    const handler = (
      event: typeof FactRowSchema.Type,
    ): Effect.Effect<Option.Option<typeof MatchedFactSchema.Type>> =>
      event.eventType === FACT_EVENT_TYPE_MATCH
        ? Effect.succeed(
            Option.some({
              factId: event.factId,
              matchedValue: event.payload,
            }),
          )
        : Effect.succeed(Option.none())

    const matched = yield* Stream.runHead(
      tables.facts.rows().pipe(
        Stream.drop(seedOffset),
        // Engine invokes handler per event; ack only after success.
        Stream.mapEffect(event =>
          Effect.gen(function*() {
            const result = yield* handler(event)
            offset += 1
            yield* tables.betaAck.upsert({
              activityName: "tf-ui4l.beta.subscribe",
              lastAckOffset: offset,
              updatedAt: new Date().toISOString(),
            })
            return result
          }).pipe(
            Effect.withSpan("firegrid.tf_ui4l.beta.event_ack", {
              kind: "internal",
              attributes: {
                "firegrid.tf_ui4l.shape": "beta",
                "firegrid.tf_ui4l.beta.event_fact_id": event.factId,
              },
            }),
          ),
        ),
        Stream.filterMap(opt => opt),
      ),
    )

    return yield* Option.match(matched, {
      onNone: () =>
        Effect.die("tf-ui4l-beta: stream completed without handler.some()"),
      onSome: m => Effect.succeed(m),
    })
  }).pipe(
    Effect.orDie,
    Effect.withSpan("firegrid.tf_ui4l.beta.subscribe.execute", {
      kind: "internal",
      attributes: {
        "firegrid.tf_ui4l.shape": "beta",
        "firegrid.tf_ui4l.activity.kind": "subscribed-with-option-termination",
      },
    }),
  ),
})

const EmitMarkerActivityBeta = (matched: typeof MatchedFactSchema.Type) =>
  Activity.make({
    name: "tf-ui4l.beta.emit-marker",
    execute: Effect.annotateCurrentSpan({
      "firegrid.tf_ui4l.shape": "beta",
      "firegrid.tf_ui4l.matched_fact_id": matched.factId,
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l.beta.emit_marker", {
        kind: "internal",
      }),
    ),
  })

const BetaWorkflowPayloadSchema = Schema.Struct({ id: Schema.String })

const BetaWorkflow = Workflow.make({
  name: "tf-ui4l-beta-workflow",
  payload: BetaWorkflowPayloadSchema,
  success: MatchedFactSchema,
  idempotencyKey: (payload: typeof BetaWorkflowPayloadSchema.Type) =>
    payload.id,
})

const betaWorkflowLayer = BetaWorkflow.toLayer(() =>
  Effect.gen(function*() {
    const matched = yield* SubscribeActivityBeta
    yield* EmitMarkerActivityBeta(matched)
    return matched
  }),
)

export const tfUi4lBetaHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const baseUrl = env.durableStreamsBaseUrl
  const namespace = env.namespace

  const factTable = TfUi4lBetaTables.layer(
    factTableLayerOptions(baseUrl, namespace),
  )

  const seed = Layer.scopedDiscard(
    Effect.gen(function*() {
      const tables = yield* TfUi4lBetaTables
      for (const row of seedRows(FACT_CORRELATION_ID)) {
        yield* tables.facts.insertOrGet(row)
      }
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l_beta.host.seed_facts", {
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
    Effect.map(TfUi4lBetaTables, tables => ({
      streamFor: (stream: string) =>
        stream === FACT_SOURCE ? tables.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factTable))

  const engineLayer = DurableStreamsWorkflowEngine.layer({
    streamUrl: durableStreamUrl(baseUrl, `${namespace}.tfUi4lBetaEngine`),
  })

  const runBetaWorkflow = Layer.scopedDiscard(
    Effect.gen(function*() {
      const result = yield* BetaWorkflow.execute({
        id: `${FACT_CORRELATION_ID}-${env.runId}`,
      })
      yield* Effect.annotateCurrentSpan({
        "firegrid.tf_ui4l.workflow_result.fact_id": result.factId,
      })
      yield* env.stopSignal.complete
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l_beta.host.run_workflow", {
        kind: "internal",
        attributes: { "firegrid.tf_ui4l.shape": "beta" },
      }),
      Effect.provide(
        betaWorkflowLayer.pipe(Layer.provideMerge(engineLayer)),
      ),
    ),
  ).pipe(Layer.provide(factTable))

  const appFacts = Layer.mergeAll(
    factTable,
    callerFacts,
    seed,
    runBetaWorkflow,
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
