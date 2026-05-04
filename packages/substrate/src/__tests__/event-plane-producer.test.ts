import { DurableStream } from "@durable-streams/client"
import { createStateSchema, type ChangeEvent } from "@durable-streams/state"
import { Cause, Effect, Exit, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  EventPlane,
  PlaneProducerError,
  PlaneProducerUnknownTypeError,
  PlaneProducerValidationError,
} from "../event-plane/index.js"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.js"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

const ExampleRow = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("pending", "ready"),
})

const buildPlane = () => {
  const state = createStateSchema({
    rows: {
      type: "example.adapter.row",
      primaryKey: "id",
      schema: Schema.standardSchemaV1(ExampleRow),
    },
  })
  return EventPlane.define({ name: "example.adapter", state })
}

// Read all retained ChangeEvents back out of the stream so we can assert
// what the producer actually appended (headers + value).
const readAppendedEvents = async (
  url: string,
): Promise<ReadonlyArray<ChangeEvent>> => {
  const { stream } = await import("@durable-streams/client")
  const session = await stream<ChangeEvent>({
    url,
    live: false,
    offset: "-1",
  })
  return await session.json<ChangeEvent>()
}

describe("client-event-plane-registration.PRODUCER_API.1 — typed emit appends a state-collection event without exposing raw stream calls", () => {
  it("emit returns appended:true and the durable stream now contains the typed event", async () => {
    const url = freshStreamUrl("event-plane-producer-emit")
    await DurableStream.create({ url, contentType: "application/json" })
    const plane = buildPlane()
    const event = plane.state.rows.insert({
      value: { id: "r-emit-1", status: "pending" },
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const producer = yield* plane.Producer
        return yield* producer.emit(event)
      }).pipe(Effect.provide(EventPlane.layer(plane, { streamUrl: url }))),
    )
    expect(result).toEqual({ appended: true })

    const appended = await readAppendedEvents(url)
    expect(appended).toHaveLength(1)
    expect(appended[0]?.type).toBe("example.adapter.row")
    expect(appended[0]?.value).toEqual({ id: "r-emit-1", status: "pending" })
  })

  it("the producer service shape exposes only `emit` (no rawAppend / DurableStream / etc.)", async () => {
    const url = freshStreamUrl("event-plane-producer-shape")
    await DurableStream.create({ url, contentType: "application/json" })
    const plane = buildPlane()
    const keys = await Effect.runPromise(
      Effect.gen(function* () {
        const producer = yield* plane.Producer
        return Object.keys(producer)
      }).pipe(Effect.provide(EventPlane.layer(plane, { streamUrl: url }))),
    )
    expect(keys).toEqual(["emit"])
  })
})

describe("client-event-plane-registration.PRODUCER_API.2 — metadata is preserved as ChangeEvent headers", () => {
  it("idempotencyKey, correlationId, causationId, and arbitrary extras land on the durable record headers", async () => {
    const url = freshStreamUrl("event-plane-producer-metadata")
    await DurableStream.create({ url, contentType: "application/json" })
    const plane = buildPlane()
    const event = plane.state.rows.insert({
      value: { id: "r-meta", status: "pending" },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const producer = yield* plane.Producer
        yield* producer.emit(event, {
          idempotencyKey: "idem-1",
          correlationId: "corr-1",
          causationId: "cause-1",
          extra: { traceId: "trace-1" },
        })
      }).pipe(Effect.provide(EventPlane.layer(plane, { streamUrl: url }))),
    )
    const appended = await readAppendedEvents(url)
    const headers = appended[0]?.headers as unknown as Record<string, string>
    expect(headers.idempotencyKey).toBe("idem-1")
    expect(headers.correlationId).toBe("corr-1")
    expect(headers.causationId).toBe("cause-1")
    expect(headers.traceId).toBe("trace-1")
    // operation header from the State helper survives.
    expect(headers.operation).toBe("insert")
  })
})

describe("client-event-plane-registration.PRODUCER_API.3 — defense-in-depth schema re-validation against forged ChangeEvents", () => {
  it("emit rejects an event whose value does not satisfy the registered schema", async () => {
    const url = freshStreamUrl("event-plane-producer-validate")
    await DurableStream.create({ url, contentType: "application/json" })
    const plane = buildPlane()
    // Hand-craft a forged ChangeEvent that bypasses the State helpers.
    const forged: ChangeEvent = {
      type: "example.adapter.row",
      key: "r-bad",
      value: { id: "r-bad", status: "exploded" }, // status not in literal union
      headers: { operation: "insert" },
    }
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const producer = yield* plane.Producer
          yield* producer.emit(forged)
        }).pipe(Effect.provide(EventPlane.layer(plane, { streamUrl: url }))),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause)
      expect(err._tag).toBe("Some")
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(PlaneProducerValidationError)
      }
    }
  })

  it("emit rejects an event whose `type` is not registered in the plane's state collections", async () => {
    const url = freshStreamUrl("event-plane-producer-unknown")
    await DurableStream.create({ url, contentType: "application/json" })
    const plane = buildPlane()
    const forged: ChangeEvent = {
      type: "example.adapter.unknown",
      key: "x",
      value: { id: "x", status: "pending" },
      headers: { operation: "insert" },
    }
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const producer = yield* plane.Producer
          yield* producer.emit(forged)
        }).pipe(Effect.provide(EventPlane.layer(plane, { streamUrl: url }))),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause)
      expect(err._tag).toBe("Some")
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(PlaneProducerUnknownTypeError)
      }
    }
  })
})

describe("client-event-plane-registration.PRODUCER_API.4 — typed Effect errors on stream failure", () => {
  it("emit against an unreachable stream URL fails with PlaneProducerError in the Effect error channel", async () => {
    // Construct a producer in isolation (bypassing EventPlane.layer's
    // Projection acquisition) so the stream-failure path is observable
    // without conflating with projection preload failure. makePlaneProducer
    // is package-internal but importable by tests.
    const { makePlaneProducer } = await import("../event-plane/producer.js")
    const { collectionsByType } = await import("../event-plane/define.js")
    const plane = buildPlane()
    const producer = makePlaneProducer({
      planeName: plane.name,
      streamUrl: freshStreamUrl("event-plane-producer-stream-fail"),
      collectionsByType: collectionsByType(plane.state),
    })
    const event = plane.state.rows.insert({
      value: { id: "r-bad-url", status: "pending" },
    })
    const exit = await Effect.runPromise(Effect.exit(producer.emit(event)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause)
      expect(err._tag).toBe("Some")
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(PlaneProducerError)
      }
    }
  })
})
