import { DurableStream } from "@durable-streams/client"
import { createStateSchema } from "@durable-streams/state"
import { Cause, Effect, Exit, Ref, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  EventPlane,
  type PlaneProjectionQuery,
} from "../event-plane/index.ts"
import { Work, WorkClaimLive } from "../coordination/work.ts"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

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

// client-event-plane-registration.PROJECTION_API.4
// Plane projection rows are NOT substrate ownership authority.
// Observation alone does NOT cause the handler to run; ownership must
// be acquired through the substrate Work pipeline backed by
// substrate's WorkClaim service.
describe("client-event-plane-registration.PROJECTION_API.4 — plane row observation is NOT authority; Work pipeline is the claim boundary", () => {
  it("handler runs only after a Work.claimedBy step on the substrate WorkClaim service, even when the plane row is already 'ready'", async () => {
    // Plane stream — domain rows live here.
    const planeUrl = freshStreamUrl("event-plane-no-authority-plane")
    await DurableStream.create({ url: planeUrl, contentType: "application/json" })
    const plane = buildPlane()
    const writer = new DurableStream({ url: planeUrl, contentType: "application/json" })
    await writer.append(
      JSON.stringify(
        plane.state.rows.insert({ value: { id: "r-1", status: "ready" } }),
      ),
    )
    await writer.append(
      JSON.stringify(
        plane.state.rows.insert({ value: { id: "r-2", status: "ready" } }),
      ),
    )

    // Substrate stream — claim attempts live here. Separate from plane stream.
    const substrateUrl = freshStreamUrl("event-plane-no-authority-substrate")
    await DurableStream.create({ url: substrateUrl, contentType: "application/json" })

    const handlerInvocations = await Effect.runPromise(
      Ref.make<ReadonlyArray<string>>([]),
    )
    const recorderInvocations = await Effect.runPromise(
      Ref.make<ReadonlyArray<string>>([]),
    )

    const readyRowsQuery: PlaneProjectionQuery<typeof plane.state, ReadonlyArray<ExampleRow>> = {
      label: "readyRows",
      authority: "eligibility-producing", // ELIGIBILITY != ownership.
      evaluate: (snap) =>
        Effect.succeed(
          Array.from(snap.rows.values())
            .filter((r) => (r as ExampleRow).status === "ready") as ReadonlyArray<ExampleRow>,
        ),
    }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const projection = yield* plane.Projection
          yield* Work.runScoped(
            projection.stream(readyRowsQuery).pipe(
              Stream.flatMap((items) => Stream.fromIterable(items)),
              Work.claimedBy<ExampleRow>("operator-no-auth", (r) => r.id),
              Work.perform((r) =>
                Ref.update(handlerInvocations, (a) => [...a, r.id]).pipe(
                  Effect.as({ ranFor: r.id }),
                ),
              ),
              Work.recordOutcome((r) =>
                Ref.update(recorderInvocations, (a) => [...a, r.id]),
              ),
              Stream.take(2),
            ),
          )
        }),
      ).pipe(
        Effect.provide(EventPlane.layer(plane, { streamUrl: planeUrl })),
        Effect.provide(WorkClaimLive({ streamUrl: substrateUrl })),
      ),
    )

    const ranFor = (await Effect.runPromise(Ref.get(handlerInvocations)))
      .slice()
      .sort()
    const recordedFor = (await Effect.runPromise(Ref.get(recorderInvocations)))
      .slice()
      .sort()
    // Each row was claimed once via substrate WorkClaim before its
    // handler ran; observation by itself authorized nothing.
    expect(ranFor).toEqual(["r-1", "r-2"])
    expect(recordedFor).toEqual(["r-1", "r-2"])
  })
})

// client-event-plane-registration.PROJECTION_API.4 (negative path)
// If the substrate WorkClaim service is NOT provided, the pipeline
// cannot reach the handler. Observation alone is inert.
describe("client-event-plane-registration.PROJECTION_API.4 — pipeline that observes plane rows but lacks WorkClaim cannot run the handler", () => {
  it("missing substrate WorkClaim layer is a typed missing-service Effect failure, not a hidden 'observation == authority' shortcut", async () => {
    const planeUrl = freshStreamUrl("event-plane-no-authority-missing-claim")
    await DurableStream.create({ url: planeUrl, contentType: "application/json" })
    const plane = buildPlane()
    const writer = new DurableStream({ url: planeUrl, contentType: "application/json" })
    await writer.append(
      JSON.stringify(
        plane.state.rows.insert({ value: { id: "r-x", status: "ready" } }),
      ),
    )

    const readyRowsQuery: PlaneProjectionQuery<typeof plane.state, ReadonlyArray<ExampleRow>> = {
      label: "readyRows",
      authority: "eligibility-producing",
      evaluate: (snap) =>
        Effect.succeed(
          Array.from(snap.rows.values())
            .filter((r) => (r as ExampleRow).status === "ready") as ReadonlyArray<ExampleRow>,
        ),
    }

    const handlerCalled = await Effect.runPromise(Ref.make(false))

    // Compose the pipeline WITHOUT providing WorkClaimLive. The pipeline
    // should fail because Work.claimedBy requires WorkClaim in R; we
    // assert that the handler never ran.
    const program = Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* plane.Projection
        yield* Work.runScoped(
          projection.stream(readyRowsQuery).pipe(
            Stream.flatMap((items) => Stream.fromIterable(items)),
            Work.claimedBy<ExampleRow>("operator-no-claim", (r) => r.id),
            Work.perform(() => Ref.set(handlerCalled, true)),
            Stream.take(1),
          ),
        )
      }),
    ).pipe(
      Effect.provide(EventPlane.layer(plane, { streamUrl: planeUrl })),
      // Intentionally NOT providing WorkClaimLive.
    ) as unknown as Effect.Effect<void, unknown>

    const exit = await Effect.runPromise(Effect.exit(program))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      // Effect's missing-service failure surfaces as a defect.
      const isDefect = !Cause.isInterruptedOnly(exit.cause)
      expect(isDefect).toBe(true)
    }
    expect(await Effect.runPromise(Ref.get(handlerCalled))).toBe(false)
  })
})
