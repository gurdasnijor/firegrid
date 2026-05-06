import { DurableStream } from "@durable-streams/client"
import {
  EventStream,
  makeEventStreamStateRow,
  Operation,
  OPERATION_ENVELOPE_TAG,
  type EventStreamStateRow,
} from "@firegrid/substrate/descriptors"
import {
  rebuildProjection,
  startRun,
} from "@firegrid/substrate/kernel"
import {
  Data,
  Deferred,
  Duration,
  Effect,
  Layer,
  Ref,
  Schedule,
  Schema,
} from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"
import { Firegrid, FiregridRuntime, FiregridRuntimeBoot } from "../index.ts"

// firegrid-event-streams.SCHEMA_OWNERSHIP.2
// firegrid-event-streams.SCHEMA_OWNERSHIP.3
// firegrid-architecture-boundary.AUTHORITY.2
// firegrid-architecture-boundary.AUTHORITY.4
//
// Mixed-stream compatibility smoke. Firegrid EventStream records are
// State Protocol rows on the same substrate stream that carries
// authority rows (durable.run / durable.completion / ...).
// This test proves substrate consumers — the operation handler
// (which observes substrate run rows) and `rebuildProjection`
// (which folds the canonical substrate state schema) — keep
// working when EventStream envelopes are present on the stream.

class SeedFailed extends Data.TaggedError("SeedFailed")<{
  readonly cause: unknown
}> {}
class RebuildFailed extends Data.TaggedError("RebuildFailed")<{
  readonly cause: unknown
}> {}
class HandlerNotYetCompleted extends Data.TaggedError(
  "HandlerNotYetCompleted",
)<Record<string, never>> {}

const Hits = EventStream.define({
  name: "Hits",
  event: Schema.Struct({
    url: Schema.String,
    count: Schema.Number,
  }),
})

const Echo = Operation.define({
  name: "MixedEcho",
  input: Schema.Struct({ msg: Schema.String }),
  output: Schema.Struct({ msg: Schema.String, len: Schema.Number }),
})

const appendRaw = (
  streamUrl: string,
  payload: unknown,
): Effect.Effect<void, SeedFailed> =>
  Effect.tryPromise({
    try: async () => {
      const handle = new DurableStream({
        url: streamUrl,
        contentType: "application/json",
      })
      await handle.append(JSON.stringify(payload))
    },
    catch: (cause) => new SeedFailed({ cause }),
  })

const createRuntimeStream = async (name: string): Promise<string> => {
  const streamUrl = freshStreamUrl(name)
  await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  return streamUrl
}

describe("Firegrid same-stream coexistence — EventStream State Protocol rows do not break substrate consumers", () => {
  beforeAll(async () => {
    await startTestServer()
  })

  afterAll(async () => {
    await stopTestServer()
  })

  it("firegrid-event-streams.SCHEMA_OWNERSHIP.2, firegrid-event-streams.SCHEMA_OWNERSHIP.3 — handler terminalizes and rebuildProjection folds after firegrid.event rows exist", async () => {
    const streamUrl = await createRuntimeStream("firegrid-mixed-compat")

    const program = Effect.gen(function* () {
      const observed = yield* Ref.make<
        ReadonlyArray<EventStream.Event<typeof Hits>>
      >([])
      const reachedTarget = yield* Deferred.make<void>()
      const targetCount = 2

      const eventLayer = Firegrid.eventStream(Hits, (event) =>
        Effect.gen(function* () {
          const next = yield* Ref.updateAndGet(observed, (prev) => [
            ...prev,
            event,
          ])
          if (next.length >= targetCount) {
            yield* Deferred.succeed(reachedTarget, undefined)
          }
        }),
      )

      const handlerLayer = Firegrid.handler(Echo, (input) =>
        Effect.succeed({ msg: input.msg, len: input.msg.length }),
      )

      const runtimeLayer = Layer.mergeAll(handlerLayer, eventLayer)

      const runId = "mixed-run-1"

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* FiregridRuntime
          expect(runtime.bootMode).toBe("attached")
          expect(runtime.streamIdentity.streamUrl).toBe(streamUrl)

          // Interleave EventStream State Protocol rows around an
          // operation envelope. The substrate consumers must tolerate
          // the EventStream rows and still see the run.
          const eventA: EventStreamStateRow = makeEventStreamStateRow({
            stream: Hits.name,
            eventId: "a",
            event: { url: "/a", count: 1 },
          })
          const eventB: EventStreamStateRow = makeEventStreamStateRow({
            stream: Hits.name,
            eventId: "b",
            event: { url: "/b", count: 2 },
          })
          const noiseEnvelope: EventStreamStateRow = makeEventStreamStateRow({
            stream: "OtherStream",
            eventId: "noise",
            event: { unrelated: true },
          })
          const startedRunEvent = yield* startRun({
            runId,
            data: {
              _envelope: OPERATION_ENVELOPE_TAG,
              operation: Echo.name,
              payload: { msg: "hello" },
            },
          })

          yield* appendRaw(streamUrl, eventA)
          yield* appendRaw(streamUrl, noiseEnvelope)
          yield* appendRaw(streamUrl, startedRunEvent)
          yield* appendRaw(streamUrl, eventB)

          // 1) The materializer dispatches both matching events in
          //    arrival order, irrespective of the operation row
          //    sitting between them.
          yield* Deferred.await(reachedTarget).pipe(
            Effect.timeout(Duration.seconds(5)),
          )
          const events = yield* Ref.get(observed)
          expect(events).toEqual([
            { url: "/a", count: 1 },
            { url: "/b", count: 2 },
          ])

          // 2) The operation handler still observes the started run
          //    and terminalizes it as `completed` with the encoded
          //    output.
          const completedRun = yield* Effect.tryPromise({
            try: () => rebuildProjection({ url: streamUrl }),
            catch: (cause) => new RebuildFailed({ cause }),
          }).pipe(
            Effect.flatMap((snap) => {
              const run = snap.runs.get(runId)
              if (run !== undefined && run.state === "completed") {
                return Effect.succeed(run)
              }
              return Effect.fail(new HandlerNotYetCompleted({}))
            }),
            Effect.retry({
              times: 50,
              schedule: Schedule.spaced("50 millis"),
            }),
          )
          expect(completedRun.state).toBe("completed")
          expect(completedRun.result).toEqual({ msg: "hello", len: 5 })

          // 3) rebuildProjection itself succeeds and returns a
          //    well-formed substrate snapshot. EventStream rows do
          //    not replace substrate run authority; only the
          //    durable.run row family lands in snap.runs.
          const finalSnapshot = yield* Effect.tryPromise({
            try: () => rebuildProjection({ url: streamUrl }),
            catch: (cause) => new RebuildFailed({ cause }),
          })
          expect(finalSnapshot.runs.size).toBe(1)
          expect(finalSnapshot.runs.get(runId)?.state).toBe("completed")

          return undefined
        }).pipe(
          Effect.provide(
            FiregridRuntimeBoot.attached({
              streamUrl,
              runtime: runtimeLayer,
            }),
          ),
        ),
      )
    })

    await Effect.runPromise(program)
  })
})
