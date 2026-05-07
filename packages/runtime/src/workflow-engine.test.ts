import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  Activity,
  DurableClock,
  DurableDeferred,
  Workflow,
} from "@effect/workflow"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  fireDueWorkflowClocks,
  layerDurableStreams,
  makeWorkflowStateStore,
  type WorkflowEngineDurableStateOptions,
} from "./workflows.js"

let server: DurableStreamTestServer | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!server) throw new Error("server not started")
  const streamUrl = `${server.url}/v1/stream/${name}-${crypto.randomUUID()}`
  await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  return streamUrl
}

const runWith = <A, E>(
  options: WorkflowEngineDurableStateOptions,
  workflowLayer: any,
  effect: Effect.Effect<A, E, any>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(workflowLayer),
        Effect.provide(layerDurableStreams(options)),
      ),
    ) as Effect.Effect<A, any, never>,
  ) as Promise<A>

const inspectStore = async <A>(
  streamUrl: string,
  inspect: (store: Awaited<Effect.Effect.Success<ReturnType<typeof makeWorkflowStateStore>>>) => A,
): Promise<A> => {
  const store = await Effect.runPromise(makeWorkflowStateStore({ streamUrl }))
  try {
    return inspect(store)
  } finally {
    await Effect.runPromise(store.close)
  }
}

