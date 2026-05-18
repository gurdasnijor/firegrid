/**
 * Durable-tools runtime-private DurableTable: `waits` and `completions`.
 *
 * Implements:
 *  - firegrid-durable-tools.RUNTIME_BOUNDARY.1 — once per runtime-host scope
 *  - firegrid-durable-tools.RUNTIME_BOUNDARY.2 — lives under @firegrid/runtime
 *  - firegrid-durable-tools.BOUNDARIES.5 — no DurableConsumer / Projection
 *    revival
 *  - firegrid-durable-tools.BOUNDARIES.7 — writes via DurableTable generated
 *    actions; no raw stream append helpers
 *  - firegrid-durable-tools.BOUNDARIES.8 — no fenced-claim widening; dispatch
 *    idempotency is provided by deterministic wait keys and the per-dispatch
 *    re-check
 *  - firegrid-durable-tools.BOUNDARIES.9 — single declaration; no client
 *    duplicate
 */

import { Effect, Option, Schema } from "effect"
import {
  DurableTable,
  type DurableTableHeaders,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"
import { type WaitKey, WaitKeyEncoded } from "./keys.ts"
import {
  FieldEqualsTriggerSchema,
  RuntimeWaitSourceSchema,
  WaitOutcomeKindSchema,
  WaitStatusSchema,
} from "./types.ts"

export interface DurableToolsTableOptions {
  readonly streamUrl: string
  readonly headers?: DurableTableHeaders
  readonly contentType?: string
  readonly txTimeoutMs?: number
}

/**
 * A durable wait intent.
 *
 * `workflowName`, `executionId`, and `deferredName` together identify the
 * `@effect/workflow` deferred that wait_for awaits and the router resolves.
 *
 * firegrid-durable-tools.WAIT_FOR.2
 * firegrid-durable-tools.WAIT_FOR.6
 * firegrid-durable-tools.LIFECYCLE.1
 */
const WaitRowSchema = Schema.Struct({
  waitKey: WaitKeyEncoded.pipe(DurableTable.primaryKey),
  workflowName: Schema.String,
  executionId: Schema.String,
  deferredName: Schema.String,
  source: RuntimeWaitSourceSchema,
  trigger: FieldEqualsTriggerSchema,
  status: WaitStatusSchema,
  createdAtMs: Schema.Number,
  deadlineMs: Schema.optional(Schema.Number),
})
export type WaitRow = Schema.Schema.Type<typeof WaitRowSchema>

/**
 * Match/timeout arbitration record for live operation.
 *
 * `completeMatch` (match side) and `writeTimeoutCompletion` (timeout side)
 * read this table to enforce that exactly one of match/timeout writes a
 * completion; `matchedRowPayload` is the raw row from the source collection
 * (call-site Schema decoding happens in `wait_for`, not here). The
 * crash-recovery reconciler that previously also walked this table was
 * deleted — idempotent `deferredDone` + durable replay sources made it
 * redundant.
 *
 * This table is going away under Shape C: once match/timeout arbitration
 * moves onto `DurableDeferred.raceAll`, nothing reads `completions` and the
 * whole table is deleted. Do not add fields or lifecycle here — see
 * docs/research/durable-tools-vs-workflow-engine-convergence.md.
 *
 * firegrid-durable-tools.WAIT_FOR.7
 * firegrid-durable-tools.SUBSCRIPTION.3
 */
const WaitCompletionRowSchema = Schema.Struct({
  waitKey: WaitKeyEncoded.pipe(DurableTable.primaryKey),
  outcome: WaitOutcomeKindSchema,
  matchedRowPayload: Schema.optional(Schema.Unknown),
  completedAtMs: Schema.Number,
})
export type WaitCompletionRow = Schema.Schema.Type<
  typeof WaitCompletionRowSchema
>

const durableToolsSchemas = {
  waits: WaitRowSchema,
  completions: WaitCompletionRowSchema,
} as const

export class DurableToolsTable extends DurableTable(
  "firegrid.durableTools",
  durableToolsSchemas,
) {}

export type DurableToolsTableService = DurableTableService<
  typeof durableToolsSchemas
>

export const durableToolsTableLayerOptions = (
  options: DurableToolsTableOptions,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: options.streamUrl,
    contentType: options.contentType ?? "application/json",
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  },
  txTimeoutMs: options.txTimeoutMs ?? 2_000,
})

/**
 * Resolve a wait row by composite key via a `.query.toArray` scan rather
 * than `.get`. The `DurableTableCollectionFacade.get` index lookup misses
 * rows whose primary key is declared via `Schema.transformOrFail` (the
 * encoded-key index lookup does not match the upserted key in every Effect
 * Schema version we've tested). `.query.toArray` round-trips cleanly, so
 * lifecycle/recovery paths read through it instead.
 */
export const findWaitByKey = (
  table: DurableToolsTableService,
  waitKey: WaitKey,
) =>
  Effect.map(
    table.waits.query((coll) => coll.toArray),
    (rows) =>
      Option.fromNullable(
        rows.find(
          (r) =>
            r.waitKey.executionId === waitKey.executionId &&
            r.waitKey.name === waitKey.name,
        ),
      ),
  )
