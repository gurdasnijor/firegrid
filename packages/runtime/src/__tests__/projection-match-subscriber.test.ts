import { DurableStream } from "@durable-streams/client"
import {
  createPendingCompletion,
  makeEventStreamStateRow,
  rebuildProjection,
  type ProjectionMatchEvaluator,
} from "@firegrid/substrate/kernel"
import {
  Data,
  Effect,
  Schedule,
} from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"
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

const resolvedCompletionFromProjection = (
  streamUrl: string,
  completionId: string,
) =>
  Effect.tryPromise({
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

const projectionTrigger = (label: string) => ({
  _tag: "ProjectionMatch" as const,
  label,
  projectionKey: `projection:${label}`,
  matcherId: `matcher:${label}`,
})

describe("Firegrid.subscribers.projectionMatch", () => {
  it("firegrid-runtime-process.RUNTIME_PACKAGE.5, firegrid-runtime-process.RUNTIME_HOT_PATH.2, firegrid-runtime-process.RUNTIME_HOT_PATH.3 — resolves a projection_match completion after a caller-owned EventStream edge", async () => {
    const streamUrl = freshStreamUrl("runtime-projection-match")
    const completionId = "projection-match-runtime"
    const eventStreamName = "UserEvents"
    const targetUserId = "user-1"

    const evaluate: ProjectionMatchEvaluator = (snapshot, trigger) => {
      const matched = Array.from(snapshot.eventStreams.values()).find(
        (row) =>
          row.stream === eventStreamName &&
          typeof row.event === "object" &&
          row.event !== null &&
          "userId" in row.event &&
          row.event.userId === targetUserId &&
          trigger.matcherId === "matcher:user-event",
      )
      return Effect.succeed(
        matched === undefined
          ? { kind: "no-match" as const }
          : { kind: "match" as const, value: matched.event },
      )
    }

    await Effect.runPromise(
      appendRaw(
        streamUrl,
        Effect.runSync(createPendingCompletion({
          completionId,
          kind: "projection_match",
          data: {
            trigger: projectionTrigger("user-event"),
          },
        })),
      ),
    )

    const resolved = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* appendRaw(
            streamUrl,
            makeEventStreamStateRow({
              stream: eventStreamName,
              eventId: "evt-1",
              event: { userId: targetUserId, action: "ready" },
            }),
          )
          return yield* resolvedCompletionFromProjection(
            streamUrl,
            completionId,
          )
        }).pipe(
          Effect.provide(
            FiregridRuntimeBoot.attached({
              streamUrl,
              runtime: Firegrid.subscribers.projectionMatch({ evaluate }),
            }),
          ),
        ),
      ),
    )

    expect(resolved.state).toBe("resolved")
    expect(resolved.result).toEqual({
      matchedValue: { userId: targetUserId, action: "ready" },
    })
  })
})
