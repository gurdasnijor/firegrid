import {
  RuntimeOutputTable,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import type { DurableTableError } from "effect-durable-operators"
import { Context, Effect, Layer, Option, Sink, Stream } from "effect"
import {
  type RuntimeAgentOutputObservation,
  runtimeAgentOutputObservationFromRow,
} from "../events/index.ts"
import type { RuntimeWaitSource } from "../../durable-tools/internal/types.ts"

export type { RuntimeAgentOutputObservation } from "../events/index.ts"

interface RuntimeEventAppendAndGetService {
  readonly append: (
    row: RuntimeEventRow,
  ) => Effect.Effect<RuntimeEventRow, unknown>
}

interface RuntimeLogLineAppendAndGetService {
  readonly append: (
    row: RuntimeLogLineRow,
  ) => Effect.Effect<RuntimeLogLineRow, unknown>
}

interface RuntimeAgentOutputAfterEventsService {
  readonly after: (
    source: Extract<RuntimeWaitSource, { readonly _tag: "AgentOutputAfter" }>,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
  readonly initial: (
    source: Extract<RuntimeWaitSource, { readonly _tag: "AgentOutputAfter" }>,
  ) => Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown>
}

const runtimeOutputEvents = (
  table: RuntimeOutputTable["Type"],
): Stream.Stream<RuntimeEventRow, DurableTableError> => table.events.rows()

const runtimeOutputLogs = (
  table: RuntimeOutputTable["Type"],
): Stream.Stream<RuntimeLogLineRow, DurableTableError> => table.logs.rows()

const runtimeAgentOutputEvents = (
  table: RuntimeOutputTable["Type"],
): Stream.Stream<RuntimeAgentOutputObservation, DurableTableError> =>
  runtimeOutputEvents(table).pipe(
    Stream.map(runtimeAgentOutputObservationFromRow),
    Stream.filterMap(value => value),
  )

const writeEventTo = (
  table: RuntimeOutputTable["Type"],
  row: RuntimeEventRow,
) => table.events.upsert(row)

const appendEventAndGetTo = (
  table: RuntimeOutputTable["Type"],
  row: RuntimeEventRow,
) => writeEventTo(table, row).pipe(Effect.as(row))

const writeLogTo = (
  table: RuntimeOutputTable["Type"],
  row: RuntimeLogLineRow,
) => table.logs.upsert(row)

const appendLogAndGetTo = (
  table: RuntimeOutputTable["Type"],
  row: RuntimeLogLineRow,
) => writeLogTo(table, row).pipe(Effect.as(row))

export class RuntimeEventAppendAndGet extends Context.Tag(
  "@firegrid/runtime/RuntimeEventAppendAndGet",
)<RuntimeEventAppendAndGet, RuntimeEventAppendAndGetService>() {}

export class RuntimeLogLineAppendAndGet extends Context.Tag(
  "@firegrid/runtime/RuntimeLogLineAppendAndGet",
)<RuntimeLogLineAppendAndGet, RuntimeLogLineAppendAndGetService>() {}

export class RuntimeAgentOutputRowSink extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputRowSink",
)<RuntimeAgentOutputRowSink, Sink.Sink<void, RuntimeEventRow, never, unknown>>() {}

export class RuntimeLogLineSink extends Context.Tag(
  "@firegrid/runtime/RuntimeLogLineSink",
)<RuntimeLogLineSink, Sink.Sink<void, RuntimeLogLineRow, never, unknown>>() {}

export class RuntimeOutputEvents extends Context.Tag(
  "@firegrid/runtime/RuntimeOutputEvents",
)<RuntimeOutputEvents, Stream.Stream<RuntimeEventRow, DurableTableError>>() {}

export class RuntimeOutputLogs extends Context.Tag(
  "@firegrid/runtime/RuntimeOutputLogs",
)<RuntimeOutputLogs, Stream.Stream<RuntimeLogLineRow, DurableTableError>>() {}

export class RuntimeAgentOutputEvents extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputEvents",
)<RuntimeAgentOutputEvents, Stream.Stream<RuntimeAgentOutputObservation, DurableTableError>>() {}

export class RuntimeAgentOutputAfterEvents extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputAfterEvents",
)<RuntimeAgentOutputAfterEvents, RuntimeAgentOutputAfterEventsService>() {}

export const RuntimeOutputJournalLayer = Layer.mergeAll(
  Layer.effect(
    RuntimeEventAppendAndGet,
    Effect.map(RuntimeOutputTable, table => ({
      append: row => appendEventAndGetTo(table, row),
    })),
  ),
  Layer.effect(
    RuntimeLogLineAppendAndGet,
    Effect.map(RuntimeOutputTable, table => ({
      append: row => appendLogAndGetTo(table, row),
    })),
  ),
  Layer.effect(
    RuntimeAgentOutputRowSink,
    Effect.map(RuntimeOutputTable, table =>
      Sink.forEach((row: RuntimeEventRow) => writeEventTo(table, row))),
  ),
  Layer.effect(
    RuntimeLogLineSink,
    Effect.map(RuntimeOutputTable, table =>
      Sink.forEach((row: RuntimeLogLineRow) => writeLogTo(table, row))),
  ),
  Layer.effect(
    RuntimeOutputEvents,
    Effect.map(RuntimeOutputTable, runtimeOutputEvents),
  ),
  Layer.effect(
    RuntimeOutputLogs,
    Effect.map(RuntimeOutputTable, runtimeOutputLogs),
  ),
  Layer.effect(
    RuntimeAgentOutputEvents,
    Effect.map(RuntimeOutputTable, runtimeAgentOutputEvents),
  ),
)

export const RuntimeAgentOutputAfterEventsFromRuntimeOutputEventsLive = Layer.effect(
  RuntimeAgentOutputAfterEvents,
  Effect.map(RuntimeOutputTable, table => ({
    after: source =>
      runtimeAgentOutputEvents(table).pipe(
        Stream.filter((row) =>
          row.contextId === source.contextId &&
          row.activityAttempt === source.activityAttempt &&
          row.sequence > source.afterSequence),
      ),
    initial: source =>
      table.events.query((coll) =>
        coll.toArray
          .map(runtimeAgentOutputObservationFromRow)
          .flatMap(Option.match({
            onNone: () => [],
            onSome: row => [row],
          }))
          .filter((row) =>
            row.contextId === source.contextId &&
            row.activityAttempt === source.activityAttempt &&
            row.sequence > source.afterSequence)
          .sort((left, right) => left.sequence - right.sequence)[0]).pipe(
        Effect.map(Option.fromNullable),
      ),
  })),
)
