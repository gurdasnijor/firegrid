import {
  appendJson,
} from "@firegrid/durable-streams"
import {
  startDurableStreamsTestServer,
} from "@firegrid/durable-streams/test-utils"
import type { RuntimeJournalEvent } from "@firegrid/protocol/launch"
import type { MessageProjection } from "@firegrid/protocol/session"
import { Effect, Either, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  EventPipeline,
  EventPipelineLive,
  EventProjector,
  EventSinkError,
  EventSink,
  EventSource,
} from "./event-pipeline.ts"
import { MaterializeRuntimeOutputPipelineLive } from "./materialize-pipeline.ts"
import {
  MaterializeProvider,
  MaterializeProviderError,
} from "./materialize/index.ts"
import type { ProjectionDefinition } from "./core/index.ts"
import { createSessionProjectionDefinition } from "./session-projection-definition.ts"
import type { SessionProjectionQuery } from "./session-projection-definition.ts"
import { makeRawFoldStrategy } from "./raw-fold/index.ts"
import { makeStateProtocolStrategy } from "./state-protocol/index.ts"

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
            Effect.succeed(event === "skip"
              ? { _tag: "Ignored", reason: "skip-fixture" }
              : {
                _tag: "Projected",
                events: [String(event).toUpperCase()],
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
      sourceEventsRead: 3,
      sourceEventsProjected: 2,
      sourceEventsIgnored: 1,
      sourceEventsFailed: 0,
      sinkEventsWritten: 2,
      projector: {
        name: "uppercase",
        version: "1",
      },
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
                  _tag: "Failed",
                  failures: [{
                    sourceEventId: "project-1",
                    reason: "unsupported-shape",
                  }],
                }
                : {
                  _tag: "Projected",
                  events: [event],
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
      sourceEventsRead: 3,
      sourceEventsProjected: 1,
      sourceEventsIgnored: 0,
      sourceEventsFailed: 2,
      sinkEventsWritten: 1,
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
              _tag: "Projected",
              events: [event],
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

  it("firegrid-event-pipeline-materialization.SINK.3 sends runtime journal envelopes to Materialize", async () => {
    const server = await startDurableStreamsTestServer()
    try {
      const streamUrl = await server.createStreamUrl("runtime-output-materialize")
      const event: RuntimeJournalEvent = {
        type: "firegrid.runtime.output.stdout",
        id: "journal-1",
        at: "2026-05-08T00:00:00.000Z",
        event: {
          eventId: "runtime-1",
          contextId: "ctx_materialize",
          activityAttempt: 1,
          sequence: 0,
          source: "stdout",
          format: "jsonl",
          receivedAt: "2026-05-08T00:00:00.000Z",
          raw: JSON.stringify({ type: "assistant", text: "pong" }),
        },
      }
      await Effect.runPromise(appendJson({ streamUrl, event }))

      const ingested: Array<RuntimeJournalEvent> = []
      const layer = MaterializeRuntimeOutputPipelineLive({
        runtimeOutputStreamUrl: streamUrl,
        contextId: "ctx_materialize",
        target: {
          provider: "materialize",
          sourceName: "runtime_output",
          databaseName: "materialize",
          schemaName: "public",
          runtimeEventsViewName: "runtime_output_events",
          webhookUrl: "http://materialize.invalid/webhook",
        },
      }).pipe(
        Layer.provide(Layer.succeed(
          MaterializeProvider,
          MaterializeProvider.of({
            name: "materialize",
            provisionRuntimeOutputProjection: () =>
              Effect.fail(new MaterializeProviderError({
                provider: "materialize",
                op: "test.provision",
                cause: new Error("not used"),
              })),
            ingestRuntimeJournal: (_target, journalEvent) =>
              Effect.sync(() => {
                ingested.push(journalEvent)
              }),
            query: () => Effect.succeed([]),
            subscribe: () => Stream.empty,
          }),
        )),
      )

      const summary = await runPipeline(layer)

      expect(ingested).toEqual([event])
      expect(summary).toMatchObject({
        sourceEventsRead: 1,
        sourceEventsProjected: 1,
        sourceEventsFailed: 0,
        sinkEventsWritten: 1,
      })
    } finally {
      await server.stop()
    }
  })

  it("firegrid-materialization-engines.ENGINE.3 firegrid-materialization-engines.ENGINE.4 firegrid-materialization-engines.ENGINE.5 runs and queries one session projection through raw-fold and State Protocol strategies", async () => {
    const server = await startDurableStreamsTestServer()
    try {
      const runtimeOutputStreamUrl = await server.createStreamUrl("runtime-output-strategy")
      const sessionStateStreamUrl = await server.createStreamUrl("session-state-strategy")
      const contextId = "ctx_strategy"
      const event: RuntimeJournalEvent = {
        type: "firegrid.runtime.output.stdout",
        id: "journal-strategy-1",
        at: "2026-05-08T00:00:00.000Z",
        event: {
          eventId: "runtime-strategy-1",
          contextId,
          activityAttempt: 1,
          sequence: 0,
          source: "stdout",
          format: "jsonl",
          receivedAt: "2026-05-08T00:00:00.000Z",
          raw: JSON.stringify({ type: "assistant", text: "strategy pong" }),
        },
      }
      await Effect.runPromise(appendJson({ streamUrl: runtimeOutputStreamUrl, event }))

      const projection = createSessionProjectionDefinition({
        runtimeOutputStreamUrl,
        contextId,
      })
      const rawFold = await Effect.runPromise(makeRawFoldStrategy)
      const stateProtocol = makeStateProtocolStrategy({
        streamUrl: sessionStateStreamUrl,
        contextId,
      })

      const rawSummary = await Effect.runPromise(rawFold.run(projection))
      const stateProtocolSummary = await Effect.runPromise(stateProtocol.run(projection))
      const rawMessages = await Effect.runPromise(
        rawFold.query<MessageProjection, SessionProjectionQuery>({
          projectionName: projection.name,
          target: projection.target,
          query: { _tag: "messages", contextId },
          select: rows => rows as ReadonlyArray<MessageProjection>,
        }),
      )
      const stateProtocolMessages = await Effect.runPromise(
        stateProtocol.query<MessageProjection, SessionProjectionQuery>({
          projectionName: projection.name,
          target: projection.target,
          query: { _tag: "messages", contextId },
          select: rows => rows as ReadonlyArray<MessageProjection>,
        }),
      )

      expect(rawSummary).toMatchObject({
        sourceEventsRead: 1,
        sourceEventsProjected: 1,
        sinkEventsWritten: 2,
        failures: [],
      })
      expect(stateProtocolSummary).toMatchObject(rawSummary)
      expect(rawMessages).toEqual(stateProtocolMessages)
      expect(rawMessages).toContainEqual(expect.objectContaining({
        contextId,
        text: "strategy pong",
        sourceRuntimeEventId: "runtime-strategy-1",
      }))
    } finally {
      await server.stop()
    }
  })

  it("firegrid-materialization-engines.ENGINE.7 firegrid-materialization-engines.RAW_FOLD.1 firegrid-materialization-engines.STATE_PROTOCOL.2 keeps non-session target capabilities out of strategies", async () => {
    type CountChange = { readonly delta: number }
    type CountQuery = { readonly _tag: "count" }
    type CountState = { readonly count: number }

    const countProjection: ProjectionDefinition<string, CountChange, CountQuery, CountState> = {
      name: "runtime-output-count-probe",
      version: "1",
      source: {
        read: Effect.succeed({
          events: ["one", "two", "three"],
          failures: [],
        }),
      },
      projector: {
        name: "count-probe",
        version: "1",
        project: () =>
          Effect.succeed({
            _tag: "Projected",
            events: [{ delta: 1 }],
          }),
      },
      target: {
        name: "count-probe-state",
        initialState: () => ({ count: 0 }),
        fold: (state, change) => ({ count: state.count + change.delta }),
        query: (state, query) => query.select([state]),
      },
    }

    const rawFold = await Effect.runPromise(makeRawFoldStrategy)
    const rawSummary = await Effect.runPromise(rawFold.run(countProjection))
    const rawCounts = await Effect.runPromise(
      rawFold.query<CountState, CountQuery>({
        projectionName: countProjection.name,
        target: countProjection.target,
        query: { _tag: "count" },
        select: rows => rows as ReadonlyArray<CountState>,
      }),
    )
    const server = await startDurableStreamsTestServer()
    try {
      const stateProtocol = makeStateProtocolStrategy({
        streamUrl: await server.createStreamUrl("count-probe-state"),
        contextId: "ctx_count_probe",
      })
      const stateProtocolResult = await Effect.runPromise(
        stateProtocol.run(countProjection).pipe(Effect.either),
      )

      expect(rawSummary).toMatchObject({
        sourceEventsRead: 3,
        sourceEventsProjected: 3,
        sinkEventsWritten: 3,
      })
      expect(rawCounts).toEqual([{ count: 3 }])
      expect(Either.isLeft(stateProtocolResult)).toBe(true)
      if (Either.isLeft(stateProtocolResult)) {
        expect(stateProtocolResult.left).toMatchObject({
          _tag: "ProjectionError",
          op: "state-protocol-strategy.target",
        })
      }
    } finally {
      await server.stop()
    }
  })
})
