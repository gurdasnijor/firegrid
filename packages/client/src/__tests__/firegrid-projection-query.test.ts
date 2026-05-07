import { DurableStream } from "@durable-streams/client"
import { createStateSchema } from "@durable-streams/state"
import { Chunk, Duration, Effect, Schema, Stream } from "effect"
import {
  ProjectionCursor,
  ProjectionQueryClient,
  ProjectionQueryClientLive,
  ProjectionQueryReadError,
  ProjectionQueryTimeout,
  createProjectionQueryClient,
  liveQuery,
  observe,
  projectionFor,
  until,
  untilWhere,
  type ProjectionQuery,
} from "../projection-query.ts"
import { EventPlane } from "@firegrid/substrate/event-plane"
import {
  createSubstrateStream,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

const { afterAll, beforeAll, describe, expect, it } = await import("vitest")

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

const clientFor = (streamUrl: string) =>
  createProjectionQueryClient({ streamUrl, contentType: "application/json" })

const run = Effect.runPromise

describe("firegrid-client-projection-api.BROWSER_SAFE_FACADE.2 — descriptor-scoped projection query handles", () => {
  it("firegrid-client-projection-api.BROWSER_SAFE_FACADE.3 — top-level observe is query-first for basic UI reads", async () => {
    const url = await createSubstrateStream("projection-query-top-level-observe")
    const plane = buildPlane()

    await run(
      appendWidget(url, plane, { id: "w-1", status: "pending", count: 1 }),
    )

    const collected = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* observe(plane, countQuery(), {
            streamUrl: url,
            contentType: "application/json",
          }).pipe(Stream.take(2), Stream.runCollect, Effect.fork)
          yield* Effect.sleep(Duration.millis(40))
          yield* appendWidget(url, plane, {
            id: "w-2",
            status: "pending",
            count: 2,
          })
          return yield* fiber
        }),
      ),
    )

    expect(Chunk.toReadonlyArray(collected)).toEqual([1, 2])
  })

  it("firegrid-client-projection-api.BROWSER_SAFE_FACADE.3 — liveQuery reads collections with where, orderBy, select, and count ergonomics", async () => {
    const url = await createSubstrateStream("projection-query-live-query")
    const plane = buildPlane()

    await run(
      Effect.all([
        appendWidget(url, plane, { id: "w-1", status: "pending", count: 3 }),
        appendWidget(url, plane, { id: "w-2", status: "ready", count: 1 }),
        appendWidget(url, plane, { id: "w-3", status: "ready", count: 2 }),
      ]),
    )

    const results = await run(
      Effect.all({
        count: liveQuery(
          plane,
          (q) =>
            q
              .from({ widget: q.collection<"widgets", WidgetRow>("widgets") })
              .where(({ widget }) => widget.status === "ready")
              .count(),
          { streamUrl: url, contentType: "application/json" },
        ).pipe(Stream.take(1), Stream.runCollect),
        rows: liveQuery(
          plane,
          (q) =>
            q
              .from({ widget: q.collection<"widgets", WidgetRow>("widgets") })
              .where(({ widget }) => widget.status === "ready")
              .orderBy(({ widget }) => widget.count, "desc")
              .select(({ widget }) => ({ id: widget.id, count: widget.count })),
          { streamUrl: url, contentType: "application/json" },
        ).pipe(Stream.take(1), Stream.runCollect),
      }),
    )

    expect(Chunk.toReadonlyArray(results.count)).toEqual([2])
    expect(Chunk.toReadonlyArray(results.rows)).toEqual([
      [
        { id: "w-3", count: 2 },
        { id: "w-2", count: 1 },
      ],
    ])
  })

  it("firegrid-client-projection-api.BROWSER_SAFE_FACADE.3 — liveQuery rejects unsupported multi-collection from clauses visibly", async () => {
    const url = await createSubstrateStream("projection-query-live-query-multi-source")
    const plane = buildPlane()

    const error = await run(
      liveQuery(
        plane,
        (q) =>
          q.from({
            left: q.collection<"widgets", WidgetRow>("widgets"),
            right: q.collection<"widgets", WidgetRow>("widgets"),
          }),
        { streamUrl: url, contentType: "application/json" },
      ).pipe(Stream.take(1), Stream.runCollect, Effect.flip),
    )

    expect(error).toBeInstanceOf(ProjectionQueryReadError)
    expect(error.reason).toBe("decode-failure")
    expect(error.cause).toBe("liveQuery.from supports exactly one collection in this MVP")
  })

  it("firegrid-client-projection-api.BROWSER_SAFE_FACADE.3 — top-level until is query-first and untilWhere keeps predicates explicit", async () => {
    const url = await createSubstrateStream("projection-query-top-level-until")
    const plane = buildPlane()

    await run(
      appendWidget(url, plane, { id: "w-ready", status: "ready", count: 1 }),
    )

    const results = await run(
      Effect.all({
        present: until(
          plane,
          readyRowQuery("w-ready"),
          {
            streamUrl: url,
            contentType: "application/json",
            timeout: Duration.seconds(1),
          },
        ),
        predicate: untilWhere(
          plane,
          readyRowQuery("w-ready"),
          (row): row is WidgetRow => row?.status === "ready",
          {
            streamUrl: url,
            contentType: "application/json",
            timeout: Duration.seconds(1),
          },
        ),
      }),
    )

    expect(results.present.id).toBe("w-ready")
    expect(results.predicate?.id).toBe("w-ready")
  })

  it("firegrid-projection-query.QUERY_HANDLES.2, .3 and EXPECTED_ERRORS.1 — snapshot returns app-owned data and cursor errors stay typed", async () => {
    const url = await createSubstrateStream("projection-query-snapshot")
    const plane = buildPlane()

    await run(
      appendWidget(url, plane, { id: "w-1", status: "pending", count: 1 }),
    )

    const result = await run(
      Effect.gen(function* () {
        const handle = yield* projectionFor(plane)
        return yield* handle.snapshot(countQuery())
      }).pipe(Effect.provide(layerFor(url))),
    )

    expect(result.value).toBe(1)
    expect(result.cursor._tag).toBe("firegrid/ProjectionCursor")
    expect(result.cursor.descriptor).toBe("app.widgets")
    expect("collections" in result).toBe(false)

    const wrongCursor = ProjectionCursor.initial({ name: "other.widgets" })
    const error = await run(
      Effect.gen(function* () {
        const handle = yield* projectionFor(plane)
        return yield* handle.stream(countQuery(), wrongCursor).pipe(
          Stream.runCollect,
        )
      }).pipe(Effect.provide(layerFor(url)), Effect.flip),
    )

    expect(error).toBeInstanceOf(ProjectionQueryReadError)
    expect(error.reason).toBe("malformed-cursor")
    expect(error.descriptor).toBe("app.widgets")
  })

  it("firegrid-client-projection-api.BROWSER_SAFE_FACADE.3 and firegrid-projection-query.QUERY_HANDLES.4 — observe owns snapshot plus live follow for UI reads", async () => {
    const url = await createSubstrateStream("projection-query-observe")
    const plane = buildPlane()

    await run(
      appendWidget(url, plane, { id: "w-1", status: "pending", count: 1 }),
    )

    const collected = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const client = clientFor(url)
          const handle = client.projectionFor(plane)
          const fiber = yield* handle
            .observe(countQuery())
            .pipe(
              Stream.take(3),
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
      ),
    )

    expect(Chunk.toReadonlyArray(collected)).toEqual([1, 2, 3])
  })

  it("firegrid-projection-query.CURSOR_AND_REPLAY.3 — observe avoids the snapshot-then-drop gap", async () => {
    const url = await createSubstrateStream("projection-query-observe-no-drop-gap")
    const plane = buildPlane()

    await run(
      appendWidget(url, plane, { id: "w-1", status: "pending", count: 1 }),
    )

    const collected = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = clientFor(url).projectionFor(plane)
          const snapshot = yield* handle.snapshot(countQuery())
          yield* appendWidget(url, plane, {
            id: "w-2",
            status: "pending",
            count: 2,
          })
          return yield* handle
            .observe(countQuery())
            .pipe(Stream.take(1), Stream.runCollect)
            .pipe(Effect.map((values) => ({ snapshot, values })))
        }),
      ),
    )

    expect(collected.snapshot.value).toBe(1)
    expect(Chunk.toReadonlyArray(collected.values)).toEqual([2])
  })

  it("firegrid-projection-query.QUERY_HANDLES.4 — advanced stream follows app-owned projection changes from an explicit cursor", async () => {
    const url = await createSubstrateStream("projection-query-stream")
    const plane = buildPlane()

    await run(
      appendWidget(url, plane, { id: "w-1", status: "pending", count: 1 }),
    )

    const collected = await run(
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

  it("firegrid-projection-query.QUERY_HANDLES.5 and EXPECTED_ERRORS.4 — until checks snapshot first, untilWhere keeps predicates explicit, and timeout errors are typed", async () => {
    const url = await createSubstrateStream("projection-query-until")
    const plane = buildPlane()

    await run(
      appendWidget(url, plane, { id: "w-ready", status: "ready", count: 1 }),
    )

    const immediate = await run(
      Effect.gen(function* () {
        const handle = clientFor(url).projectionFor(plane)
        const present = yield* handle.until(
          readyRowQuery("w-ready"),
          { timeout: Duration.seconds(1) },
        )
        const predicateFiber = yield* handle
          .untilWhere(
            readyRowQuery("w-predicate"),
            (row): row is WidgetRow => row?.status === "ready",
            { timeout: Duration.seconds(1) },
          )
          .pipe(Effect.fork)
        yield* Effect.sleep(Duration.millis(40))
        yield* appendWidget(url, plane, {
          id: "w-predicate",
          status: "ready",
          count: 2,
        })
        const predicate = yield* predicateFiber
        return { predicate, present }
      }),
    )

    expect(immediate.present.id).toBe("w-ready")
    expect(immediate.predicate?.status).toBe("ready")

    const timeout = Duration.millis(100)
    const error = await run(
      Effect.gen(function* () {
        const handle = clientFor(url).projectionFor(plane)
        return yield* handle.until(
          readyRowQuery("missing"),
          { timeout },
        )
      }).pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(ProjectionQueryTimeout)
    if (!(error instanceof ProjectionQueryTimeout)) return
    expect(error.descriptor).toBe("app.widgets")
    expect(error.label).toBe("ready:missing")
  })
})
