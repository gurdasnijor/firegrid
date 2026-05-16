import { Context, Effect, Layer, Option } from "effect"
import type { Stream } from "effect"
import type { WaitKey } from "./keys.ts"
import {
  DurableToolsTable,
  findWaitByKey,
  type WaitCompletionRow,
  type WaitRow,
} from "./table.ts"

export interface DurableWaitAppendAndGetService {
  readonly findWait: (
    waitKey: WaitKey,
  ) => Effect.Effect<Option.Option<WaitRow>, unknown>
  readonly upsertWait: (
    row: WaitRow,
  ) => Effect.Effect<void, unknown>
  readonly activeWaits: Stream.Stream<WaitRow, unknown>
}

export interface DurableWaitCompletionAppendAndGetService {
  readonly findCompletion: (
    waitKey: WaitKey,
  ) => Effect.Effect<Option.Option<WaitCompletionRow>, unknown>
  readonly upsertCompletion: (
    row: WaitCompletionRow,
  ) => Effect.Effect<void, unknown>
  readonly completions: Effect.Effect<ReadonlyArray<WaitCompletionRow>, unknown>
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

const completionsIn = (
  table: DurableToolsTable["Type"],
) => table.completions.query((coll) => coll.toArray)

const activeWaitsIn = (
  table: DurableToolsTable["Type"],
): Stream.Stream<WaitRow, unknown> =>
  table.waits.subscribe<WaitRow>((coll, emit) => {
    const sub = coll.subscribeChanges(
      (changes) => {
        changes.forEach((change) => {
          if (change.value === undefined || change.value === null) return
          if (change.value.status !== "active") return
          emit(change.value)
        })
      },
      { includeInitialState: true },
    )
    return () => sub.unsubscribe()
  })

const waitAppendAndGetFromTable = (
  table: DurableToolsTable["Type"],
): DurableWaitAppendAndGetService => ({
  findWait: waitKey => findWaitIn(table, waitKey),
  upsertWait: row => upsertWaitTo(table, row),
  activeWaits: activeWaitsIn(table),
})

const waitCompletionAppendAndGetFromTable = (
  table: DurableToolsTable["Type"],
): DurableWaitCompletionAppendAndGetService => ({
  findCompletion: waitKey => findCompletionIn(table, waitKey),
  upsertCompletion: row => upsertCompletionTo(table, row),
  completions: completionsIn(table),
})

export class DurableWaitAppendAndGet extends Context.Tag(
  "@firegrid/runtime/DurableWaitAppendAndGet",
)<DurableWaitAppendAndGet, DurableWaitAppendAndGetService>() {}

export class DurableWaitCompletionAppendAndGet extends Context.Tag(
  "@firegrid/runtime/DurableWaitCompletionAppendAndGet",
)<DurableWaitCompletionAppendAndGet, DurableWaitCompletionAppendAndGetService>() {}

export const DurableWaitStoreLive = Layer.mergeAll(
  Layer.effect(
    DurableWaitAppendAndGet,
    Effect.map(DurableToolsTable, waitAppendAndGetFromTable),
  ),
  Layer.effect(
    DurableWaitCompletionAppendAndGet,
    Effect.map(DurableToolsTable, waitCompletionAppendAndGetFromTable),
  ),
)
