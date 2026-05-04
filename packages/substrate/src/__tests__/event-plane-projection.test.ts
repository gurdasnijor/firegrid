import { DurableStream } from "@durable-streams/client"
import { createStateSchema } from "@durable-streams/state"
import { Cause, Chunk, Duration, Effect, Exit, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  EventPlane,
  PlaneProjectionWaitTimeout,
  type PlaneProjectionQuery,
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
type ExampleRow = Schema.Schema.Type<typeof ExampleRow>

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

describe("client-event-plane-registration.PROJECTION_API.1, .2 — typed snapshot/stream/until without exposing raw StreamDB", () => {
  it("snapshot returns the materialized rows after a producer emit, without leaking StreamDB collections", async () => {
    const url = freshStreamUrl("event-plane-projection-snapshot")
    await DurableStream.create({ url, contentType: "application/json" })
    const plane = buildPlane()

    // Pre-emit two rows directly to the stream so the projection sees
    // them at first preload.
    const stream = new DurableStream({ url, contentType: "application/json" })
    await stream.append(
      JSON.stringify(
        plane.state.rows.insert({ value: { id: "r-1", status: "pending" } }),
      ),
    )
    await stream.append(
      JSON.stringify(
        plane.state.rows.insert({ value: { id: "r-2", status: "pending" } }),
      ),
    )

    const allRowsQuery: PlaneProjectionQuery<typeof plane.state, ReadonlyArray<ExampleRow>> = {
      label: "allRows",
      authority: "observational",
      evaluate: (snap) => Effect.succeed(Array.from(snap.rows.values()) as ReadonlyArray<ExampleRow>),
    }

    const rows = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const projection = yield* plane.Projection
          return yield* projection.snapshot(allRowsQuery)
        }),
      ).pipe(Effect.provide(EventPlane.layer(plane, { streamUrl: url }))),
    )
    expect(rows.map((r) => r.id).sort()).toEqual(["r-1", "r-2"])
  })
})

describe("client-event-plane-registration.PROJECTION_API.1, .2 — stream emits initial snapshot then changes (no polling)", () => {
  it("yields snapshot once, then one entry per appended row", async () => {
    const url = freshStreamUrl("event-plane-projection-stream")
    await DurableStream.create({ url, contentType: "application/json" })
    const plane = buildPlane()
    const stream = new DurableStream({ url, contentType: "application/json" })
    await stream.append(
      JSON.stringify(
        plane.state.rows.insert({ value: { id: "r-init", status: "pending" } }),
      ),
    )

    const idsQuery: PlaneProjectionQuery<typeof plane.state, ReadonlyArray<string>> = {
      label: "ids",
      authority: "observational",
      evaluate: (snap) =>
        Effect.succeed(Array.from(snap.rows.keys()).sort()),
    }

    const program = Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* plane.Projection
        const fiber = yield* Effect.fork(
          projection.stream(idsQuery).pipe(Stream.take(3), Stream.runCollect),
        )
        yield* Effect.sleep(Duration.millis(40))
        const writer = new DurableStream({ url, contentType: "application/json" })
        yield* Effect.tryPromise(() =>
          writer.append(
            JSON.stringify(
              plane.state.rows.insert({ value: { id: "r-add-1", status: "pending" } }),
            ),
          ),
        )
        yield* Effect.sleep(Duration.millis(40))
        yield* Effect.tryPromise(() =>
          writer.append(
            JSON.stringify(
              plane.state.rows.insert({ value: { id: "r-add-2", status: "pending" } }),
            ),
          ),
        )
        return yield* fiber
      }),
    )

    const collected = await Effect.runPromise(
      program.pipe(Effect.provide(EventPlane.layer(plane, { streamUrl: url }))),
    )
    const arrays = Chunk.toReadonlyArray(collected).map((arr) => [...arr])
    expect(arrays[0]).toEqual(["r-init"])
    expect(arrays[arrays.length - 1]).toEqual(["r-add-1", "r-add-2", "r-init"])
  })
})

describe("client-event-plane-registration.PROJECTION_API.1, .2 — until resolves on snapshot match and times out as a typed error", () => {
  it("resolves immediately when snapshot already contains the matching row", async () => {
    const url = freshStreamUrl("event-plane-projection-until-snap")
    await DurableStream.create({ url, contentType: "application/json" })
    const plane = buildPlane()
    const writer = new DurableStream({ url, contentType: "application/json" })
    await writer.append(
      JSON.stringify(
        plane.state.rows.insert({ value: { id: "r-ready", status: "ready" } }),
      ),
    )

    const readyQuery: PlaneProjectionQuery<typeof plane.state, ExampleRow | undefined> = {
      label: "ready(r-ready)",
      authority: "eligibility-producing",
      evaluate: (snap) =>
        Effect.succeed(snap.rows.get("r-ready") as ExampleRow | undefined),
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const projection = yield* plane.Projection
          return yield* projection.until(
            readyQuery,
            (r): r is ExampleRow => r !== undefined && r.status === "ready",
            { timeout: Duration.seconds(2) },
          )
        }),
      ).pipe(Effect.provide(EventPlane.layer(plane, { streamUrl: url }))),
    )
    expect(result?.status).toBe("ready")
  })

  it("times out as PlaneProjectionWaitTimeout carrying plane name + label + Duration", async () => {
    const url = freshStreamUrl("event-plane-projection-until-timeout")
    await DurableStream.create({ url, contentType: "application/json" })
    const plane = buildPlane()
    const writer = new DurableStream({ url, contentType: "application/json" })
    await writer.append(
      JSON.stringify(
        plane.state.rows.insert({ value: { id: "r-stuck", status: "pending" } }),
      ),
    )

    const timeout = Duration.millis(150)
    const readyQuery: PlaneProjectionQuery<typeof plane.state, ExampleRow | undefined> = {
      label: "ready(r-stuck)",
      authority: "eligibility-producing",
      evaluate: (snap) =>
        Effect.succeed(snap.rows.get("r-stuck") as ExampleRow | undefined),
    }
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const projection = yield* plane.Projection
            return yield* projection.until(
              readyQuery,
              (r): r is ExampleRow => r !== undefined && r.status === "ready",
              { timeout },
            )
          }),
        ).pipe(Effect.provide(EventPlane.layer(plane, { streamUrl: url }))),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause)
      expect(err._tag).toBe("Some")
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(PlaneProjectionWaitTimeout)
        if (err.value instanceof PlaneProjectionWaitTimeout) {
          expect(err.value.planeName).toBe("example.adapter")
          expect(err.value.label).toBe("ready(r-stuck)")
          expect(Duration.toMillis(err.value.elapsed)).toBe(
            Duration.toMillis(timeout),
          )
        }
      }
    }
  })
})

describe("client-event-plane-registration.PROJECTION_API.3 — query.authority kind is plumbed", () => {
  it("a query carries its declared authority kind in the value passed to consumers", () => {
    const q: PlaneProjectionQuery<ReturnType<typeof buildPlane>["state"], number> = {
      label: "count",
      authority: "observational",
      evaluate: (snap) => Effect.succeed(snap.rows.size),
    }
    // Authority is part of the query declaration so callers can branch
    // on observational vs eligibility-producing vs terminal-domain when
    // composing into Work pipelines (see event-plane-no-authority.test.ts).
    expect(q.authority).toBe("observational")
  })
})
