import { Clock, Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import { RuntimeObservationStreams } from "../../streams/index.ts"
import type { RuntimeObservationSource } from "../../streams/sources.ts"
import {
  evaluateFieldEquals,
  type FieldEqualsTrigger,
} from "../../workflow-engine/workflows/field-equals.ts"

// Shape C wait routing per tf-28b8 (#676) / runtime-design-constraints C4:
// "Async waits are durable completions keyed by stable identity, reconstructed
// from durable wait + completion records, not from in-memory waiters."
//
// A wait is a row in `RuntimeWaitCompletionTable` keyed by `completionKey`. The
// waiter point-reads the row (snapshot-first) before evaluating the trigger.
// When the trigger matches (or times out), the waiter `insertOrGet`s the
// terminal row; first-valid-terminal-wins. A subsequent re-delivery sees the
// row and returns the recorded outcome without re-walking the source — the
// at-most-once and survives-restart property comes from the durable row, NOT
// from a workflow-engine `finalResult` memo (which was the wait-for.ts shape).

// ── Result/outcome contract ────────────────────────────────────────────────
// Identical to the public `WaitForWorkflowOutcome` shape so the dispatcher and
// host-sdk callers can be cut over verbatim. The dispatch contract is owned by
// this module now; `wait-for.ts` is deleted in this slice.
export const RuntimeWaitMatchOutcomeSchema = Schema.TaggedStruct("Match", {
  raw: Schema.Unknown,
  // tf-0xe4 wait_for_any: index of the winning source in [source, ...additionalSources].
  // Omitted for single wait_for (the workflow used to do the same).
  winnerIndex: Schema.optional(Schema.Number),
})

export const RuntimeWaitTimeoutOutcomeSchema = Schema.TaggedStruct("Timeout", {})

export const RuntimeWaitOutcomeSchema = Schema.Union(
  RuntimeWaitMatchOutcomeSchema,
  RuntimeWaitTimeoutOutcomeSchema,
)

export type RuntimeWaitOutcome = Schema.Schema.Type<typeof RuntimeWaitOutcomeSchema>

// ── Durable completion table (Shape C state ownership) ─────────────────────
// Keyed by `completionKey` (caller chooses; dispatcher uses
// `wait:<contextId>:<toolUseId>` / `wait-any:<contextId>:<toolUseId>`). The
// outcome JSON is stored as a string so the row schema does not bind to an
// open Unknown — the parse happens at read time through Schema.
const RuntimeWaitCompletionRowSchema = Schema.Struct({
  completionKey: Schema.String.pipe(DurableTable.primaryKey),
  outcomeJson: Schema.String,
  completedAt: Schema.String,
}).annotations({
  identifier: "firegrid.runtime.wait_completion_row",
  title: "Shape C runtime wait completion row",
})

export class RuntimeWaitCompletionTable extends DurableTable(
  "firegrid.runtime.wait_completions",
  { completions: RuntimeWaitCompletionRowSchema },
) {}

export const runtimeWaitCompletionTableLayer = (
  options: DurableTableLayerOptions,
): Layer.Layer<RuntimeWaitCompletionTable, never, never> =>
  RuntimeWaitCompletionTable.layer(options) as Layer.Layer<
    RuntimeWaitCompletionTable,
    never,
    never
  >

// ── Request / source / trigger contract ─────────────────────────────────────
export interface RuntimeWaitSourcePair {
  readonly source: RuntimeObservationSource
  readonly trigger: FieldEqualsTrigger
}

export interface RuntimeWaitForRequest extends RuntimeWaitSourcePair {
  readonly completionKey: string
  readonly additionalSources?: ReadonlyArray<RuntimeWaitSourcePair>
  readonly timeoutMs?: number
}

// ── The Shape C wait primitive (no @effect/workflow) ────────────────────────
// Step 1: snapshot the completion row; if present, decode and return.
// Step 2: race typed sources (Stream.runHead + trigger filter) with optional
//         timeout; the source is durable + replayable so re-execution is
//         deterministic.
// Step 3: insertOrGet the terminal outcome row; the Found branch (a concurrent
//         writer beat us) takes the stored outcome — first-valid-terminal-wins.
const streamForSource = (
  streams: RuntimeObservationStreams["Type"],
  source: RuntimeObservationSource,
): Stream.Stream<unknown, unknown> => {
  switch (source._tag) {
    case "AgentOutput":
      return streams.agentOutput
    case "AgentOutputAfter":
      return streams.agentOutputAfter(source)
    case "RuntimeRun":
      return streams.runtimeRun
    case "CallerFact":
      return streams.callerFact(source.stream)
  }
}

const matchOnePair = (
  streams: RuntimeObservationStreams["Type"],
  pair: RuntimeWaitSourcePair,
  winnerIndex: number,
  totalSources: number,
): Effect.Effect<RuntimeWaitOutcome, unknown> =>
  Stream.runHead(
    streamForSource(streams, pair.source).pipe(
      Stream.filter(row => evaluateFieldEquals(pair.trigger, row)),
    ),
  ).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.never,
      onSome: (raw): Effect.Effect<RuntimeWaitOutcome> =>
        Effect.succeed(
          totalSources > 1
            ? { _tag: "Match", raw, winnerIndex }
            : { _tag: "Match", raw },
        ),
    })),
  )

