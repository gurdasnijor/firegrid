import { type Effect, Schema } from "effect"
import { type DurableStream, type Endpoint } from "effect-durable-streams"

const StepSucceededEventSchema = Schema.Struct({
  type: Schema.Literal("StepSucceeded"),
  stepKey: Schema.String,
  name: Schema.String,
  value: Schema.Unknown,
})

const StepFailedEventSchema = Schema.Struct({
  type: Schema.Literal("StepFailed"),
  stepKey: Schema.String,
  name: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
})

const SleepCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("SleepCompleted"),
  sleepKey: Schema.String,
  name: Schema.String,
  durationMs: Schema.Number,
})

const RaceCompletedEventSchema = Schema.Struct({
  type: Schema.Literal("RaceCompleted"),
  raceKey: Schema.String,
  name: Schema.String,
  winnerIndex: Schema.Number,
})

const StateSetEventSchema = Schema.Struct({
  type: Schema.Literal("StateSet"),
  name: Schema.String,
  value: Schema.Unknown,
})

const StateClearedEventSchema = Schema.Struct({
  type: Schema.Literal("StateCleared"),
  name: Schema.String,
})

const StateClearedAllEventSchema = Schema.Struct({
  type: Schema.Literal("StateClearedAll"),
})

export const JournalEventSchema = Schema.Union(
  StepSucceededEventSchema,
  StepFailedEventSchema,
  SleepCompletedEventSchema,
  RaceCompletedEventSchema,
)

export const StateEventSchema = Schema.Union(
  StateSetEventSchema,
  StateClearedEventSchema,
  StateClearedAllEventSchema,
)

export type JournalEvent = Schema.Schema.Type<typeof JournalEventSchema>
export type StateEvent = Schema.Schema.Type<typeof StateEventSchema>
export type StepSucceededEvent = Schema.Schema.Type<typeof StepSucceededEventSchema>
export type StepFailedEvent = Schema.Schema.Type<typeof StepFailedEventSchema>
export type SleepCompletedEvent = Schema.Schema.Type<typeof SleepCompletedEventSchema>
export type RaceCompletedEvent = Schema.Schema.Type<typeof RaceCompletedEventSchema>
type StreamRequirements<Event> =
  ReturnType<DurableStream.Bound<Event, Event>["append"]> extends
    Effect.Effect<unknown, unknown, infer Requirements> ? Requirements : never
type JournalRequirements = StreamRequirements<JournalEvent>
export type FluentRequirements = JournalRequirements
type StateStream = DurableStream.Bound<StateEvent, StateEvent>
export type JournalStream = DurableStream.Bound<JournalEvent, JournalEvent>

export interface StateRuntime {
  readonly stream: StateStream
  readonly values: Map<string, unknown>
  readonly pending: Array<StateEvent>
}

export interface ExecutionContext {
  // fluent-firegrid-keystone.PACKAGE.3
  readonly journal: {
    readonly endpoint: Endpoint
  }
  readonly state?: {
    readonly endpoint: Endpoint
  }
}

export const foldStateEvents = (
  events: ReadonlyArray<StateEvent>,
): Map<string, unknown> => {
  const values = new Map<string, unknown>()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    switch (event.type) {
      case "StateSet": {
        values.set(event.name, event.value)
        break
      }
      case "StateCleared": {
        values.delete(event.name)
        break
      }
      case "StateClearedAll": {
        values.clear()
        break
      }
    }
  }
  return values
}
