import {
  durableStreamUrl,
} from "@firegrid/protocol/launch"
import { Schema } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

// tf-u8w2 — RuntimeContext target fact matrix, clean-room proof for tf-tvg1.
//
// Claim under test (docs/cannon/architecture/runtime-design-constraints.md):
//   C1 a RuntimeContext is keyed durable state addressed by `contextId`;
//   C2 the handler is a (state, fact) reducer, not a long-lived body;
//   C4 async waits are durable completions keyed by domain id
//      (`tool:<contextId>:<toolUseId>`, `permission:<permissionRequestId>`),
//      reconstructed from durable records — NOT a cross-event DurableDeferred
//      mailbox, NOT arrival-order matched;
//   C6 the dense raw TextChunk output is a SEPARATE source the RuntimeContext
//      subscriber never scans; state advances from sparse facts only;
//   C7 fact/state/identity/result schemas are first-class.
//
// Two contexts (CTX-A, CTX-B) prove every fact kind routes BY contextId to the
// per-key subscriber, in isolation.

// --- Per-key RuntimeContext subscriber state (C1, C2) -----------------------
// The analogue of RuntimeContextEventState in production runtime-context.ts —
// but persisted and keyed by contextId, reloaded on every processing entry, so
// no in-memory waiter has to survive a replay (C4 reconstruction).
const ContextStateRowSchema = Schema.Struct({
  contextId: Schema.String.pipe(DurableTable.primaryKey),
  status: Schema.Literal("open", "working", "complete"),
  // Cursor over the SPARSE fact log for this context. Point-addressed:
  // the subscriber reads `${contextId}/${lastFactSeq + 1}` and never re-walks.
  lastFactSeq: Schema.Number,
  // Durable pending waits, keyed by domain id. These are the durable
  // completions of C4 — they survive a reload because they ARE the state, not
  // a fiber parked on a deferred.
  pendingToolWaits: Schema.Array(Schema.String),
  pendingPermissionWaits: Schema.Array(Schema.String),
  // Resolutions that arrived before the opening transition (out of arrival
  // order). Stashed durably so the later opening transition matches by id even
  // across a replay boundary.
  earlyToolResults: Schema.Array(Schema.String),
  earlyPermissionResponses: Schema.Array(Schema.String),
  resolvedToolWaits: Schema.Array(Schema.String),
  resolvedPermissionWaits: Schema.Array(Schema.String),
  // # of sparse facts the reducer has applied. The whole point: this equals
  // the count of sparse facts and is INDEPENDENT of how many dense raw output
  // rows exist.
  factHandlerInvocations: Schema.Number,
  // Must stay 0 forever: the subscriber never reads the raw output table.
  denseOutputReads: Schema.Number,
  // # of point-reads over the fact log (hits + the tail miss per drain). The
  // O() numerator — bounded by sparse facts, never by raw output volume.
  factReadCount: Schema.Number,
  // # of times state was reloaded from the table (one per processing entry /
  // replay boundary). Proves reconstruction from durable state.
  reloadCount: Schema.Number,
  terminalResult: Schema.optional(Schema.String),
  // first-valid-terminal-wins: stays 1 even if a duplicate terminal fact is
  // re-sent (fact identity dedupes it before the reducer ever sees a second).
  terminalCount: Schema.Number,
  updatedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyFactMatrix.contextStateRow",
  title: "Per-key RuntimeContext subscriber state row",
})
export type ContextStateRow = Schema.Schema.Type<typeof ContextStateRowSchema>

// --- Sparse RuntimeContext fact log (C6 typed source) -----------------------
// The ONLY source the subscriber reads. Each row is a state-relevant fact;
// dense TextChunk output is NOT here. Point-addressed by `${contextId}/${seq}`.
const FactRowSchema = Schema.Struct({
  factKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  seq: Schema.Number,
  kind: Schema.Literal(
    "input",
    "output_transition",
    "permission_response",
    "tool_result",
    "terminal",
  ),
  // For output_transition: what wait this transition opens (if any).
  opens: Schema.optional(Schema.Literal("tool", "permission")),
  toolUseId: Schema.optional(Schema.String),
  permissionRequestId: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  appendedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyFactMatrix.factRow",
  title: "Sparse RuntimeContext fact",
})
export type FactRow = Schema.Schema.Type<typeof FactRowSchema>

// --- Dense raw output stream (C6 separate source) ---------------------------
// UI/telemetry only. The subscriber NEVER reads this table. Its volume is the
// noise the production re-walk problem came from; here it provably cannot reach
// the RuntimeContext handler.
const RawOutputRowSchema = Schema.Struct({
  rawKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  seq: Schema.Number,
  text: Schema.String,
  appendedAt: Schema.String,
}).annotations({
  identifier: "firegrid.tinyFactMatrix.rawOutputRow",
  title: "Dense raw TextChunk output (UI/telemetry only)",
})
export type RawOutputRow = Schema.Schema.Type<typeof RawOutputRowSchema>

// --- Resolution audit (C3/C4 durable result identity) -----------------------
// One row per resolved wait, keyed by the correlation key. Idempotent by that
// key. `matchedOrder` records whether the opening transition or the resolution
// was processed first — proving the match is by id, surviving reordering.
const ResolutionRowSchema = Schema.Struct({
  resolutionKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  waitKind: Schema.Literal("tool", "permission"),
  correlationId: Schema.String,
  matchedOrder: Schema.Literal("open_first", "resolve_first"),
  // The seq of the fact that completed the rendezvous (the resolution fact for
  // open_first, the opening transition for resolve_first). Order analysis lives
  // in the driver, over this + the facts table.
  rendezvousSeq: Schema.Number,
  at: Schema.String,
}).annotations({
  identifier: "firegrid.tinyFactMatrix.resolutionRow",
  title: "Durable wait resolution (matched by id)",
})
export type ResolutionRow = Schema.Schema.Type<typeof ResolutionRowSchema>

export class FactMatrixTable extends DurableTable(
  "tinyFactMatrixTable",
  {
    contexts: ContextStateRowSchema,
    facts: FactRowSchema,
    rawOutput: RawOutputRowSchema,
    resolutions: ResolutionRowSchema,
  },
) {}

export const factMatrixTableOptions = (
  env: TinyFiregridHostEnv,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(
      env.durableStreamsBaseUrl,
      `${env.namespace}.runtime-context-fact-matrix.${env.runId}`,
    ),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

export const toolKey = (contextId: string, toolUseId: string) =>
  `tool:${contextId}:${toolUseId}`

export const permissionKey = (permissionRequestId: string) =>
  `permission:${permissionRequestId}`
