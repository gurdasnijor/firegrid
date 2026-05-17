import {
  RuntimeOutputTable,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import type { DurableTableError } from "effect-durable-operators"
import { Context, Effect, Layer, Stream } from "effect"
import type { Option } from "effect"
import type { Sink } from "effect"
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

type AgentOutputAfterSource = Extract<RuntimeWaitSource, { readonly _tag: "AgentOutputAfter" }>

interface RuntimeAgentOutputAfterEventsService {
  readonly initial: (
    source: AgentOutputAfterSource,
  ) => Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown>
  readonly after: (
    source: AgentOutputAfterSource,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
}

const runtimeOutputEvents = (
  table: RuntimeOutputTable["Type"],
): Stream.Stream<RuntimeEventRow, DurableTableError> => table.events.rows()

const runtimeAgentOutputEvents = (
  table: RuntimeOutputTable["Type"],
): Stream.Stream<RuntimeAgentOutputObservation, DurableTableError> =>
  runtimeOutputEvents(table).pipe(
    Stream.map(runtimeAgentOutputObservationFromRow),
    Stream.filterMap(value => value),
  )

export class RuntimeEventAppendAndGet extends Context.Tag(
  "@firegrid/runtime/RuntimeEventAppendAndGet",
)<RuntimeEventAppendAndGet, RuntimeEventAppendAndGetService>() {}

export class RuntimeLogLineAppendAndGet extends Context.Tag(
  "@firegrid/runtime/RuntimeLogLineAppendAndGet",
)<RuntimeLogLineAppendAndGet, RuntimeLogLineAppendAndGetService>() {}

export class RuntimeAgentOutputRowSink extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputRowSink",
)<RuntimeAgentOutputRowSink, Sink.Sink<void, RuntimeEventRow, never, unknown>>() {}

export class RuntimeAgentOutputEvents extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputEvents",
)<RuntimeAgentOutputEvents, Stream.Stream<RuntimeAgentOutputObservation, DurableTableError>>() {}

export class RuntimeAgentOutputAfterEvents extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputAfterEvents",
)<RuntimeAgentOutputAfterEvents, RuntimeAgentOutputAfterEventsService>() {}

export const RuntimeAgentOutputEventsLayer = Layer.effect(
  RuntimeAgentOutputEvents,
  Effect.map(RuntimeOutputTable, runtimeAgentOutputEvents),
)