const runMatch = (
  streams: RuntimeObservationStreams["Type"],
  sources: ReadonlyArray<RuntimeWaitSourcePair>,
  timeoutMs: number | undefined,
): Effect.Effect<RuntimeWaitOutcome, unknown> => {
  const match = Effect.raceAll(
    sources.map((pair, index) => matchOnePair(streams, pair, index, sources.length)),
  )
  if (timeoutMs === undefined) return match
  // In-memory timeout — the completion row makes this restart-safe end-to-end:
  // a crash before the row is written re-enters here (new in-memory timer).
  // The narrow Shape D earn here would be a DurableClock-backed timeout if a
  // single wait must survive *mid-flight* crashes WITHOUT re-running the source;
  // for fact-driven match this is not load-bearing because the source is
  // replayable and the row write is the terminalization fence.
  return Effect.race(
    match,
    Effect.sleep(Duration.millis(timeoutMs)).pipe(
      Effect.as<RuntimeWaitOutcome>({ _tag: "Timeout" }),
    ),
  )
}

// Schema-driven JSON codec for the outcome. parseJson lifts JSON.parse and
// schema decode errors into the same Effect error channel.
const RuntimeWaitOutcomeJsonSchema = Schema.parseJson(RuntimeWaitOutcomeSchema)

const writeCompletion = (
  table: RuntimeWaitCompletionTable["Type"],
  completionKey: string,
  outcome: RuntimeWaitOutcome,
): Effect.Effect<RuntimeWaitOutcome, unknown> =>
  Effect.gen(function*() {
    const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const outcomeJson = yield* Schema.encode(RuntimeWaitOutcomeJsonSchema)(outcome)
    const written = yield* table.completions.insertOrGet({
      completionKey,
      outcomeJson,
      completedAt,
    })
    if (written._tag === "Inserted") return outcome
    // Concurrent writer beat us — decode the recorded outcome (first-valid-
    // terminal-wins). The stored value is what subsequent re-deliveries see.
    return yield* decodeOutcome(written.row.outcomeJson)
  })

const decodeOutcome = (
  json: string,
): Effect.Effect<RuntimeWaitOutcome, unknown> =>
  Schema.decode(RuntimeWaitOutcomeJsonSchema)(json)

const readExistingOutcome = (
  table: RuntimeWaitCompletionTable["Type"],
  completionKey: string,
): Effect.Effect<Option.Option<RuntimeWaitOutcome>, unknown> =>
  table.completions.get(completionKey).pipe(
    Effect.flatMap(row =>
      row._tag === "Some"
        ? decodeOutcome(row.value.outcomeJson).pipe(Effect.map(Option.some))
        : Effect.succeed(Option.none<RuntimeWaitOutcome>()),
    ),
  )

