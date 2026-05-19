import { Context, Effect, Layer, Option, Stream } from "effect"
import type { WaitKey } from "./keys.ts"
import {
  DurableToolsTable,
  findWaitByKey,
  type WaitCompletionRow,
  type WaitRow,
} from "./table.ts"

// firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.5
// firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.7
// firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.9
// firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.11
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

export interface DurableWaitCompletionRowLookupService {
  readonly find: (
    waitKey: WaitKey,
  ) => Effect.Effect<Option.Option<WaitCompletionRow>, unknown>
}

export interface DurableWaitCompletionRowUpsertService {
  readonly upsert: (
    row: WaitCompletionRow,
  ) => Effect.Effect<void, unknown>
}

const findWaitIn = findWaitByKey

const findCompletionIn = (
  table: DurableToolsTable["Type"],
  waitKey: WaitKey,
) =>
  table.completions.query((coll) =>
    Option.fromNullable(
      coll.toArray.find(
        (completion) =>
          completion.waitKey.executionId === waitKey.executionId &&
          completion.waitKey.name === waitKey.name,
      ),
    ))

const upsertWaitTo = (
  table: DurableToolsTable["Type"],
  row: WaitRow,
) => table.waits.upsert(row)

const upsertCompletionTo = (
  table: DurableToolsTable["Type"],
  row: WaitCompletionRow,
) => table.completions.upsert(row)

const waitRowsFrom = (
  table: DurableToolsTable["Type"],
): Stream.Stream<WaitRow, unknown> =>
  table.waits.rows().pipe(
    Stream.withSpan("firegrid.durable_tools.wait_store.wait_rows", {
      kind: "internal",
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

export class DurableWaitCompletionRowLookup extends Context.Tag(
  "@firegrid/runtime/DurableWaitCompletionRowLookup",
)<DurableWaitCompletionRowLookup, DurableWaitCompletionRowLookupService>() {}

export class DurableWaitCompletionRowUpsert extends Context.Tag(
  "@firegrid/runtime/DurableWaitCompletionRowUpsert",
)<DurableWaitCompletionRowUpsert, DurableWaitCompletionRowUpsertService>() {}

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
              "firegrid.workflow.execution_id": waitKey.executionId,
              "firegrid.wait.name": waitKey.name,
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
              "firegrid.workflow.execution_id": row.waitKey.executionId,
              "firegrid.wait.name": row.waitKey.name,
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
  Layer.effect(
    DurableWaitCompletionRowLookup,
    Effect.map(DurableToolsTable, table => ({
      find: waitKey =>
        findCompletionIn(table, waitKey).pipe(
          Effect.tap((row) =>
            Effect.annotateCurrentSpan({
              "firegrid.wait.completion_found": Option.isSome(row),
            })),
          Effect.withSpan("firegrid.durable_tools.wait_store.completion.find", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.execution_id": waitKey.executionId,
              "firegrid.wait.name": waitKey.name,
            },
          }),
        ),
    })),
  ),
  Layer.effect(
    DurableWaitCompletionRowUpsert,
    Effect.map(DurableToolsTable, table => ({
      upsert: row =>
        upsertCompletionTo(table, row).pipe(
          Effect.withSpan("firegrid.durable_tools.wait_store.completion.upsert", {
            kind: "internal",
            attributes: {
              "firegrid.workflow.execution_id": row.waitKey.executionId,
              "firegrid.wait.name": row.waitKey.name,
              "firegrid.wait.outcome": row.outcome,
            },
          }),
        ),
    })),
  ),
)
