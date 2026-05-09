import { Effect, Either, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  EventPipeline,
  EventPipelineLive,
  EventProjector,
  EventSinkError,
  EventSink,
  EventSource,
} from "./event-pipeline.ts"

const runPipeline = (
  layer: Layer.Layer<EventPipeline>,
) =>
  Effect.runPromise(
    EventPipeline.pipe(
      Effect.flatMap(pipeline => pipeline.run),
      Effect.provide(layer),
    ),
  )

const runPipelineEither = (
  layer: Layer.Layer<EventPipeline>,
) =>
  Effect.runPromise(
    EventPipeline.pipe(
      Effect.flatMap(pipeline => pipeline.run),
      Effect.either,
      Effect.provide(layer),
    ),
  )

describe("event pipeline materialization", () => {
  it("firegrid-event-pipeline-materialization.PIPELINE.1 firegrid-event-pipeline-materialization.PIPELINE.2 composes source projector and sink services", async () => {
    const written: Array<unknown> = []
    const layer = EventPipelineLive.pipe(
      Layer.provide(Layer.succeed(
        EventSource,
        EventSource.of({
          read: Effect.succeed({
            events: ["one", "skip", "two"],
            failures: [],
          }),
        }),
      )),
      Layer.provide(Layer.succeed(
        EventProjector,
        EventProjector.of({
          name: "uppercase",
          version: "1",
          project: event =>
            Effect.succeed({
              events: event === "skip" ? [] : [String(event).toUpperCase()],
              failures: [],
            }),
        }),
      )),
      Layer.provide(Layer.succeed(
        EventSink,
        EventSink.of({
          writeAll: events =>
            Effect.sync(() => {
              written.push(...events)
              return events.length
            }),
          flush: Effect.void,
        }),
      )),
    )

    const summary = await runPipeline(layer)

    expect(written).toEqual(["ONE", "TWO"])
    expect(summary).toMatchObject({
      eventsRead: 3,
      eventsProjected: 2,
      eventsIgnored: 1,
      eventsFailed: 0,
      eventsWritten: 2,
      projector: "uppercase",
      projectorVersion: "1",
    })
  })

  it("firegrid-event-pipeline-materialization.PIPELINE.2 includes source and projector failures in the summary", async () => {
    const layer = EventPipelineLive.pipe(
      Layer.provide(Layer.succeed(
        EventSource,
        EventSource.of({
          read: Effect.succeed({
            events: ["ok", "project-fail"],
            failures: [{
              sourceEventId: "source-1",
              reason: "decode-failure",
            }],
          }),
        }),
      )),
      Layer.provide(Layer.succeed(
        EventProjector,
        EventProjector.of({
          name: "failure-aware",
          version: "1",
          project: event =>
            Effect.succeed(
              event === "project-fail"
                ? {
                  events: [],
                  failures: [{
                    sourceEventId: "project-1",
                    reason: "unsupported-shape",
                  }],
                }
                : {
                  events: [event],
                  failures: [],
                },
            ),
        }),
      )),
      Layer.provide(Layer.succeed(
        EventSink,
        EventSink.of({
          writeAll: events => Effect.succeed(events.length),
          flush: Effect.void,
        }),
      )),
    )

    const summary = await runPipeline(layer)

    expect(summary).toMatchObject({
      eventsRead: 3,
      eventsProjected: 1,
      eventsIgnored: 0,
      eventsFailed: 2,
      eventsWritten: 1,
    })
    expect(summary.failures.map(failure => failure.reason)).toEqual([
      "decode-failure",
      "unsupported-shape",
    ])
  })

  it("firegrid-event-pipeline-materialization.PIPELINE.2 maps sink failures without claiming written events", async () => {
    const layer = EventPipelineLive.pipe(
      Layer.provide(Layer.succeed(
        EventSource,
        EventSource.of({
          read: Effect.succeed({
            events: ["one"],
            failures: [],
          }),
        }),
      )),
      Layer.provide(Layer.succeed(
        EventProjector,
        EventProjector.of({
          name: "single",
          version: "1",
          project: event =>
            Effect.succeed({
              events: [event],
              failures: [],
            }),
        }),
      )),
      Layer.provide(Layer.succeed(
        EventSink,
        EventSink.of({
          writeAll: () =>
            Effect.fail(new EventSinkError({
              op: "test-sink.writeAll",
              cause: new Error("boom"),
            })),
          flush: Effect.void,
        }),
      )),
    )

    const result = await runPipelineEither(layer)

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        _tag: "EventPipelineError",
        op: "event-sink.writeAll",
      })
    }
  })
})
