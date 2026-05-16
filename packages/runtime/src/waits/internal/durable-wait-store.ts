import { Context, Effect, Layer, Option, type Stream } from "effect"
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
  table.waits.subscribe<WaitRow>((coll, emit) => {
    const sub = coll.subscribeChanges(
      (changes) => {
        changes.forEach((change) => {
          if (change.value === undefined || change.value === null) return
          emit(change.value)
        })
      },
      { includeInitialState: true },
    )
    return () => sub.unsubscribe()
  })

const waitCompletionRowsFrom = (
  table: DurableToolsTable["Type"],
): Stream.Stream<WaitCompletionRow, unknown> =>
  table.completions.subscribe<WaitCompletionRow>((coll, emit) => {
    const sub = coll.subscribeChanges(
      (changes) => {
        changes.forEach((change) => {
          if (change.value === undefined || change.value === null) return
          emit(change.value)
        })
      },
      { includeInitialState: true },
    )
    return () => sub.unsubscribe()
  })

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

export class DurableWaitCompletionRows extends Context.Tag(
  "@firegrid/runtime/DurableWaitCompletionRows",
)<DurableWaitCompletionRows, Stream.Stream<WaitCompletionRow, unknown>>() {}

export const DurableWaitStoreLive = Layer.mergeAll(
  Layer.effect(
    DurableWaitRowLookup,
    Effect.map(DurableToolsTable, table => ({
      find: waitKey => findWaitIn(table, waitKey),
    })),
  ),
  Layer.effect(
    DurableWaitRowUpsert,
    Effect.map(DurableToolsTable, table => ({
      upsert: row => upsertWaitTo(table, row),
    })),
  ),
  Layer.effect(
    DurableWaitRows,
    Effect.map(DurableToolsTable, waitRowsFrom),
  ),
  Layer.effect(
    DurableWaitCompletionRowLookup,
    Effect.map(DurableToolsTable, table => ({
      find: waitKey => findCompletionIn(table, waitKey),
    })),
  ),
  Layer.effect(
    DurableWaitCompletionRowUpsert,
    Effect.map(DurableToolsTable, table => ({
      upsert: row => upsertCompletionTo(table, row),
    })),
  ),
  Layer.effect(
    DurableWaitCompletionRows,
    Effect.map(DurableToolsTable, waitCompletionRowsFrom),
  ),
)
