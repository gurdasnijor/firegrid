import {
  durableStreamUrl,
} from "@firegrid/protocol/launch"
import { Schema } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

// tf-jt8q clean-room prototype: tool/result roundtrip over workflow-owned tables
// with a durable skip cursor — NO ToolCallWorkflow, NO appendRuntimeInputDeferred,
// NO WorkflowEngineTable.deferreds-as-mailbox, NO input intents/dispatchers, NO
// replay-path scans. Proves an agent turn (ToolUse output -> tool result append
// -> TurnComplete output) is exactly-once on tool execution across replays and
// O(distinct outputs/results) with no replay amplification.

export const roundtripSessionId = "tool-roundtrip-session"

// The single durable loop-state row — the workflow's reconstructable progress.
const LoopStateRowSchema = Schema.Struct({
  loopStateId: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  // skip output cursor: last output sequence consumed; reads cursor+1 by point
  // key, never re-walks <= cursor.
  lastOutputSequence: Schema.Number,
  // durable set of toolUseIds already executed — guards re-execution so the
  // tool side effect runs exactly once across any number of replays.
  executedToolUses: Schema.Array(Schema.String),
  // genuine tool executions (insertOrGet -> Inserted). Must equal distinct
  // ToolUse outputs, independent of reloadCount (the side-effect-safety metric).
  toolExecutionCount: Schema.Number,
  // tool result rows appended (the roundtrip's middle phase).
  toolResultCount: Schema.Number,
  turnComplete: Schema.Boolean,
  // reloads of loop state from the table (one per processing pass / replay).
  reloadCount: Schema.Number,
  // total output point-reads (hits + tail misses) — the O() numerator.
  outputReadCount: Schema.Number,
  // output reads that returned a row; must equal distinct outputs (each
  // consumed exactly once, independent of reloadCount).
  outputHitCount: Schema.Number,
  // consumed output sequences; asserted strictly 1..N => no replay re-walk.
  consumedOutputSequences: Schema.Array(Schema.Number),
  updatedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyToolRoundtrip.loopStateRow",
  title: "Workflow-owned durable loop-state row",
})
export type LoopStateRow = Schema.Schema.Type<typeof LoopStateRowSchema>

// Append-only agent output log, point-addressed by `${sessionId}/${sequence}`.
const OutputRowSchema = Schema.Struct({
  outputKey: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  sequence: Schema.Number,
  kind: Schema.Literal("text", "tool_use", "turn_complete"),
  toolUseId: Schema.optional(Schema.String),
  body: Schema.String,
  appendedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyToolRoundtrip.outputRow",
  title: "Workflow-owned agent output row",
})
export type OutputRow = Schema.Schema.Type<typeof OutputRowSchema>

// Append-only tool result log, point-addressed by `${sessionId}/${toolUseId}`.
// insertOrGet on this key is what makes tool execution idempotent: a replay
// finds the existing result instead of running the tool again.
const ToolResultRowSchema = Schema.Struct({
  toolResultKey: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  toolUseId: Schema.String,
  requestedAtSequence: Schema.Number,
  result: Schema.String,
  at: Schema.String,
}).annotations({
  identifier: "firegrid.tinyToolRoundtrip.toolResultRow",
  title: "Workflow-owned tool result row",
})
export type ToolResultRow = Schema.Schema.Type<typeof ToolResultRowSchema>

export class ToolRoundtripTable extends DurableTable(
  "tinyToolRoundtripTable",
  {
    loopState: LoopStateRowSchema,
    outputs: OutputRowSchema,
    toolResults: ToolResultRowSchema,
  },
) {}

export const toolRoundtripTableOptions = (
  env: TinyFiregridHostEnv,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(
      env.durableStreamsBaseUrl,
      `${env.namespace}.tool-result-roundtrip.${env.runId}`,
    ),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})
