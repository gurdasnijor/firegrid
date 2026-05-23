import { Clock, Effect, type Layer, Option, Schema } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import {
  ToolResultEventSchema,
  type ToolResultEvent,
} from "../events/index.ts"

// Shape C tool result identity per tf-28b8 (#676) / runtime-design-constraints
// C3: "Side effects complete by durable result identity. At-most-once semantics
// come from the durable result row identity, not from replay memoization inside
// a workflow body."
//
// The owning RuntimeContext handler fences a tool's external effect by
// insertOrGet on a `tool:<contextId>:<toolUseId>` row in
// `RuntimeToolResultTable`. A re-delivery / replay / restart point-reads the
// row instead of re-running the effect.
//
// Coordinates with CC2 RuntimeContext handler: the row schema below is the
// canonical at-most-once result fact for tool-use events. The handler
// reads/writes through `RuntimeToolResultStore` and emits the recorded
// `ToolResult` event downstream from the row. Do NOT introduce a parallel
// per-toolUseId result identity; this row IS the identity.

const RuntimeToolResultKeySchema = Schema.String.pipe(DurableTable.primaryKey)

// The full ToolResultEvent decode is intentionally lossless: the
// at-most-once fence is the row, and `event` carries the exact ToolResult the
// runtime emits on the row's first insert. Subsequent reads return the same
// event verbatim (first-valid-terminal-wins). Stored as JSON so the row schema
// stays additive against ToolResultEvent's evolution.
const RuntimeToolResultRowSchema = Schema.Struct({
  toolResultKey: RuntimeToolResultKeySchema,
  contextId: Schema.String,
  toolUseId: Schema.String,
  toolName: Schema.String,
  eventJson: Schema.String,
  completedAt: Schema.String,
}).annotations({
  identifier: "firegrid.runtime.tool_result_row",
  title: "Shape C runtime tool result row (durable at-most-once fence)",
})

export class RuntimeToolResultTable extends DurableTable(
  "firegrid.runtime.tool_results",
  { results: RuntimeToolResultRowSchema },
) {}

export const runtimeToolResultTableLayer = (
  options: DurableTableLayerOptions,
): Layer.Layer<RuntimeToolResultTable, never, never> =>
  RuntimeToolResultTable.layer(options) as Layer.Layer<
    RuntimeToolResultTable,
    never,
    never
  >

// Stable key constructor. Tool result identity is `(contextId, toolUseId)` —
// domain identity, NOT arrival order, per the cutover hard constraint.
export const runtimeToolResultKey = (
  contextId: string,
  toolUseId: string,
): string => `tool:${contextId}:${toolUseId}`

// Schema-driven JSON codec — replaces raw JSON.parse + decodeUnknown with a
// single round-trippable schema. parseJson lifts JSON.parse errors and
// ToolResultEvent decode errors into the same Effect error channel.
const ToolResultEventJsonSchema = Schema.parseJson(ToolResultEventSchema)

const decodeEvent = (
  json: string,
): Effect.Effect<ToolResultEvent, unknown> =>
  Schema.decode(ToolResultEventJsonSchema)(json)

const encodeEvent = (
  event: ToolResultEvent,
): Effect.Effect<string, unknown> =>
  Schema.encode(ToolResultEventJsonSchema)(event)

// Apply a Shape C at-most-once fence around `runEffect`. If the durable row
// already exists, returns the recorded ToolResult without invoking runEffect;
// otherwise runs the effect, writes the row, returns the result. Concurrent
// writers resolve via insertOrGet's Found branch (first-valid-terminal-wins).
//
// The effect's external side effect — calling the user's tool — happens BEFORE
// the row is written. Two callers that both observe "absent" can race and both
// execute the effect, with only one row persisting; closing that residual
// requires claimed-work discipline (a separate claim row). The owning Shape C
// RuntimeContext handler is per-key serialized, so the residual does not occur
// in the target topology.
export const runtimeToolResultAtMostOnce = (
  table: RuntimeToolResultTable["Type"],
  params: {
    readonly contextId: string
    readonly toolUseId: string
    readonly toolName: string
    readonly runEffect: Effect.Effect<ToolResultEvent, unknown, never>
  },
): Effect.Effect<ToolResultEvent, unknown, never> =>
  Effect.gen(function*() {
    const key = runtimeToolResultKey(params.contextId, params.toolUseId)
    const existing = yield* table.results.get(key)
    if (existing._tag === "Some") {
      yield* Effect.annotateCurrentSpan({
        "firegrid.tool_result.key": key,
        "firegrid.tool_result.source": "durable_row",
      })
      return yield* decodeEvent(existing.value.eventJson)
    }
    const event = yield* params.runEffect
    const completedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const eventJson = yield* encodeEvent(event)
    const written = yield* table.results.insertOrGet({
      toolResultKey: key,
      contextId: params.contextId,
      toolUseId: params.toolUseId,
      toolName: params.toolName,
      eventJson,
      completedAt,
    })
    if (written._tag === "Inserted") {
      yield* Effect.annotateCurrentSpan({
        "firegrid.tool_result.key": key,
        "firegrid.tool_result.source": "fresh_insert",
        "firegrid.tool_name": params.toolName,
      })
      return event
    }
    // Concurrent insert by another worker — the stored row is authoritative.
    yield* Effect.annotateCurrentSpan({
      "firegrid.tool_result.key": key,
      "firegrid.tool_result.source": "concurrent_found",
    })
    return yield* decodeEvent(written.row.eventJson)
  }).pipe(
    Effect.withSpan("firegrid.runtime.tool_result.at_most_once", {
      kind: "internal",
      attributes: {
        "firegrid.tool_result.shape": "C",
        "firegrid.context.id": params.contextId,
        "firegrid.tool.use_id": params.toolUseId,
      },
    }),
  )

// Read-only lookup. Useful for handler restart paths that want to short-circuit
// on a previously-recorded result before invoking the executor.
export const runtimeToolResultLookup = (
  table: RuntimeToolResultTable["Type"],
  contextId: string,
  toolUseId: string,
): Effect.Effect<Option.Option<ToolResultEvent>, unknown> =>
  table.results.get(runtimeToolResultKey(contextId, toolUseId)).pipe(
    Effect.flatMap(row =>
      row._tag === "Some"
        ? decodeEvent(row.value.eventJson).pipe(Effect.map(Option.some))
        : Effect.succeed(Option.none<ToolResultEvent>()),
    ),
  )
