import type {
  AgentOutputEvent,
  RuntimeAgentOutputObservation,
} from "@firegrid/runtime/events"
import type { Effect } from "effect"
import type {
  DurableTableCollectionFacade,
  DurableTableError,
  DurableTableInsertOrGetResult,
} from "effect-durable-operators"

type TinyRuntimeOutputEvents =
  DurableTableCollectionFacade<RuntimeAgentOutputObservation, string>

export const outputObservationKey = (
  observation: RuntimeAgentOutputObservation,
): string =>
  `${observation.contextId}:${observation.activityAttempt}:${observation.sequence}`

export const persistAgentOutputObservation = (
  events: TinyRuntimeOutputEvents,
  observation: RuntimeAgentOutputObservation,
): Effect.Effect<DurableTableInsertOrGetResult<RuntimeAgentOutputObservation>, DurableTableError> =>
  events.insertOrGet(observation)

export const observationFromAgentOutput = (
  input: {
    readonly contextId: string
    readonly activityAttempt: number
    readonly sequence: number
    readonly event: AgentOutputEvent
  },
): RuntimeAgentOutputObservation => ({
  contextId: input.contextId,
  activityAttempt: input.activityAttempt,
  sequence: input.sequence,
  _tag: input.event._tag,
  event: input.event,
})