export const runtimeWaitForMatch = (
  request: RuntimeWaitForRequest,
): Effect.Effect<
  RuntimeWaitOutcome,
  unknown,
  RuntimeObservationStreams | RuntimeWaitCompletionTable
> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- DurableTable.layer still leaks `any` through its R channel; the declared Effect R channel is the intended capability boundary.
  Effect.gen(function*() {
    const table = yield* RuntimeWaitCompletionTable
    const existing = yield* readExistingOutcome(table, request.completionKey)
    if (existing._tag === "Some") {
      yield* Effect.annotateCurrentSpan({
        "firegrid.wait.completion_key": request.completionKey,
        "firegrid.wait.outcome.source": "durable_row",
      })
      return existing.value
    }
    const streams = yield* RuntimeObservationStreams
    const sources: ReadonlyArray<RuntimeWaitSourcePair> = [
      { source: request.source, trigger: request.trigger },
      ...(request.additionalSources ?? []),
    ]
    const outcome = yield* runMatch(streams, sources, request.timeoutMs)
    const recorded = yield* writeCompletion(table, request.completionKey, outcome)
    yield* Effect.annotateCurrentSpan({
      "firegrid.wait.completion_key": request.completionKey,
      "firegrid.wait.outcome.source": "freshly_matched",
      "firegrid.wait.outcome.tag": recorded._tag,
      "firegrid.wait.source_count": sources.length,
      "firegrid.wait.has_timeout": request.timeoutMs !== undefined,
    })
    return recorded
  }).pipe(
    Effect.withSpan("firegrid.runtime.wait_for_match", {
      kind: "internal",
      attributes: {
        "firegrid.wait.shape": "C",
        "firegrid.wait.completion_key": request.completionKey,
        "firegrid.wait.source": request.source._tag,
      },
    }),
  )

// Stable completion key constructors. The dispatcher uses these so the
// generated keys remain identical across the wait-for-workflow → Shape C
// transition (so existing duplicate-suppression tests keep matching).
export const runtimeWaitForCompletionKey = (
  contextId: string,
  toolUseId: string,
): string => `wait:${contextId}:${toolUseId}`

export const runtimeWaitForAnyCompletionKey = (
  contextId: string,
  toolUseId: string,
): string => `wait-any:${contextId}:${toolUseId}`

// Service tag wrapper for hosts that prefer DI over the bare DurableTable.
// (Optional — direct DurableTable wiring already works.) Useful for tests that
// want to swap an in-memory completion store.
interface RuntimeWaitCompletionStoreService {
  readonly read: (
    completionKey: string,
  ) => Effect.Effect<Option.Option<RuntimeWaitOutcome>, unknown>
  readonly write: (
    completionKey: string,
    outcome: RuntimeWaitOutcome,
  ) => Effect.Effect<RuntimeWaitOutcome, unknown>
}

export class RuntimeWaitCompletionStore extends Context.Tag(
  "@firegrid/runtime/RuntimeWaitCompletionStore",
)<RuntimeWaitCompletionStore, RuntimeWaitCompletionStoreService>() {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- DurableTable.layer leaks `any`; the declared Layer R channel is the intended capability boundary.
export const RuntimeWaitCompletionStoreLive: Layer.Layer<
  RuntimeWaitCompletionStore,
  never,
  RuntimeWaitCompletionTable
> = Layer.effect(
  RuntimeWaitCompletionStore,
  Effect.gen(function*() {
    const table = yield* RuntimeWaitCompletionTable
    return {
      read: completionKey => readExistingOutcome(table, completionKey),
      write: (completionKey, outcome) =>
        writeCompletion(table, completionKey, outcome),
    }
  }),
)
