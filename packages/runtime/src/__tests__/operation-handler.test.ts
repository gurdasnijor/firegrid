import { DurableStream } from "@durable-streams/client"
import {
  Choreography,
  CompletionId,
  CurrentWorkContext,
  type ChoreographyService,
} from "@firegrid/substrate"
import {
  Operation,
  OPERATION_ENVELOPE_TAG,
} from "@firegrid/substrate/descriptors"
import {
  DurableWaits,
  rebuildProjection,
  startRun,
} from "@firegrid/substrate/kernel"
import { Data, Effect, Layer, Schedule, Schema } from "effect"
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

const ContextEcho = Operation.define({
  name: "ContextEcho",
  input: Schema.Struct({ whenMs: Schema.Number }),
  output: Schema.Struct({
    workId: Schema.String,
    ownerId: Schema.String,
    scheduledCompletionId: Schema.String,
    scheduledWhenMs: Schema.Number,
  }),
})

const seedStartedRun = async (
  streamUrl: string,
  runId: string,
  operation: string,
  payload: unknown,
): Promise<void> => {
  const stream = await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  const event = Effect.runSync(startRun({
    runId,
    data: {
      _envelope: OPERATION_ENVELOPE_TAG,
      operation,
      payload,
    },
  }))
  await stream.append(JSON.stringify(event))
}

const seedEchoRun = (
  streamUrl: string,
  runId: string,
  payload: { readonly msg: string },
) => seedStartedRun(streamUrl, runId, Echo.name, payload)

const seedContextRun = (
  streamUrl: string,
  runId: string,
  payload: { readonly whenMs: number },
) => seedStartedRun(streamUrl, runId, ContextEcho.name, payload)

const fakeChoreographyLayer = Layer.succeed(Choreography, {
  sleep: () => Effect.interrupt,
  waitFor: () => Effect.interrupt,
  scheduleAt: (input) =>
    Effect.succeed({
      completionId: CompletionId("completion-from-server-dependency"),
      whenMs: typeof input.at === "number" ? input.at : input.at.getTime(),
    }),
  awaitAwakeable: () => Effect.interrupt,
} satisfies ChoreographyService)

const fakeDurableWaitsLayer = Layer.succeed(DurableWaits, {
  sleep: () =>
    Effect.succeed({
      completionId: "unused-sleep",
      kind: "timer",
      state: "pending",
    }),
  waitFor: () =>
    Effect.succeed({
      completionId: "unused-wait-for",
      kind: "projection_match",
      state: "pending",
    }),
  scheduleWork: () =>
    Effect.succeed({
      completionId: "unused-scheduled-work",
      kind: "scheduled_work",
      state: "pending",
    }),
  awakeable: () =>
    Effect.succeed({
      completionId: "unused-awakeable",
      key: "unused",
      kind: "externally_resolved_awakeable",
      state: "pending",
    }),
  awakeableGlobal: () =>
    Effect.succeed({
      completionId: "unused-global-awakeable",
      key: "unused",
      kind: "externally_resolved_awakeable",
      state: "pending",
    }),
})

const completedRunFromProjection = (streamUrl: string, runId: string) =>
  Effect.tryPromise({
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
        try: () => seedEchoRun(streamUrl, runId, { msg: "hello" }),
        catch: (cause) => new SeedFailed({ cause }),
      })

      // Poll the projection until the handler-driven completion lands.
      const final = yield* completedRunFromProjection(streamUrl, runId)
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

  // choreography-facade.CURRENT_WORK_CONTEXT.1
  // choreography-facade.CURRENT_WORK_CONTEXT.2
  // choreography-facade.CURRENT_WORK_CONTEXT.5
  // firegrid-operation-messaging.RUNTIME_HANDLERS.1
  // firegrid-operation-messaging.RUNTIME_HANDLERS.2
  // firegrid-operation-messaging.RUNTIME_HANDLERS.3
  // firegrid-operation-messaging.RUNTIME_HANDLERS.4
  it("provides CurrentWorkContext from durable run identity while composing ordinary handler dependency layers", async () => {
    const handlerLayer = Firegrid.handler(ContextEcho, (input) =>
      Effect.gen(function* () {
        const ctx = yield* CurrentWorkContext
        const choreography = yield* Choreography
        const scheduled = yield* choreography.scheduleAt({
          at: input.whenMs,
          input: { workId: ctx.workId },
        })
        return {
          workId: ctx.workId,
          ownerId: ctx.ownerId,
          scheduledCompletionId: scheduled.completionId,
          scheduledWhenMs: scheduled.whenMs,
        }
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(fakeChoreographyLayer, fakeDurableWaitsLayer),
      ),
    )

    const runId = "run-context-1"
    const processId = "runtime-owner-context-test"

    const program = Effect.gen(function* () {
      const runtime = yield* FiregridRuntime
      const streamUrl = runtime.streamIdentity.streamUrl

      yield* Effect.tryPromise({
        try: () => seedContextRun(streamUrl, runId, { whenMs: 12345 }),
        catch: (cause) => new SeedFailed({ cause }),
      })

      return yield* completedRunFromProjection(streamUrl, runId)
    }).pipe(
      Effect.provide(
        FiregridRuntimeBoot.embeddedDev({
          processId,
          streamName: "firegrid-handler-context-test",
          runtime: handlerLayer,
        }),
      ),
    )

    const completedRun = await Effect.runPromise(Effect.scoped(program))
    expect(completedRun.state).toBe("completed")
    expect(completedRun.result).toEqual({
      workId: runId,
      ownerId: processId,
      scheduledCompletionId: "completion-from-server-dependency",
      scheduledWhenMs: 12345,
    })
  })
})