describe("durable workflow engine", () => {
  it("workflow-engine-durable-state.VALIDATION.1 replays a completed activity from Durable Streams State", async () => {
    const streamUrl = await createStreamUrl("workflow-replay")
    let runs = 0
    const CountActivity = Activity.make({
      name: "count-once",
      success: Schema.Number,
      execute: Effect.sync(() => {
        runs += 1
        return 41
      }),
    })
    const CountWorkflow = Workflow.make({
      name: "count-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.Number,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = CountWorkflow.toLayer(() =>
      Effect.gen(function* () {
        const value = yield* CountActivity
        return value + 1
      }),
    )

    const first = await runWith(
      { streamUrl },
      workflowLayer,
      CountWorkflow.execute({ id: "same" }),
    )
    const second = await runWith(
      { streamUrl },
      workflowLayer,
      CountWorkflow.execute({ id: "same" }),
    )

    expect(first).toBe(42)
    expect(second).toBe(42)
    expect(runs).toBe(1)
  })

  it("workflow-engine-durable-state.VALIDATION.2 resolves a suspended workflow through a DurableDeferred token", async () => {
    const streamUrl = await createStreamUrl("workflow-deferred")
    const Approval = DurableDeferred.make("approval", {
      success: Schema.String,
    })
    let token: DurableDeferred.Token | undefined
    const ApprovalWorkflow = Workflow.make({
      name: "approval-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = ApprovalWorkflow.toLayer(() =>
      Effect.gen(function* () {
        token = yield* DurableDeferred.token(Approval)
        return yield* DurableDeferred.await(Approval)
      }),
    )

    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        ApprovalWorkflow.execute({ id: "needs-human" }),
      )
      while (!token) yield* Effect.sleep(Duration.millis(1))
      yield* DurableDeferred.succeed(Approval, {
        token,
        value: "approved",
      })
      return yield* Fiber.join(fiber)
    })
    const result = await runWith({ streamUrl }, workflowLayer, program)

    expect(result).toBe("approved")
  })

  it("workflow-engine-durable-state.VALIDATION.3 persists a workflow DurableClock wakeup and fires it after engine reconstruction", async () => {
    const streamUrl = await createStreamUrl("workflow-clock")
    const ClockWorkflow = Workflow.make({
      name: "clock-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = ClockWorkflow.toLayer(() =>
      Effect.gen(function* () {
        yield* DurableClock.sleep({
          name: "wake",
          duration: Duration.millis(2),
          inMemoryThreshold: Duration.zero,
        })
        return "awake"
      }),
    )

    await runWith(
      { streamUrl },
      workflowLayer,
      ClockWorkflow.execute({ id: "sleepy" }, { discard: true }),
    )
    expect(await inspectStore(streamUrl, store => store.pendingClockWakeups())).toHaveLength(1)

    const result = await runWith(
      { streamUrl },
      workflowLayer,
      Effect.gen(function* () {
        yield* fireDueWorkflowClocks(Date.now() + 10_000)
        return yield* ClockWorkflow.execute({ id: "sleepy" })
      }),
    )

    expect(result).toBe("awake")
  })

  it("workflow-engine-durable-state.VALIDATION.4 round-trips workflow, activity, and deferred values through upstream schemas", async () => {
    const streamUrl = await createStreamUrl("workflow-schema-roundtrip")
    const ActivityDate = new Date("2026-05-07T12:00:00.000Z")
    const DeferredDate = new Date("2026-05-08T12:00:00.000Z")
    const Approval = DurableDeferred.make("typed-approval", {
      success: Schema.DateFromString,
    })
    let token: DurableDeferred.Token | undefined
    let activityRuns = 0
    const TypedActivity = Activity.make({
      name: "typed-activity",
      success: Schema.DateFromString,
      execute: Effect.sync(() => {
        activityRuns += 1
        return ActivityDate
      }),
    })
    const TypedWorkflow = Workflow.make({
      name: "typed-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.DateFromString,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = TypedWorkflow.toLayer(() =>
      Effect.gen(function* () {
        const activityDate = yield* TypedActivity
        token = yield* DurableDeferred.token(Approval)
        const deferredDate = yield* DurableDeferred.await(Approval)
        return new Date(Math.max(activityDate.getTime(), deferredDate.getTime()))
      }),
    )

    await runWith(
      { streamUrl },
      workflowLayer,
      TypedWorkflow.execute({ id: "typed" }, { discard: true }),
    )

    const completed = await runWith(
      { streamUrl },
      workflowLayer,
      Effect.gen(function* () {
        if (!token) throw new Error("expected deferred token")
        yield* DurableDeferred.succeed(Approval, {
          token,
          value: DeferredDate,
        })
        return yield* TypedWorkflow.execute({ id: "typed" })
      }),
    )

    const replayedFinal = await runWith(
      { streamUrl },
      workflowLayer,
      TypedWorkflow.execute({ id: "typed" }),
    )

    expect(completed).toBeInstanceOf(Date)
    expect(completed.toISOString()).toBe(DeferredDate.toISOString())
    expect(replayedFinal).toBeInstanceOf(Date)
    expect(replayedFinal.toISOString()).toBe(DeferredDate.toISOString())
    expect(activityRuns).toBe(1)
  })

  it("workflow-engine-durable-state.VALIDATION.5 waits for workflow registration before resuming persisted executions", async () => {
    const streamUrl = await createStreamUrl("workflow-registration")
    const ClockWorkflow = Workflow.make({
      name: "registration-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = ClockWorkflow.toLayer(() =>
      Effect.gen(function* () {
        yield* DurableClock.sleep({
          name: "registration-wake",
          duration: Duration.millis(2),
          inMemoryThreshold: Duration.zero,
        })
        return "registered"
      }),
    )

    await runWith(
      { streamUrl },
      workflowLayer,
      ClockWorkflow.execute({ id: "registration" }, { discard: true }),
    )

    await runWith(
      { streamUrl },
      Layer.empty,
      ClockWorkflow.resume("registration"),
    )
    expect(await inspectStore(streamUrl, store => store.pendingClockWakeups())).toHaveLength(1)

    const result = await runWith(
      { streamUrl },
      workflowLayer,
      Effect.gen(function* () {
        yield* fireDueWorkflowClocks(Date.now() + 10_000)
        return yield* ClockWorkflow.execute({ id: "registration" })
      }),
    )

    expect(result).toBe("registered")
  })

  it("workflow-engine-durable-state.VALIDATION.6 claims a raced activity once across concurrent workers", async () => {
    const streamUrl = await createStreamUrl("workflow-activity-race")
    let activityRuns = 0
    const RaceActivity = Activity.make({
      name: "race-once",
      success: Schema.Number,
      execute: Effect.promise(async () => {
        activityRuns += 1
        await new Promise(resolve => setTimeout(resolve, 50))
        return 7
      }),
    })
    const RaceWorkflow = Workflow.make({
      name: "race-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.Number,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = RaceWorkflow.toLayer(() =>
      Effect.gen(function* () {
        return (yield* RaceActivity) + 1
      }),
    )

    const [resultA, resultB] = await Promise.all([
      runWith(
        { streamUrl, workerId: "worker-a" },
        workflowLayer,
        RaceWorkflow.execute({ id: "same" }),
      ),
      runWith(
        { streamUrl, workerId: "worker-b" },
        workflowLayer,
        RaceWorkflow.execute({ id: "same" }),
      ),
    ])

    const claims = await inspectStore(streamUrl, store => store.activityClaims())

    expect(resultA).toBe(8)
    expect(resultB).toBe(8)
    expect(activityRuns).toBe(1)
    expect(claims).toHaveLength(1)
    expect(claims[0]?.claimKey).toContain("/race-once/")
  })
})
