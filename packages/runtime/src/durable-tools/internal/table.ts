/**
 * Durable-tools runtime-private DurableTable: minimal pending-wait index
 * (`waits` only — `completions` was deleted under Shape C Step 3).
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
 *
 * Shape C (Step 2 + Step 3, see docs/research/durable-tools-vs-workflow-engine-convergence.md):
 * the `completions` table is gone. Match/timeout arbitration is `DurableDeferred.raceAll`'s
 * race deferred + idempotent `engine.deferredDone`; the `completions` reads were a
 * redundant second mechanism. The remaining `waits` table is the minimal pending-wait
 * index the external (non-workflow-driven) router needs to rediscover work after a host
 * restart (doc lines 54-59). It records `status: "active" | "completed" | "timed_out"
 * | "retired"` because the lifecycle re-check at the dispatch boundary
 * (firegrid-durable-tools.LIFECYCLE.2) uses it to skip retired/completed waits.
 */

import { Effect, Option, Schema } from "effect"
import {
  DurableTable,
  type DurableTableHeaders,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"
import { RowOtelContextSchema } from "@firegrid/protocol/otel"
import { type WaitKey, WaitKeyEncoded } from "./keys.ts"
import {
  FieldEqualsTriggerSchema,
  RuntimeWaitSourceSchema,
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
  // firegrid-row-otel-propagation.ROW_OTEL.1 — trace context captured at
  // wait_for registration time, surfaced to the router as a SpanLink on
  // `complete_match` (the row-arrival is the parent; the registrar is the
  // additional causal predecessor).
  _otel: Schema.optional(RowOtelContextSchema),
})
export type WaitRow = Schema.Schema.Type<typeof WaitRowSchema>

const durableToolsSchemas = {
  waits: WaitRowSchema,
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
