import {
  durableStreamUrl,
} from "@firegrid/protocol/launch"
import { Schema } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

// tf-zjuf clean-room derisk for tf-aseo: prove that modeling the runtime-context
// merged-loop state as ONE workflow-owned DurableTable row (cursors PLUS the
// pending permission request/response sets) lets the workflow:
//   (1) reload loop state from the table on every replay boundary,
//   (2) advance a SKIP-style output cursor that never re-walks output history,
//   (3) still match permission request/response rendezvous across a replay,
// because the pending sets are durable state, not state rebuilt by re-walking
// outputs through memoized transitions (the tf-aseo blocker).

export const loopStateId = "perm-session"

// The single durable loop-state row. This is the analogue of
// `RuntimeContextEventState` in runtime-context.ts — but persisted, not threaded
// in-memory and reset to `initial` at the top of every replay.
const LoopStateRowSchema = Schema.Struct({
  loopStateId: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  // input cursor: last input sequence consumed.
  lastInputSequence: Schema.Number,
  // output cursor: last output sequence consumed. The skip cursor reads
  // `lastOutputSequence + 1` by point key and never re-walks <= this.
  lastOutputSequence: Schema.Number,
  // permission rendezvous state — the input-coupled state the tf-aseo blocker
  // says a skipping cursor would drop if it were rebuilt by re-walking outputs.
  pendingPermissionRequests: Schema.Array(Schema.String),
  pendingPermissionResponses: Schema.Array(Schema.String),
  processedInputCount: Schema.Number,
  processedOutputCount: Schema.Number,
  // # of times loop state was reloaded from the table (one per processing
  // entry / replay boundary). Proves state is reconstructed from the table,
  // not threaded in-memory.
  reloadCount: Schema.Number,
  // total output point-reads (hits + tail misses) — the O() numerator.
  outputReadCount: Schema.Number,
  // output point-reads that returned a row — must equal distinct outputs
  // (each output consumed exactly once, independent of reloadCount).
  outputHitCount: Schema.Number,
  // the strictly-increasing sequence of consumed output sequences, asserted to
  // be 1,2,3,... with no repeats => no replay re-walk.
  consumedOutputSequences: Schema.Array(Schema.Number),
  updatedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyLoopState.loopStateRow",
  title: "Workflow-owned durable loop-state row",
})
export type LoopStateRow = Schema.Schema.Type<typeof LoopStateRowSchema>

// Append-only input log, point-addressed by `${sessionId}/${sequence}`.
const LoopInputRowSchema = Schema.Struct({
  inputKey: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  sequence: Schema.Number,
  kind: Schema.Literal("prompt", "permission_response"),
  permissionRequestId: Schema.optional(Schema.String),
  body: Schema.String,
  acceptedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyLoopState.inputRow",
  title: "Workflow-owned input row",
})
export type LoopInputRow = Schema.Schema.Type<typeof LoopInputRowSchema>

// Append-only output log, point-addressed by `${sessionId}/${sequence}`.
const LoopOutputRowSchema = Schema.Struct({
  outputKey: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  sequence: Schema.Number,
  kind: Schema.Literal("text", "permission_request", "turn_complete"),
  permissionRequestId: Schema.optional(Schema.String),
  body: Schema.String,
  appendedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyLoopState.outputRow",
  title: "Workflow-owned output row",
})
export type LoopOutputRow = Schema.Schema.Type<typeof LoopOutputRowSchema>

// Action log: a row here is the durable proof that a permission request/response
// rendezvous matched and the response was "sent" to the agent. Idempotent by
// permissionRequestId so a replay cannot double-send.
const SentActionRowSchema = Schema.Struct({
  actionKey: Schema.String.pipe(DurableTable.primaryKey),
  sessionId: Schema.String,
  permissionRequestId: Schema.String,
  matchedOrder: Schema.Literal("request_first", "response_first"),
  at: Schema.String,
}).annotations({
  identifier: "firegrid.tinyLoopState.sentActionRow",
  title: "Permission response sent action",
})

export class LoopStateTable extends DurableTable(
  "tinyLoopStateTable",
  {
    loopState: LoopStateRowSchema,
    inputs: LoopInputRowSchema,
    outputs: LoopOutputRowSchema,
    sentActions: SentActionRowSchema,
  },
) {}

export const loopStateTableOptions = (
  env: TinyFiregridHostEnv,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(
      env.durableStreamsBaseUrl,
      `${env.namespace}.loop-state-table.${env.runId}`,
    ),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})
