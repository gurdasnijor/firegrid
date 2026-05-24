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

export type { RuntimeAgentOutputObservation } from "../events/index.ts"

// Structural shape of the `AgentOutputAfter` variant of
// `RuntimeObservationSource` (declared in `streams/sources.ts`). Inlined here
// to keep tables/ free of type-only edges into the legacy `streams/` root
// (enforced by scripts/runtime-target-legacy-type-only-check.mjs).
type AgentOutputAfterSource = {
  readonly _tag: "AgentOutputAfter"
  readonly contextId: string
  readonly activityAttempt: number
  readonly afterSequence: number
}

interface RuntimeAgentOutputAfterEventsService {
  readonly initial: (
    source: AgentOutputAfterSource,
  ) => Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown>
  readonly after: (
    source: AgentOutputAfterSource,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
  // firegrid-typed-wait-source-redesign.WAIT_ROUTER.1
  //
  // Attempt-agnostic per-context observation. The non-After `AgentOutput`
  // wait source carries no contextId on the variant (it lives in the
  // wait trigger); post-#315 there is no host-wide output stream to
  // observe, so the router resolves the per-context output stream by the
  // contextId predicate and observes ALL of that context's output rows
  // (every activity attempt, from the beginning). `evaluateFieldEquals`
  // on the wait trigger still decides which rows match.
  // See docs/research/host-vs-context-boundary-audit.md §A4.
  readonly forContext: (
    contextId: string,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
}

const runtimeOutputEvents = (
  table: RuntimeOutputTable["Type"],
): Stream.Stream<RuntimeEventRow, DurableTableError> => table.events.rows()
  .pipe(
    Stream.withSpan("firegrid.runtime_output.journal.events", {
      kind: "internal",
    }),
  )

const runtimeAgentOutputEvents = (
  table: RuntimeOutputTable["Type"],
): Stream.Stream<RuntimeAgentOutputObservation, DurableTableError> =>
  runtimeOutputEvents(table).pipe(
    Stream.map(runtimeAgentOutputObservationFromRow),
    Stream.filterMap(value => value),
    Stream.withSpan("firegrid.runtime_output.journal.agent_output", {
      kind: "internal",
    }),
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
