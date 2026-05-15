import { Context, Effect, Layer } from "effect"
import {
  type RuntimeAuthority,
  type RuntimeAuthorityCommand,
  type RuntimeAuthorityRead,
} from "../events/index.ts"
import { sourceCollectionHandle } from "../waits/internal/source-collections.ts"
import {
  DurableToolsTable,
  findWaitByKey,
  type WaitCompletionRow,
  type WaitRow,
} from "../waits/internal/table.ts"
import type { WaitKey } from "../waits/internal/keys.ts"
import { RuntimeAuthoritySourceNames } from "./source-names.ts"

interface DurableWaitWrites {
  readonly upsertWait: RuntimeAuthorityCommand<WaitRow, void, unknown>
  readonly upsertCompletion: RuntimeAuthorityCommand<WaitCompletionRow, void, unknown>
}

interface DurableWaitReads {
  readonly waits: RuntimeAuthorityRead
  readonly completions: RuntimeAuthorityRead
}

type DurableWaitAuthorityService = RuntimeAuthority<DurableWaitWrites, DurableWaitReads>

class DurableWaitAuthority extends Context.Tag(
  "@firegrid/runtime/DurableWaitAuthority",
)<DurableWaitAuthority, DurableWaitAuthorityService>() {}

const findWait = (
  waitKey: WaitKey,
) =>
  Effect.flatMap(DurableToolsTable, table => findWaitByKey(table, waitKey))

const findWaitIn = findWaitByKey

const upsertWaitTo = (
  table: DurableToolsTable["Type"],
  row: WaitRow,
) => table.waits.upsert(row)

const upsertWait = (
  row: WaitRow,
) =>
  Effect.flatMap(DurableToolsTable, table => upsertWaitTo(table, row))

const upsertCompletionTo = (
  table: DurableToolsTable["Type"],
  row: WaitCompletionRow,
) => table.completions.upsert(row)

const upsertCompletion = (
  row: WaitCompletionRow,
) =>
  Effect.flatMap(DurableToolsTable, table => upsertCompletionTo(table, row))

const sources = (
  table: DurableToolsTable["Type"],
) => ({
  waits: sourceCollectionHandle(
    RuntimeAuthoritySourceNames.durableWaits,
    table.waits,
  ),
  completions: sourceCollectionHandle(
    RuntimeAuthoritySourceNames.durableWaitCompletions,
    table.completions,
  ),
}) as const

const authority = (
  table: DurableToolsTable["Type"],
): DurableWaitAuthorityService => ({
  write: {
    upsertWait: row => upsertWaitTo(table, row),
    upsertCompletion: row => upsertCompletionTo(table, row),
  },
  read: sources(table),
})

const layer = Layer.effect(
  DurableWaitAuthority,
  Effect.map(DurableToolsTable, authority),
)

export const DurableWaitStore = {
  authority,
  layer,
  findWait,
  findWaitIn,
  upsertWait,
  upsertWaitTo,
  upsertCompletion,
  upsertCompletionTo,
  sources,
} as const
