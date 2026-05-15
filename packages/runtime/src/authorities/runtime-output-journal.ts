import {
  RuntimeOutputTable,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import { Context, Effect, Layer, Sink, Stream } from "effect"
import {
  runtimeAgentOutputObservationFromRow,
  type RuntimeAuthority,
  type RuntimeAuthorityCommand,
  type RuntimeAuthorityRead,
  type RuntimeAuthoritySink,
} from "../events/index.ts"
import {
  sourceCollectionHandle,
  type SourceCollectionHandle,
} from "../waits/internal/source-collections.ts"
import { RuntimeAuthoritySourceNames } from "./source-names.ts"

export type { RuntimeAgentOutputObservation } from "../events/index.ts"
interface RuntimeOutputWrites {
  readonly writeEvent: RuntimeAuthorityCommand<RuntimeEventRow, void, unknown>
  readonly writeLog: RuntimeAuthorityCommand<RuntimeLogLineRow, void, unknown>
  readonly agentOutputSink: RuntimeAuthoritySink<RuntimeEventRow, void, unknown>
  readonly logSink: RuntimeAuthoritySink<RuntimeLogLineRow, void, unknown>
}

interface RuntimeOutputReads {
  readonly events: RuntimeAuthorityRead
  readonly logs: RuntimeAuthorityRead
  readonly agentOutputEvents: RuntimeAuthorityRead
}

type RuntimeOutputAuthorityService = RuntimeAuthority<RuntimeOutputWrites, RuntimeOutputReads>

export class RuntimeOutputAuthority extends Context.Tag(
  "@firegrid/runtime/RuntimeOutputAuthority",
)<RuntimeOutputAuthority, RuntimeOutputAuthorityService>() {}

const agentOutputCollection = (
  table: RuntimeOutputTable["Type"],
): SourceCollectionHandle => ({
  name: RuntimeAuthoritySourceNames.agentOutputEvents,
  subscribe: () =>
    table.events.rows().pipe(
      Stream.map(runtimeAgentOutputObservationFromRow),
      Stream.filterMap(value => value),
    ),
})

const writeEventTo = (
  table: RuntimeOutputTable["Type"],
  row: RuntimeEventRow,
) => table.events.upsert(row)

const writeLogTo = (
  table: RuntimeOutputTable["Type"],
  row: RuntimeLogLineRow,
) => table.logs.upsert(row)

const writeEvent = (
  row: RuntimeEventRow,
) =>
  Effect.flatMap(RuntimeOutputTable, table => writeEventTo(table, row))

const writeLog = (
  row: RuntimeLogLineRow,
) =>
  Effect.flatMap(RuntimeOutputTable, table => writeLogTo(table, row))

const agentOutputSink = Sink.forEach((row: RuntimeEventRow) => writeEvent(row))

const logSink = Sink.forEach((row: RuntimeLogLineRow) => writeLog(row))

const sources = (
  table: RuntimeOutputTable["Type"],
) => ({
  events: sourceCollectionHandle(
    RuntimeAuthoritySourceNames.runtimeOutputEvents,
    table.events,
  ),
  logs: sourceCollectionHandle(
    RuntimeAuthoritySourceNames.runtimeOutputLogs,
    table.logs,
  ),
  agentOutputEvents: agentOutputCollection(table),
}) as const

const authority = (
  table: RuntimeOutputTable["Type"],
): RuntimeOutputAuthorityService => ({
  write: {
    writeEvent: row => writeEventTo(table, row),
    writeLog: row => writeLogTo(table, row),
    agentOutputSink: Sink.forEach((row: RuntimeEventRow) => writeEventTo(table, row)),
    logSink: Sink.forEach((row: RuntimeLogLineRow) => writeLogTo(table, row)),
  },
  read: sources(table),
})

const layer = Layer.effect(
  RuntimeOutputAuthority,
  Effect.map(RuntimeOutputTable, authority),
)

export const RuntimeOutputJournal = {
  authority,
  layer,
  writeEvent,
  writeEventTo,
  writeLog,
  writeLogTo,
  agentOutputSink,
  logSink,
  sources,
} as const
