import { DurableStream } from "@durable-streams/client"
import {
  Operation,
  OPERATION_ENVELOPE_TAG,
  rebuildProjection,
  startRun,
} from "@durable-agent-substrate/substrate"
import { Data, Effect, Schedule, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Firegrid, FiregridRuntime, FiregridRuntimeBoot } from "../index.ts"

class SeedFailed extends Data.TaggedError("SeedFailed")<{
  readonly cause: unknown
}> {}
class RebuildFailed extends Data.TaggedError("RebuildFailed")<{
  readonly cause: unknown
}> {}
class RunNotYetCompleted extends Data.TaggedError(
  "RunNotYetCompleted",
)<Record<string, never>> {}

// firegrid-operation-messaging.RUNTIME_HANDLERS.1
// firegrid-operation-messaging.RUNTIME_HANDLERS.4
// firegrid-runtime-process.RUNTIME_HOT_PATH.1
//
// End-to-end smoke for `Firegrid.handler`: provide the handler
// Layer to FiregridRuntimeBoot.embeddedDev, manually seed a
// "started" run carrying a Firegrid operation envelope, and assert
// the run terminalizes with the encoded handler output. The seed
// uses substrate primitives directly because exercising the typed
// client surface here would cross the runtime → client boundary
// (forbidden); the client integration is covered separately in the
// client package's tests.

const Echo = Operation.define({
  name: "Echo",
  input: Schema.Struct({ msg: Schema.String }),
  output: Schema.Struct({ msg: Schema.String, len: Schema.Number }),
})

const seedStartedRun = async (
  streamUrl: string,
  runId: string,
  payload: { readonly msg: string },
): Promise<void> => {
  const stream = await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  const event = startRun({
    runId,
    data: {
      _envelope: OPERATION_ENVELOPE_TAG,
      operation: Echo.name,
      payload,
    },
  })
  await stream.append(JSON.stringify(event))
}

describe("Firegrid.handler — typed dispatch over started runs", () => {
  it("encodes the handler's output and terminalizes the run as completed", async () => {
    const handlerLayer = Firegrid.handler(Echo, (input) =>
      Effect.succeed({ msg: input.msg, len: input.msg.length }),
    )

    const runId = "run-echo-1"

    const program = Effect.gen(function* () {
      const runtime = yield* FiregridRuntime
      const streamUrl = runtime.streamIdentity.streamUrl

      yield* Effect.tryPromise({
        try: () => seedStartedRun(streamUrl, runId, { msg: "hello" }),
        catch: (cause) => new SeedFailed({ cause }),
      })

      // Poll the projection until the handler-driven completion lands.
      const final = yield* Effect.tryPromise({
        try: () => rebuildProjection({ url: streamUrl }),
        catch: (cause) => new RebuildFailed({ cause }),
      }).pipe(
        Effect.flatMap((snap) => {
          const run = snap.runs.get(runId)
          if (run !== undefined && run.state === "completed") {
            return Effect.succeed(run)
          }
          return Effect.fail(new RunNotYetCompleted({}))
        }),
        Effect.retry({
          times: 50,
          schedule: Schedule.spaced("50 millis"),
        }),
      )
      return final
    }).pipe(
      Effect.provide(
        FiregridRuntimeBoot.embeddedDev({
          streamName: "firegrid-handler-test",
          runtime: handlerLayer,
        }),
      ),
    )

    const completedRun = await Effect.runPromise(Effect.scoped(program))
    expect(completedRun.state).toBe("completed")
    expect(completedRun.result).toEqual({ msg: "hello", len: 5 })
  })
})
