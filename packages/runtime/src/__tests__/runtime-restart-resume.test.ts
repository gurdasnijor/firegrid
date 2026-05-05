import { DurableStream } from "@durable-streams/client"
import {
  EventStream,
  makeEventStreamStateRow,
  type EventStreamStateRow,
} from "@durable-agent-substrate/substrate/descriptors"
import {
  createPendingCompletion,
  rebuildProjection,
} from "@durable-agent-substrate/substrate/kernel"
import { Data, Deferred, Duration, Effect, Schedule, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "../../../../test-support/durable-streams-server.ts"
import { Firegrid, FiregridRuntimeBoot } from "../index.ts"

class AppendFailed extends Data.TaggedError("AppendFailed")<{
  readonly cause: unknown
}> {}
class RebuildFailed extends Data.TaggedError("RebuildFailed")<{
  readonly cause: unknown
}> {}
class CompletionNotResolvedYet extends Data.TaggedError(
  "CompletionNotResolvedYet",
)<Record<string, never>> {}

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

const Hits = EventStream.define({
  name: "RestartHits",
  event: Schema.Struct({
    url: Schema.String,
    count: Schema.Number,
  }),
})

const appendRaw = (
  streamUrl: string,
  row: unknown,
): Effect.Effect<void, AppendFailed> =>
  Effect.tryPromise({
    try: async () => {
      const stream = await DurableStream.create({
        url: streamUrl,
        contentType: "application/json",
      })
      await stream.append(JSON.stringify(row))
    },
    catch: (cause) => new AppendFailed({ cause }),
  })

describe("firegrid-remediation-hardening.TEST_GUARDRAILS.5 — runtime restart resume", () => {
  it("firegrid-remediation-hardening.TEST_GUARDRAILS.5, firegrid-runtime-process.RUNTIME_HOT_PATH.1 — timer subscriber resolves an in-flight durable wait after scope reconstruction", async () => {
    const streamUrl = freshStreamUrl("restart-timer")
    const completionId = "timer-restart"
    const dueAtMs = Date.now() - 1_000

    await Effect.runPromise(
      appendRaw(
        streamUrl,
        createPendingCompletion({
          completionId,
          kind: "timer",
          data: { durationMs: 1, dueAtMs },
        }),
      ),
    )

    const resolved = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const completion = yield* Effect.tryPromise({
            try: () => rebuildProjection({ url: streamUrl }),
            catch: (cause) => new RebuildFailed({ cause }),
          }).pipe(
            Effect.flatMap((snapshot) => {
              const current = snapshot.completions.get(completionId)
              if (current?.state === "resolved") {
                return Effect.succeed(current)
              }
              return Effect.fail(new CompletionNotResolvedYet({}))
            }),
            Effect.retry({
              times: 50,
              schedule: Schedule.spaced("50 millis"),
            }),
          )
          return completion
        }).pipe(
          Effect.provide(
            FiregridRuntimeBoot.attached({
              streamUrl,
              runtime: Firegrid.subscribers.timer,
            }),
          ),
        ),
      ),
    )

    expect(resolved.state).toBe("resolved")
    expect(resolved.result).toMatchObject({ dueAtMs })
  })

  it("firegrid-remediation-hardening.TEST_GUARDRAILS.5 — EventStream materializer catches up to durable rows after scope reconstruction", async () => {
    const streamUrl = freshStreamUrl("restart-eventstream")
    const row: EventStreamStateRow = makeEventStreamStateRow({
      stream: Hits.name,
      eventId: "hit-1",
      event: { url: "/restart", count: 1 },
    })

    await Effect.runPromise(appendRaw(streamUrl, row))

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<EventStream.Event<typeof Hits>>()
        return yield* Effect.scoped(
          Deferred.await(reached).pipe(
            Effect.timeout(Duration.seconds(5)),
            Effect.provide(
              FiregridRuntimeBoot.attached({
                streamUrl,
                runtime: Firegrid.eventStream(Hits, (event) =>
                  Deferred.succeed(reached, event),
                ),
              }),
            ),
          ),
        )
      }),
    )

    expect(observed).toEqual({ url: "/restart", count: 1 })
  })
})
