import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  EventPipeline,
  EventPipelineLive,
  EventProjector,
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
})

