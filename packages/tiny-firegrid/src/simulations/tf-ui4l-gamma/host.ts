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

const FACT_SOURCE = "tf-ui4l.gamma.caller-facts"
const FACT_EVENT_TYPE_MATCH = "tf-ui4l.match"
const FACT_EVENT_TYPE_NOISE = "tf-ui4l.noise"
const FACT_CORRELATION_ID = "tf-ui4l-gamma"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

const FindStateSchema = Schema.Struct({
  found: Schema.Boolean,
  matchedFactId: Schema.NullOr(Schema.String),
  matchedValue: Schema.Unknown,
})

// Sugar γ's "engine-owned folded state" — a side DurableTable holding
// the activity's current fold state. Engine-integrated Activity.folded
// would persist this in workflow state. Per-step write proxies the
// engine's durability cost (design doc §6.5).
const GammaStateRowSchema = Schema.Struct({
  activityName: Schema.String.pipe(DurableTable.primaryKey),
  state: FindStateSchema,
  consumedOffset: Schema.Number,
  updatedAt: Schema.String,
})

class TfUi4lGammaTables extends DurableTable("tfUi4lGamma", {
  facts: FactRowSchema,
  gammaState: GammaStateRowSchema,
}) {}

const factTableLayerOptions = (
  baseUrl: string,
  namespace: string,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(baseUrl, `${namespace}.tfUi4lGamma`),
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

// Sugar γ: (state, event) => state step. Sugar drives the stream,
// applies step per event, durably writes state per step, terminates via
// takeUntil(state.found).
//
// Observation (per design doc §3 + §3.5): γ's natural shape is
// "compute aggregate state forever"; "find first match" requires
// bolting on a takeUntil/done-predicate. Per-step state writes are
// strictly more expensive than α's per-emit cursor writes — full state
// payload vs offset integer — but the FINDING's recommendation hinges
// on whether the comparison is "find-first" or "aggregate-forever".
const FindActivityGamma = Activity.make({
  name: "tf-ui4l.gamma.find",
  success: FindStateSchema,
  execute: Effect.gen(function*() {
    const tables = yield* TfUi4lGammaTables

    // Resume seed: read durable state, fall back to empty.
    const stateRow = yield* tables.gammaState.get("tf-ui4l.gamma.find")
    const initialState: typeof FindStateSchema.Type = {
      found: false,
      matchedFactId: null,
      matchedValue: null,
    }
    const seed = Option.match(stateRow, {
      onNone: () => ({ seedState: initialState, seedOffset: 0 }),
      onSome: row => ({
        seedState: row.state,
        seedOffset: row.consumedOffset,
      }),
    })

    let offset = seed.seedOffset

    const step = (
      state: typeof FindStateSchema.Type,
      event: typeof FactRowSchema.Type,
    ): typeof FindStateSchema.Type =>
      state.found
        ? state
        : event.eventType === FACT_EVENT_TYPE_MATCH
          ? {
              found: true,
              matchedFactId: event.factId,
              matchedValue: event.payload,
            }
          : state

    const finalOpt = yield* Stream.runLast(
      tables.facts.rows().pipe(
        Stream.drop(seed.seedOffset),
        Stream.scanEffect(seed.seedState, (state, event) =>
          Effect.gen(function*() {
            const next = step(state, event)
            offset += 1
            yield* tables.gammaState.upsert({
              activityName: "tf-ui4l.gamma.find",
              state: next,
              consumedOffset: offset,
              updatedAt: new Date().toISOString(),
            })
            return next
          }).pipe(
            Effect.withSpan("firegrid.tf_ui4l.gamma.state_write", {
              kind: "internal",
              attributes: { "firegrid.tf_ui4l.shape": "gamma" },
            }),
          ),
        ),
        Stream.takeUntil(state => state.found),
      ),
    )

    // See tf-ui4l-baseline host's note on getOrThrow.
    const final = Option.getOrThrow(finalOpt)
    if (!final.found) {
      return yield* Effect.fail(new Error(
        "tf-ui4l-gamma: fold reached end-of-stream without state.found=true",
      ))
    }
    return final
  }).pipe(
    Effect.orDie,
    Effect.withSpan("firegrid.tf_ui4l.gamma.find.execute", {
      kind: "internal",
      attributes: {
        "firegrid.tf_ui4l.shape": "gamma",
        "firegrid.tf_ui4l.activity.kind": "folded-with-state",
      },
    }),
  ),
})

const EmitMarkerActivityGamma = (state: typeof FindStateSchema.Type) =>
  Activity.make({
    name: "tf-ui4l.gamma.emit-marker",
    execute: Effect.annotateCurrentSpan({
      "firegrid.tf_ui4l.shape": "gamma",
      "firegrid.tf_ui4l.matched_fact_id": state.matchedFactId ?? "<none>",
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l.gamma.emit_marker", {
        kind: "internal",
      }),
    ),
  })

const GammaWorkflowPayloadSchema = Schema.Struct({ id: Schema.String })

const GammaWorkflow = Workflow.make({
  name: "tf-ui4l-gamma-workflow",
  payload: GammaWorkflowPayloadSchema,
  success: MatchedFactSchema,
  idempotencyKey: (payload: typeof GammaWorkflowPayloadSchema.Type) =>
    payload.id,
})

const gammaWorkflowLayer = GammaWorkflow.toLayer(() =>
  Effect.gen(function*() {
    const final = yield* FindActivityGamma
    yield* EmitMarkerActivityGamma(final)
    // The body MUST translate γ's state back into the bead's "matched fact"
    // shape — another small ergonomic tax of γ for find-first-match.
    return {
      factId: final.matchedFactId ?? "",
      matchedValue: final.matchedValue,
    }
  }),
)

export const tfUi4lGammaHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, DurableTableError | ServeError, never> => {
  const baseUrl = env.durableStreamsBaseUrl
  const namespace = env.namespace

  const factTable = TfUi4lGammaTables.layer(
    factTableLayerOptions(baseUrl, namespace),
  )

  const seed = Layer.scopedDiscard(
    Effect.gen(function*() {
      const tables = yield* TfUi4lGammaTables
      yield* Effect.forEach(
        seedRows(FACT_CORRELATION_ID),
        row => tables.facts.insertOrGet(row),
        { discard: true },
      )
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l_gamma.host.seed_facts", {
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
    Effect.map(TfUi4lGammaTables, tables => ({
      streamFor: (stream: string) =>
        stream === FACT_SOURCE ? tables.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factTable))

  const engineLayer = DurableStreamsWorkflowEngine.layer({
    streamUrl: durableStreamUrl(baseUrl, `${namespace}.tfUi4lGammaEngine`),
  })

  const runGammaWorkflow = Layer.scopedDiscard(
    Effect.gen(function*() {
      const result = yield* GammaWorkflow.execute({
        id: `${FACT_CORRELATION_ID}-${env.runId}`,
      })
      yield* Effect.annotateCurrentSpan({
        "firegrid.tf_ui4l.workflow_result.fact_id": result.factId,
      })
      yield* env.stopSignal.complete
    }).pipe(
      Effect.withSpan("firegrid.tf_ui4l_gamma.host.run_workflow", {
        kind: "internal",
        attributes: { "firegrid.tf_ui4l.shape": "gamma" },
      }),
      Effect.provide(
        gammaWorkflowLayer.pipe(Layer.provideMerge(engineLayer)),
      ),
    ),
  ).pipe(Layer.provide(factTable))

  const appFacts = Layer.mergeAll(
    factTable,
    callerFacts,
    seed,
    runGammaWorkflow,
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
