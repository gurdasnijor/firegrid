import { Context, Effect, Layer, Option, Stream } from "effect"
import type { WaitKey } from "./keys.ts"
import { waitKeySpanAttributes } from "./observability.ts"
import {
  DurableToolsTable,
  findWaitByKey,
  type WaitRow,
} from "./table.ts"

// firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.5
// firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.7
// firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.9
// firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.11
//
// Shape C (Step 2 + Step 3 — docs/research/durable-tools-vs-workflow-engine-convergence.md):
// the durable-wait store collapses to the minimal pending-wait index. The
// `WaitCompletionRow` family of tags (Lookup + Upsert) was deleted along with
// the underlying table — `DurableDeferred.raceAll`'s race deferred is the
// arbiter; idempotent `engine.deferredDone` makes the second arbitration
// mechanism redundant.
export interface DurableWaitRowLookupService {
  readonly find: (
    waitKey: WaitKey,
  ) => Effect.Effect<Option.Option<WaitRow>, unknown>
}

export interface DurableWaitRowUpsertService {
  readonly upsert: (
    row: WaitRow,
  ) => Effect.Effect<void, unknown>
}

const findWaitIn = findWaitByKey

const durableWaitBucketAttribute = {
  "firegrid.wait.bucket": "durable",
} as const

const upsertWaitTo = (
  table: DurableToolsTable["Type"],
  row: WaitRow,
) => table.waits.upsert(row)

const waitRowsFrom = (
  table: DurableToolsTable["Type"],
): Stream.Stream<WaitRow, unknown> =>
  table.waits.rows().pipe(
    Stream.withSpan("firegrid.durable_tools.wait_store.wait_rows", {
      kind: "internal",
      attributes: durableWaitBucketAttribute,
    }),
  )

export class DurableWaitRowLookup extends Context.Tag(
  "@firegrid/runtime/DurableWaitRowLookup",
)<DurableWaitRowLookup, DurableWaitRowLookupService>() {}

export class DurableWaitRowUpsert extends Context.Tag(
  "@firegrid/runtime/DurableWaitRowUpsert",
)<DurableWaitRowUpsert, DurableWaitRowUpsertService>() {}

export class DurableWaitRows extends Context.Tag(
  "@firegrid/runtime/DurableWaitRows",
)<DurableWaitRows, Stream.Stream<WaitRow, unknown>>() {}

export const DurableWaitStoreLive = Layer.mergeAll(
  Layer.effect(
    DurableWaitRowLookup,
    Effect.map(DurableToolsTable, table => ({
      find: waitKey =>
        findWaitIn(table, waitKey).pipe(
          Effect.tap((row) =>
            Effect.annotateCurrentSpan({
              "firegrid.wait.row_found": Option.isSome(row),
            })),
          Effect.withSpan("firegrid.durable_tools.wait_store.wait.find", {
            kind: "internal",
            attributes: {
              ...durableWaitBucketAttribute,
              ...waitKeySpanAttributes(waitKey),
            },
          }),
        ),
    })),
  ),
  Layer.effect(
    DurableWaitRowUpsert,
    Effect.map(DurableToolsTable, table => ({
      upsert: row =>
        upsertWaitTo(table, row).pipe(
          Effect.withSpan("firegrid.durable_tools.wait_store.wait.upsert", {
            kind: "internal",
            attributes: {
              ...durableWaitBucketAttribute,
              ...waitKeySpanAttributes(row.waitKey),
              "firegrid.wait.status": row.status,
              "firegrid.wait.source": row.source._tag,
            },
          }),
        ),
    })),
  ),
  Layer.effect(
    DurableWaitRows,
    Effect.map(DurableToolsTable, waitRowsFrom),
  ),
)
