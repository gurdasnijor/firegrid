import { Context, Effect, Layer, Schema } from "effect"

export type EventPipelineFailure = {
  readonly sourceEventId: string
  readonly reason: string
  readonly cause?: unknown
}

export type EventSourceReadResult = {
  readonly events: ReadonlyArray<unknown>
  readonly failures: ReadonlyArray<EventPipelineFailure>
}

export type EventProjectorResult = {
  readonly events: ReadonlyArray<unknown>
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
  readonly eventsRead: number
  readonly eventsProjected: number
  readonly eventsIgnored: number
  readonly eventsFailed: number
  readonly eventsWritten: number
  readonly projector: string
  readonly projectorVersion: string
  readonly failures: ReadonlyArray<EventPipelineFailure>
}

type ProjectAccumulator = {
  readonly summary: EventPipelineSummary
  readonly projectedEvents: ReadonlyArray<unknown>
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

export interface EventSourceService {
  readonly read: Effect.Effect<EventSourceReadResult, EventSourceError>
}

export interface EventProjectorService extends EventProjectorIdentity {
  readonly project: (
    event: unknown,
  ) => Effect.Effect<EventProjectorResult, EventProjectorError>
}

export interface EventSinkService {
  readonly writeAll: (
    events: ReadonlyArray<unknown>,
    context: EventSinkWriteContext,
  ) => Effect.Effect<void, EventSinkError>
  readonly flush: Effect.Effect<void, EventSinkError>
}

export interface EventPipelineService {
  readonly run: Effect.Effect<EventPipelineSummary, EventPipelineError>
}

export class EventSource extends Context.Tag("firegrid/runtime/EventSource")<
  EventSource,
  EventSourceService
>() {}

export class EventProjector extends Context.Tag("firegrid/runtime/EventProjector")<
  EventProjector,
  EventProjectorService
>() {}

export class EventSink extends Context.Tag("firegrid/runtime/EventSink")<
  EventSink,
  EventSinkService
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
  projector: EventProjectorIdentity,
): ProjectAccumulator => ({
  summary: {
    eventsRead: source.events.length + source.failures.length,
    eventsProjected: 0,
    eventsIgnored: 0,
    eventsFailed: source.failures.length,
    eventsWritten: 0,
    projector: projector.name,
    projectorVersion: projector.version,
    failures: source.failures,
  },
  projectedEvents: [],
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

        const accumulated = yield* Effect.reduce(
          read.events,
          initialAccumulator(read, projector),
          (acc, event) =>
            projector.project(event).pipe(
              Effect.mapError(cause => mapPipelineError("event-projector.project", cause)),
              Effect.map(result => {
                if (result.failures.length > 0) {
                  return {
                    ...acc,
                    summary: {
                      ...acc.summary,
                      eventsFailed: acc.summary.eventsFailed + 1,
                      failures: [...acc.summary.failures, ...result.failures],
                    },
                  }
                }
                if (result.events.length === 0) {
                  return {
                    ...acc,
                    summary: {
                      ...acc.summary,
                      eventsIgnored: acc.summary.eventsIgnored + 1,
                    },
                  }
                }
                return {
                  summary: {
                    ...acc.summary,
                    eventsProjected: acc.summary.eventsProjected + 1,
                    eventsWritten: acc.summary.eventsWritten + result.events.length,
                  },
                  projectedEvents: [...acc.projectedEvents, ...result.events],
                }
              }),
            ),
        )

        yield* sink.writeAll(accumulated.projectedEvents, { projector }).pipe(
          Effect.mapError(cause => mapPipelineError("event-sink.writeAll", cause)),
        )
        yield* sink.flush.pipe(
          Effect.mapError(cause => mapPipelineError("event-sink.flush", cause)),
        )

        return accumulated.summary
      }),
    })
  }),
)
