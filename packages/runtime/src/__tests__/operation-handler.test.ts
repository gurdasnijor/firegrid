import { DurableStream } from "@durable-streams/client"
import {
  Choreography,
  ChoreographyLive,
  ChoreographyTrigger,
  CompletionId,
  CurrentWorkContext,
  triggerMatchersLayer,
  type ChoreographyService,
  type TriggerMatcher,
} from "@firegrid/substrate"
import {
  Operation,
  OPERATION_ENVELOPE_TAG,
} from "@firegrid/substrate/descriptors"
import {
  DurableWaits,
  DurableWaitsLive,
  rebuildProjection,
  startRun,
  substrateState,
} from "@firegrid/substrate/kernel"
import { Data, Effect, Layer, Schedule, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"
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
// Layer to FiregridRuntimeBoot.attached, manually seed a
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

const WaitForPermission = Operation.define({
  name: "WaitForPermission",
  input: Schema.Struct({
    permissionId: Schema.String,
    trigger: ChoreographyTrigger,
  }),
  output: Schema.Struct({
    permissionId: Schema.String,
    status: Schema.Literal("approved"),
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

// firegrid-runtime-process.READY_WORK_OPERATOR.{1,2,5}
// Seed a run already at state=blocked plus its resolved completion so
// the runtime's ready-work operator loop observes a ready item on the
// first scan-after-wake. The events are constructed directly from the
// substrate state helpers (insert events) rather than the state-
// machine transition builders so this seed does not add Effect runner
// calls to the test file. Pre-seeding bypasses the started-run
// dispatch path (state=blocked at insert time, never observed as
// `state="started"` by the dispatch loop) which is exactly the
// scenario the ready-work loop is designed for: a run that the
// process did not start in this lifetime, observed only after a
// completion resolved.
const seedBlockedEchoRun = async (
  streamUrl: string,
  runId: string,
  completionId: string,
  payload: { readonly msg: string },
): Promise<void> => {
  const startedData = {
    _envelope: OPERATION_ENVELOPE_TAG,
    operation: Echo.name,
    payload,
  }
  const blockedRunEvent = substrateState.runs.insert({
    value: {
      runId,
      state: "blocked",
      data: startedData,
      blockedOnCompletionId: completionId,
    },
  })
  const resolvedCompletionEvent = substrateState.completions.insert({
    value: {
      completionId,
      kind: "externally_resolved_awakeable",
      state: "resolved",
      result: { ack: true },
    },
  })
  const stream = await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  await stream.append(JSON.stringify(blockedRunEvent))
  await stream.append(JSON.stringify(resolvedCompletionEvent))
}

const seedBlockedWaitForRun = async (
  streamUrl: string,
  runId: string,
  completionId: string,
  payload: {
    readonly permissionId: string
    readonly trigger: ChoreographyTrigger
  },
): Promise<void> => {
  const startedData = {
    _envelope: OPERATION_ENVELOPE_TAG,
    operation: WaitForPermission.name,
    payload,
  }
  const blockedRunEvent = substrateState.runs.insert({
    value: {
      runId,
      state: "blocked",
      data: startedData,
      blockedOnCompletionId: completionId,
    },
  })
  const resolvedCompletionEvent = substrateState.completions.insert({
    value: {
      completionId,
      workId: runId,
      kind: "projection_match",
      state: "resolved",
      data: { trigger: payload.trigger },
      result: { matchedValue: { permissionId: payload.permissionId } },
    },
  })
  const stream = await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  await stream.append(JSON.stringify(blockedRunEvent))
  await stream.append(JSON.stringify(resolvedCompletionEvent))
}

const seedContextRun = (
  streamUrl: string,
  runId: string,
  payload: { readonly whenMs: number },
) => seedStartedRun(streamUrl, runId, ContextEcho.name, payload)

const createRuntimeStream = async (name: string): Promise<string> => {
  const streamUrl = freshStreamUrl(name)
  await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  return streamUrl
}

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

const permissionMatcher: TriggerMatcher = () =>
  Effect.succeed({ kind: "match", value: { status: "approved" } })

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
  beforeAll(async () => {
    await startTestServer()
  })

  afterAll(async () => {
    await stopTestServer()
  })

  // firegrid-operation-messaging.RUNTIME_HANDLERS.1
  // firegrid-operation-messaging.RUNTIME_HANDLERS.4
  // firegrid-runtime-process.RUNTIME_HOT_PATH.1
  // firegrid-runtime-process.READY_WORK_OPERATOR.1
  // firegrid-runtime-process.READY_WORK_OPERATOR.2
  // firegrid-runtime-process.READY_WORK_OPERATOR.5
  // firegrid-runtime-process.READY_WORK_OPERATOR.7
  // claim-and-operator-authority.OPERATOR_INVOCATION.16
  // ready-work-projection.READY_WORK_PROJECTION.11
  //
  // One `Firegrid.handler` registration installs BOTH durable-execution
  // entrypoints for the operation under a single Layer: the started-run
  // dispatch loop terminalizes a freshly-declared run, and the
  // ready-work operator loop resumes a run that was already blocked on
  // a now-resolved completion at process start. The blocked-run seed
  // is appended on the durable stream BEFORE attaching the runtime so
  // the dispatch loop never observes a `state="started"` row for the
  // resume scenario; the runtime sees the run only via the ready-work
  // projection on its first scan.
  it("encodes the handler's output and terminalizes started runs as well as resumed blocked runs", async () => {
    const handlerLayer = Firegrid.handler(Echo, (input) =>
      Effect.succeed({ msg: input.msg, len: input.msg.length }),
    )

    const startedRunId = "run-echo-1"
    const blockedRunId = "ready-work-run-1"
    const completionId = "awk:test:ready-work-1"
    const streamUrl = await createRuntimeStream("firegrid-handler-test")

    // Pre-seed the blocked run + resolved completion before attaching
    // the runtime. The events are plain insert change-events (no
    // Effect transitions), so this seed does not add Effect runner
    // calls to the test file.
    await seedBlockedEchoRun(
      streamUrl,
      blockedRunId,
      completionId,
      { msg: "resume" },
    )

    const program = Effect.gen(function* () {
      const runtime = yield* FiregridRuntime
      expect(runtime.bootMode).toBe("attached")
      expect(runtime.streamIdentity.streamUrl).toBe(streamUrl)

      yield* Effect.tryPromise({
        try: () => seedEchoRun(streamUrl, startedRunId, { msg: "hello" }),
        catch: (cause) => new SeedFailed({ cause }),
      })

      const started = yield* completedRunFromProjection(
        streamUrl,
        startedRunId,
      )
      const resumed = yield* completedRunFromProjection(
        streamUrl,
        blockedRunId,
      )
      return { started, resumed } as const
    }).pipe(
      Effect.provide(
        FiregridRuntimeBoot.attached({
          streamUrl,
          runtime: handlerLayer,
        }),
      ),
    )

    const { started, resumed } = await Effect.runPromise(
      Effect.scoped(program),
    )
    expect(started.state).toBe("completed")
    expect(started.result).toEqual({ msg: "hello", len: 5 })
    expect(resumed.state).toBe("completed")
    expect(resumed.result).toEqual({ msg: "resume", len: 6 })
  })

  // firegrid-runtime-process.READY_WORK_OPERATOR.5
  // choreography-facade.CHOREOGRAPHY_API.9
  // durable-waits-and-scheduling.WAIT_FOR.8
  it("ready-work resume re-enters waitFor and terminalizes when the blocked projection-match completion is already resolved", async () => {
    const streamUrl = await createRuntimeStream(
      "firegrid-handler-waitfor-resume-test",
    )
    const runId = "ready-work-waitfor-run-1"
    const completionId = "completion-waitfor-resolved-1"
    const trigger: ChoreographyTrigger = {
      _tag: "ProjectionMatch",
      label: "permission-approved:permission-runtime-1",
      projectionKey: "PermissionEvents:permission:permission-runtime-1",
      matcherId: "scenario.permission.approved",
    }
    await seedBlockedWaitForRun(streamUrl, runId, completionId, {
      permissionId: "permission-runtime-1",
      trigger,
    })

    const handlerLayer = Firegrid.handler(WaitForPermission, (input) =>
      Effect.gen(function* () {
        const choreo = yield* Choreography
        yield* choreo.waitFor(input.trigger)
        return {
          permissionId: input.permissionId,
          status: "approved" as const,
        }
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          ChoreographyLive({ streamUrl }),
          DurableWaitsLive({ streamUrl }),
          triggerMatchersLayer({
            "scenario.permission.approved": permissionMatcher,
          }),
        ),
      ),
    )

    const completed = await Effect.gen(function* () {
      return yield* completedRunFromProjection(streamUrl, runId)
    }).pipe(
      Effect.provide(
        FiregridRuntimeBoot.attached({
          streamUrl,
          runtime: handlerLayer,
        }),
      ),
      Effect.scoped,
      Effect.runPromise,
    )

    expect(completed.state).toBe("completed")
    expect(completed.result).toEqual({
      permissionId: "permission-runtime-1",
      status: "approved",
    })

    const projectionMatchCompletions = Array.from(
      (await rebuildProjection({ url: streamUrl })).completions.values(),
    ).filter((completion) => completion.kind === "projection_match")
    expect(projectionMatchCompletions).toHaveLength(1)
    expect(projectionMatchCompletions[0]?.completionId).toBe(completionId)
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
    const streamUrl = await createRuntimeStream(
      "firegrid-handler-context-test",
    )

    const program = Effect.gen(function* () {
      const runtime = yield* FiregridRuntime
      expect(runtime.bootMode).toBe("attached")
      expect(runtime.streamIdentity.streamUrl).toBe(streamUrl)

      yield* Effect.tryPromise({
        try: () => seedContextRun(streamUrl, runId, { whenMs: 12345 }),
        catch: (cause) => new SeedFailed({ cause }),
      })

      return yield* completedRunFromProjection(streamUrl, runId)
    }).pipe(
      Effect.provide(
        FiregridRuntimeBoot.attached({
          processId,
          streamUrl,
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
