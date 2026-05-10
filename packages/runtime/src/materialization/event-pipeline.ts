import { Context, Effect, Layer, Schema } from "effect"

export type EventPipelineFailure = {
  readonly sourceEventId: string
  readonly reason: string
  readonly cause?: unknown
}

export type EventSourceReadResult<Event = unknown> = {
  readonly events: ReadonlyArray<Event>
  readonly failures: ReadonlyArray<EventPipelineFailure>
}

export type EventProjectorResult<Event = unknown> =
  | {
    readonly _tag: "Projected"
    readonly events: ReadonlyArray<Event>
  }
  | {
    readonly _tag: "Ignored"
    readonly reason?: string
  }
  | {
    readonly _tag: "Failed"
    readonly failures: ReadonlyArray<EventPipelineFailure>
  }

export type EventProjectorIdentity = {
  readonly name: string
  readonly version: string
}

export type EventSinkWriteContext = {
  readonly projector: EventProjectorIdentity
}

export type EventPipelineSummary = {
  readonly sourceEventsRead: number
  readonly sourceEventsProjected: number
  readonly sourceEventsIgnored: number
  readonly sourceEventsFailed: number
  readonly sinkEventsWritten: number
  readonly projector: EventProjectorIdentity
  readonly failures: ReadonlyArray<EventPipelineFailure>
}

type ProjectAccumulator = {
  readonly eventsProjected: number
  readonly eventsIgnored: number
  readonly eventsFailed: number
}

export class EventSourceError extends Schema.TaggedError<EventSourceError>()(
  "EventSourceError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class EventProjectorError extends Schema.TaggedError<EventProjectorError>()(
  "EventProjectorError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class EventSinkError extends Schema.TaggedError<EventSinkError>()(
  "EventSinkError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export class EventPipelineError extends Schema.TaggedError<EventPipelineError>()(
  "EventPipelineError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export interface EventSourceService<Event = unknown> {
  readonly read: Effect.Effect<EventSourceReadResult<Event>, EventSourceError>
}

export interface EventProjectorService<Source = unknown, Projected = unknown>
  extends EventProjectorIdentity
{
  readonly project: (
    event: Source,
  ) => Effect.Effect<EventProjectorResult<Projected>, EventProjectorError>
}

export interface EventSinkService<Event = unknown> {
  readonly writeAll: (
    events: ReadonlyArray<Event>,
    context: EventSinkWriteContext,
  ) => Effect.Effect<number, EventSinkError>
  readonly flush: Effect.Effect<void, EventSinkError>
}

export interface EventPipelineService {
  readonly run: Effect.Effect<EventPipelineSummary, EventPipelineError>
}

export class EventSource extends Context.Tag("firegrid/runtime/EventSource")<
  EventSource,
  EventSourceService<unknown>
>() {}

export class EventProjector extends Context.Tag("firegrid/runtime/EventProjector")<
  EventProjector,
  EventProjectorService<unknown, unknown>
>() {}

export class EventSink extends Context.Tag("firegrid/runtime/EventSink")<
  EventSink,
  EventSinkService<unknown>
>() {}

export class EventPipeline extends Context.Tag("firegrid/runtime/EventPipeline")<
  EventPipeline,
  EventPipelineService
>() {}

const mapPipelineError = (
  op: string,
  cause: unknown,
): EventPipelineError =>
  new EventPipelineError({ op, cause })

const initialAccumulator = (
  source: EventSourceReadResult,
): ProjectAccumulator => ({
  eventsProjected: 0,
  eventsIgnored: 0,
  eventsFailed: source.failures.length,
})

export const EventPipelineLive = Layer.effect(
  EventPipeline,
  Effect.gen(function* () {
    const source = yield* EventSource
    const projector = yield* EventProjector
    const sink = yield* EventSink

    return EventPipeline.of({
      run: Effect.gen(function* () {
        const read = yield* source.read.pipe(
          Effect.mapError(cause => mapPipelineError("event-source.read", cause)),
        )

        const projectedEvents: Array<unknown> = []
        const failures: Array<EventPipelineFailure> = [...read.failures]

        const accumulated = yield* Effect.reduce(
          read.events,
          initialAccumulator(read),
          (acc, event) =>
            projector.project(event).pipe(
              Effect.mapError(cause => mapPipelineError("event-projector.project", cause)),
              Effect.map(result => {
                switch (result._tag) {
                  case "Failed":
                    failures.push(...result.failures)
                    return {
                      ...acc,
                      eventsFailed: acc.eventsFailed + 1,
                    }
                  case "Ignored":
                    return {
                      ...acc,
                      eventsIgnored: acc.eventsIgnored + 1,
                    }
                  case "Projected":
                    projectedEvents.push(...result.events)
                    return {
                      ...acc,
                      eventsProjected: acc.eventsProjected + 1,
                    }
                }
              }),
            ),
        )

        const eventsWritten = yield* sink.writeAll(projectedEvents, { projector }).pipe(
          Effect.mapError(cause => mapPipelineError("event-sink.writeAll", cause)),
        )
        yield* sink.flush.pipe(
          Effect.mapError(cause => mapPipelineError("event-sink.flush", cause)),
        )

        return {
          sourceEventsRead: read.events.length + read.failures.length,
          sourceEventsProjected: accumulated.eventsProjected,
          sourceEventsIgnored: accumulated.eventsIgnored,
          sourceEventsFailed: accumulated.eventsFailed,
          sinkEventsWritten: eventsWritten,
          projector,
          failures,
        }
      }),
    })
  }),
)
