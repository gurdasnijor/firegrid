import { DurableStream } from "@durable-streams/client"
import { Chunk, Duration, Effect, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  EventStream,
  EVENT_STREAM_ENVELOPE_TAG,
  FiregridClient,
  FiregridClientLive,
  isEventStreamEnvelope,
} from "../index.ts"
import {
  createSubstrateStream,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

const WidgetEvents = EventStream.define({
  name: "widget.events",
  event: Schema.Struct({
    id: Schema.String,
    count: Schema.NumberFromString,
  }),
})

const OtherEvents = EventStream.define({
  name: "other.events",
  event: Schema.Struct({
    id: Schema.String,
  }),
})

const layerFor = (streamUrl: string) =>
  FiregridClientLive({ streamUrl, clientId: "firegrid-event-tests" })

const readRetained = async (url: string): Promise<ReadonlyArray<unknown>> => {
  const stream = new DurableStream({ url, contentType: "application/json" })
  const response = await stream.stream<unknown>({ offset: "-1", live: false })
  return await response.json<unknown>()
}

describe("firegrid-event-streams.CLIENT_API.1 — client.emit appends encoded EventStream envelopes", () => {
  it("writes only the shared Firegrid EventStream envelope to the configured durable stream", async () => {
    const url = await createSubstrateStream("firegrid-event-emit")

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* FiregridClient
        yield* client.emit(WidgetEvents, { id: "w-1", count: 7 })
      }).pipe(Effect.provide(layerFor(url))),
    )

    const retained = await readRetained(url)
    expect(retained).toHaveLength(1)
    expect(retained[0]).toEqual({
      _envelope: EVENT_STREAM_ENVELOPE_TAG,
      stream: "widget.events",
      event: { id: "w-1", count: "7" },
    })
    expect(isEventStreamEnvelope(retained[0])).toBe(true)
  })
})

describe("firegrid-event-streams.CLIENT_API.2, .3 — client.events returns an Effect Stream", () => {
  it("replays EventStream envelopes, filters by descriptor name, and decodes event schemas", async () => {
    const url = await createSubstrateStream("firegrid-event-events-replay")

    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* FiregridClient
          yield* client.emit(OtherEvents, { id: "ignore-me" })
          yield* client.emit(WidgetEvents, { id: "w-1", count: 1 })
          yield* client.emit(WidgetEvents, { id: "w-2", count: 2 })
          return yield* client.events(WidgetEvents).pipe(
            Stream.take(2),
            Stream.runCollect,
          )
        }),
      ).pipe(Effect.provide(layerFor(url))),
    )

    expect(Chunk.toReadonlyArray(collected)).toEqual([
      { id: "w-1", count: 1 },
      { id: "w-2", count: 2 },
    ])
  })

  it("follows live appends without polling or NotYetLowered placeholders", async () => {
    const url = await createSubstrateStream("firegrid-event-events-live")

    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* FiregridClient
          const fiber = yield* Effect.fork(
            client.events(WidgetEvents).pipe(Stream.take(1), Stream.runCollect),
          )
          yield* Effect.sleep(Duration.millis(40))
          yield* client.emit(WidgetEvents, { id: "live-1", count: 3 })
          return yield* fiber
        }),
      ).pipe(Effect.provide(layerFor(url))),
    )

    expect(Chunk.toReadonlyArray(collected)).toEqual([
      { id: "live-1", count: 3 },
    ])
  })
})

describe("firegrid-event-streams.CLIENT_API.4 — EventStream client API stays browser-safe", () => {
  it("the client root exposes Firegrid EventStream APIs without runtime imports", () => {
    expect(typeof FiregridClientLive).toBe("function")
    expect(EventStream.define).toBeTypeOf("function")
    expect(EVENT_STREAM_ENVELOPE_TAG).toBe("firegrid/event@1")
  })
})
