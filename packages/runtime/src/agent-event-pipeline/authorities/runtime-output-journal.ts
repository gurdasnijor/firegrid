import {
  RuntimeOutputTable,
  type RuntimeEventRow,
} from "@firegrid/protocol/launch"
import type { DurableTableError } from "effect-durable-operators"
import { Context, Effect, Layer, Stream } from "effect"
import type { Option } from "effect"
import {
  type RuntimeAgentOutputObservation,
  runtimeAgentOutputObservationFromRow,
} from "../events/index.ts"
import type { RuntimeWaitSource } from "../../durable-tools/internal/types.ts"

export type { RuntimeAgentOutputObservation } from "../events/index.ts"

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
