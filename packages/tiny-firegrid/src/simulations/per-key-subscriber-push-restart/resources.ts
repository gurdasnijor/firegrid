import {
  durableStreamUrl,
} from "@firegrid/protocol/launch"
import { Schema } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

// tf-4fy3 clean-room proof for tf-tvg1: can substrate-native push/tail
// subscription route durable event rows to a per-key RuntimeContext subscriber
// with per-key serialization and restart recovery, with NO polling, NO external
// write+arm, and NO context-lifetime parked body?
//
// The substrate of record is `DurableTable` over a Durable Stream. The two
// collections below are the whole model:
//   - `events`  : the durable ordered facts (the analogue of the runtime-context
//                 input/tool-result/permission events). One row per
//                 (contextId, sequence). This is what a producer appends and
//                 what a subscriber tails.
//   - `state`   : the per-key durable subscriber state container (C1 of
//                 runtime-design-constraints.md: "Sessions Are Keyed Durable
//                 State Containers"). One row per contextId, holding the
//                 observation cursor and the derived fold. Between events the
//                 entity IS this row — there is no parked body.
//
// There is deliberately NO mailbox, NO per-sequence DurableDeferred, NO
// request/claim/completion family, NO write+arm bridge table. The only wakeup
// surface is `events.rows()` — the native replay-then-tail row stream.

export const contextPrefix = {
  globalSerial: "gs",
  unserialized: "un",
  perKeyRouter: "rt",
  crashRestart: "cr",
} as const

// One durable ordered fact for a key. Point-addressed by `${contextId}/${seq}`
// so a subscriber advances by a cursor point-read, never a dense scan.
const EventRowSchema = Schema.Struct({
  eventKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  // 1-based per-key sequence. The subscriber's cursor reads `cursor + 1` by
  // point key.
  sequence: Schema.Number,
  // Folded into the per-key state. Used so a double-process (a per-key
  // serialization failure) is observable as a wrong fold, independent of the
  // direct concurrency counters.
  value: Schema.Number,
  appendedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tf4fy3.eventRow",
  title: "Per-key durable ordered fact",
})
type EventRow = Schema.Schema.Type<typeof EventRowSchema>

// The per-key durable subscriber state container. This is the keyed durable
// state — reconstructed from the table on every materialization, never threaded
// in-memory across a restart.
const StateRowSchema = Schema.Struct({
  contextId: Schema.String.pipe(DurableTable.primaryKey),
  // observation cursor: last event sequence folded into `fold`.
  lastProcessedSequence: Schema.Number,
  // running fold over consumed event values.
  fold: Schema.Number,
  // the strictly-increasing sequence of consumed event sequences, asserted to
  // be 1,2,3,... with no repeats => per-key serial, no double-process.
  consumedSequences: Schema.Array(Schema.Number),
  // # of times this key's state was reloaded from the table (one per
  // materialization). Proves state is reconstructed from the table, including
  // after a restart, not threaded in-memory.
  reloadCount: Schema.Number,
  updatedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tf4fy3.stateRow",
  title: "Per-key durable subscriber state container",
})
export type StateRow = Schema.Schema.Type<typeof StateRowSchema>

export class PerKeyTable extends DurableTable(
  "tinyPerKeySubscriber",
  {
    events: EventRowSchema,
    state: StateRowSchema,
  },
) {}

export type PerKeyTableService = PerKeyTable["Type"]

// Every generation (producer + each subscriber generation, pre- and post-crash)
// uses this SAME url, so they all share one durable log. A fresh table layer
// over the same url is a faithful process restart: in-memory TanStack state is
// dropped, the durable rows persist.
export const perKeyTableOptions = (
  env: TinyFiregridHostEnv,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(
      env.durableStreamsBaseUrl,
      `${env.namespace}.per-key-subscriber-push-restart.${env.runId}`,
    ),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

export const eventKeyFor = (
  contextId: string,
  sequence: number,
): string => `${contextId}/${sequence}`

export const now = (): string => new Date().toISOString()

export const initialState = (contextId: string): StateRow => ({
  contextId,
  lastProcessedSequence: 0,
  fold: 0,
  consumedSequences: [],
  reloadCount: 0,
  updatedAt: now(),
})
