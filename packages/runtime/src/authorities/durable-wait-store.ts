import { Context, Effect, Layer, Option } from "effect"
import type { Stream } from "effect"
import type { WaitKey } from "../waits/internal/keys.ts"
import {
  DurableToolsTable,
  findWaitByKey,
  type WaitCompletionRow,
  type WaitRow,
} from "../waits/internal/table.ts"
import type { WaitForOutcome } from "../waits/internal/types.ts"
import type { WaitForOptions } from "../waits/internal/wait-for.ts"

interface DurableWaitStoreWriteService {
  readonly findWait: (
    waitKey: WaitKey,
  ) => Effect.Effect<Option.Option<WaitRow>, unknown>
  readonly findCompletion: (
    waitKey: WaitKey,
  ) => Effect.Effect<Option.Option<WaitCompletionRow>, unknown>
  readonly upsertWait: (
    row: WaitRow,
  ) => Effect.Effect<void, unknown>
  readonly upsertCompletion: (
    row: WaitCompletionRow,
  ) => Effect.Effect<void, unknown>
  readonly completions: Effect.Effect<ReadonlyArray<WaitCompletionRow>, unknown>
  readonly activeWaits: Stream.Stream<WaitRow, unknown>
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

const serviceFromTable = (
  table: DurableToolsTable["Type"],
): DurableWaitStoreWriteService => ({
  findWait: waitKey => findWaitIn(table, waitKey),
  findCompletion: waitKey => findCompletionIn(table, waitKey),
  upsertWait: row => upsertWaitTo(table, row),
  upsertCompletion: row => upsertCompletionTo(table, row),
  completions: completionsIn(table),
  activeWaits: activeWaitsIn(table),
})

export class DurableWaitStore extends Context.Tag(
  "@firegrid/runtime/DurableWaitStore",
)<DurableWaitStore, DurableWaitStoreWriteService>() {
}

export class DurableWaitForMatching extends Context.Tag(
  "@firegrid/runtime/DurableWaitForMatching",
)<DurableWaitForMatching, DurableWaitForMatchingService>() {}

export const DurableWaitStoreLive = Layer.effect(
  DurableWaitStore,
  Effect.map(DurableToolsTable, serviceFromTable),
)

export interface DurableWaitForMatchingService {
  readonly match: <A>(
    options: WaitForOptions<A>,
  ) => Effect.Effect<WaitForOutcome<A>, unknown, unknown>
}
