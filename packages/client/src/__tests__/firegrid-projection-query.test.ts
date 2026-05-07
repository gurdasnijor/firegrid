import { DurableStream } from "@durable-streams/client"
import { createStateSchema } from "@durable-streams/state"
import { Cause, Chunk, Duration, Effect, Exit, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ProjectionCursor,
  ProjectionQueryClient,
  ProjectionQueryClientLive,
  ProjectionQueryReadError,
  ProjectionQueryTimeout,
  projectionFor,
  type ProjectionQuery,
} from "../projection-query.ts"
import { EventPlane } from "@firegrid/substrate/event-plane"
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

const WidgetRow = Schema.Struct({
  id: Schema.String,
  status: Schema.Literal("pending", "ready"),
  count: Schema.Number,
})
type WidgetRow = Schema.Schema.Type<typeof WidgetRow>

const buildPlane = () => {
  const state = createStateSchema({
    widgets: {
      type: "app.widget",
      primaryKey: "id",
      schema: Schema.standardSchemaV1(WidgetRow),
    },
  })
  return EventPlane.define({ name: "app.widgets", state })
}
type WidgetPlane = ReturnType<typeof buildPlane>

const appendWidget = (
  url: string,
  plane: WidgetPlane,
  row: WidgetRow,
) =>
  Effect.tryPromise(() => {
    const durable = new DurableStream({ url, contentType: "application/json" })
    return durable.append(JSON.stringify(plane.state.widgets.upsert({ value: row })))
  })

const countQuery = (): ProjectionQuery<WidgetPlane["state"], number> => ({
  label: "widget-count",
  authority: "observational",
  evaluate: (snapshot) => Effect.succeed(snapshot.widgets.size),
})

const readyRowQuery = (
  id: string,
): ProjectionQuery<WidgetPlane["state"], WidgetRow | undefined> => ({
  label: `ready:${id}`,
  authority: "eligibility-producing",
  evaluate: (snapshot) =>
    Effect.succeed(snapshot.widgets.get(id) as WidgetRow | undefined),
})

const layerFor = (streamUrl: string) =>
  ProjectionQueryClientLive({ streamUrl, contentType: "application/json" })

describe("firegrid-client-projection-api.BROWSER_SAFE_FACADE.2 — descriptor-scoped projection query handles", () => {
  it("firegrid-projection-query.QUERY_HANDLES.2, .3 — snapshot returns typed app-owned projection data plus an opaque cursor", async () => {
    const url = await createSubstrateStream("projection-query-snapshot")
    const plane = buildPlane()

    await Effect.runPromise(
      appendWidget(url, plane, { id: "w-1", status: "pending", count: 1 }),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* projectionFor(plane)
        return yield* handle.snapshot(countQuery())
      }).pipe(Effect.provide(layerFor(url))),
    )

    expect(result.value).toBe(1)
    expect(result.cursor._tag).toBe("firegrid/ProjectionCursor")
    expect(result.cursor.descriptor).toBe("app.widgets")
    expect("collections" in result).toBe(false)
  })

  it("firegrid-projection-query.QUERY_HANDLES.4 — stream follows app-owned projection changes from an explicit cursor", async () => {
    const url = await createSubstrateStream("projection-query-stream")
    const plane = buildPlane()

    await Effect.runPromise(
      appendWidget(url, plane, { id: "w-1", status: "pending", count: 1 }),
    )

    const collected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* ProjectionQueryClient
          const handle = client.projectionFor(plane)
          const snapshot = yield* handle.snapshot(countQuery())
          const fiber = yield* handle
            .stream(countQuery(), snapshot.cursor)
            .pipe(
              Stream.filter((count) => count >= 2),
              Stream.take(2),
              Stream.runCollect,
              Effect.fork,
            )
          yield* Effect.sleep(Duration.millis(40))
          yield* appendWidget(url, plane, {
            id: "w-2",
            status: "pending",
            count: 2,
          })
          yield* Effect.sleep(Duration.millis(40))
          yield* appendWidget(url, plane, {
            id: "w-3",
            status: "pending",
            count: 3,
          })
          return yield* fiber
        }),
      ).pipe(Effect.provide(layerFor(url))),
    )

    expect(Chunk.toReadonlyArray(collected)).toEqual([2, 3])
  })

  it("firegrid-projection-query.QUERY_HANDLES.5 and EXPECTED_ERRORS.4 — until checks snapshot first and times out with typed errors", async () => {
    const url = await createSubstrateStream("projection-query-until")
    const plane = buildPlane()

    await Effect.runPromise(
      appendWidget(url, plane, { id: "w-ready", status: "ready", count: 1 }),
    )

    const immediate = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* projectionFor(plane)
        const snapshot = yield* handle.snapshot(countQuery())
        return yield* handle.until(
          readyRowQuery("w-ready"),
          (row): row is WidgetRow => row?.status === "ready",
          { cursor: snapshot.cursor, timeout: Duration.seconds(1) },
        )
      }).pipe(Effect.provide(layerFor(url))),
    )

    expect(immediate?.id).toBe("w-ready")

    const timeout = Duration.millis(100)
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const handle = yield* projectionFor(plane)
          const snapshot = yield* handle.snapshot(countQuery())
          return yield* handle.until(
            readyRowQuery("missing"),
            (row): row is WidgetRow => row?.status === "ready",
            { cursor: snapshot.cursor, timeout },
          )
        }).pipe(Effect.provide(layerFor(url))),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause)
      expect(error._tag).toBe("Some")
      if (error._tag === "Some") {
        expect(error.value).toBeInstanceOf(ProjectionQueryTimeout)
        if (error.value instanceof ProjectionQueryTimeout) {
          expect(error.value.descriptor).toBe("app.widgets")
          expect(error.value.label).toBe("ready:missing")
        }
      }
    }
  })

  it("firegrid-projection-query.EXPECTED_ERRORS.1 — malformed cursors stay in the typed Effect error channel", async () => {
    const url = await createSubstrateStream("projection-query-cursor")
    const plane = buildPlane()
    const wrongCursor = ProjectionCursor.initial({ name: "other.widgets" })

    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const handle = yield* projectionFor(plane)
          return yield* handle.stream(countQuery(), wrongCursor).pipe(
            Stream.runCollect,
          )
        }).pipe(Effect.provide(layerFor(url))),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause)
      expect(error._tag).toBe("Some")
      if (error._tag === "Some") {
        expect(error.value).toBeInstanceOf(ProjectionQueryReadError)
        if (error.value instanceof ProjectionQueryReadError) {
          expect(error.value.reason).toBe("malformed-cursor")
          expect(error.value.descriptor).toBe("app.widgets")
        }
      }
    }
  })
})
