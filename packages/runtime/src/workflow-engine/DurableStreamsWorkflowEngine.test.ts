import {
  Activity,
  DurableClock,
  DurableDeferred,
  Workflow,
} from "@effect/workflow"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DurableStreamsWorkflowEngine,
  type WorkflowEngineDurableStateOptions,
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "./DurableStreamsWorkflowEngine.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const runWithLayer = <A, E>(
  engineLayer: Layer.Layer<never, unknown, unknown>,
  workflowLayer: unknown,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          (workflowLayer as Layer.Layer<never, unknown, unknown>).pipe(
            Layer.provideMerge(engineLayer),
          ),
        ),
      ),
    ) as Effect.Effect<A, unknown, never>,
  )

const runWith = <A, E>(
  options: WorkflowEngineDurableStateOptions,
  workflowLayer: unknown,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> => {
  const engineLayer = DurableStreamsWorkflowEngine.layer(options) as Layer.Layer<never, unknown, unknown>
  return runWithLayer(engineLayer, workflowLayer, effect)
}

const inspectTable = async <A>(
  streamUrl: string,
  inspect: (table: WorkflowEngineTableService) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // workflow-engine-durable-state.VALIDATION.8
        const table = yield* WorkflowEngineTable
        return yield* inspect(table)
      }).pipe(
        Effect.provide(WorkflowEngineTable.layer({
          streamOptions: {
            url: streamUrl,
            contentType: "application/json",
          },
        })),
      ),
    ),
  )

describe("durable workflow engine", () => {
  it("firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.1 lets subscriber-like work run on the Durable Streams workflow engine", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/subscriber-workflow-engine-${crypto.randomUUID()}`
    const HandleInboundActivity = Activity.make({
      name: "handle-inbound",
      success: Schema.Struct({ accepted: Schema.Boolean }),
      execute: Effect.succeed({ accepted: true }),
    })
    const InboundWorkflow = Workflow.make({
      name: "inbound-subscriber-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.Struct({ accepted: Schema.Boolean }),
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = InboundWorkflow.toLayer(() => HandleInboundActivity)

    const result = await runWith(
      { streamUrl },
      workflowLayer,
      InboundWorkflow.execute({ id: "delivery-1" }),
    )

    expect(result).toEqual({ accepted: true })
  })

  it("firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.2 and firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.4 keep subscriber intent in caller-declared Workflow and Activity constructs", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/subscriber-workflow-intent-${crypto.randomUUID()}`
    const CallerPayload = Schema.Struct({
      id: Schema.String,
      providerKind: Schema.Literal("example-provider"),
      value: Schema.Number,
    })
    const CallerResult = Schema.Struct({
      providerKind: Schema.Literal("example-provider"),
      doubled: Schema.Number,
    })
    const CallerActivity = Activity.make({
      name: "caller-owned-activity",
      success: CallerResult,
      execute: Effect.succeed({
        providerKind: "example-provider" as const,
        doubled: 42,
      }),
    })
    const CallerWorkflow = Workflow.make({
      name: "caller-owned-workflow",
      payload: CallerPayload,
      success: CallerResult,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = CallerWorkflow.toLayer(() => CallerActivity)

    const result = await runWith(
      { streamUrl },
      workflowLayer,
      CallerWorkflow.execute({
        id: "intent-1",
        providerKind: "example-provider",
        value: 21,
      }),
    )

    expect(result).toEqual({
      providerKind: "example-provider",
      doubled: 42,
    })
  })

  it("firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.3 suppresses duplicate subscriber-like work with workflow idempotency and activity replay", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/subscriber-workflow-idempotency-${crypto.randomUUID()}`
    let activityRuns = 0
    const IdempotentActivity = Activity.make({
      name: "subscriber-idempotent-activity",
      success: Schema.Number,
      execute: Effect.sync(() => {
        activityRuns += 1
        return 11
      }),
    })
    const IdempotentWorkflow = Workflow.make({
      name: "subscriber-idempotent-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.Number,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = IdempotentWorkflow.toLayer(() => IdempotentActivity)

    const first = await runWith(
      { streamUrl },
      workflowLayer,
      IdempotentWorkflow.execute({ id: "same" }),
    )
    const second = await runWith(
      { streamUrl },
      workflowLayer,
      IdempotentWorkflow.execute({ id: "same" }),
    )

    expect(first).toBe(11)
    expect(second).toBe(11)
    expect(activityRuns).toBe(1)
  })

  it("firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.6 and firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.7 use only caller-selected stream URLs for partitions", async () => {
    if (!baseUrl) throw new Error("server not started")
    const firstStreamUrl = `${baseUrl}/v1/stream/subscriber-partition-a-${crypto.randomUUID()}`
    const secondStreamUrl = `${baseUrl}/v1/stream/subscriber-partition-b-${crypto.randomUUID()}`
    let activityRuns = 0
    const PartitionActivity = Activity.make({
      name: "partitioned-subscriber-activity",
      success: Schema.String,
      execute: Effect.sync(() => {
        activityRuns += 1
        return "handled"
      }),
    })
    const PartitionWorkflow = Workflow.make({
      name: "partitioned-subscriber-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = PartitionWorkflow.toLayer(() => PartitionActivity)

    const first = await runWith(
      { streamUrl: firstStreamUrl },
      workflowLayer,
      PartitionWorkflow.execute({ id: "same-id" }),
    )
    const second = await runWith(
      { streamUrl: secondStreamUrl },
      workflowLayer,
      PartitionWorkflow.execute({ id: "same-id" }),
    )

    expect(first).toBe("handled")
    expect(second).toBe("handled")
    expect(activityRuns).toBe(2)
  })

  it("workflow-engine-durable-state.ENGINE.4 exposes a ClusterWorkflowEngine-shaped layer installer", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/workflow-layer-shape-${crypto.randomUUID()}`
    let runs = 0
    const ShapeActivity = Activity.make({
      name: "shape-activity",
      success: Schema.Number,
      execute: Effect.sync(() => {
        runs += 1
        return 1
      }),
    })
    const ShapeWorkflow = Workflow.make({
      name: "shape-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.Number,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = ShapeWorkflow.toLayer(() => ShapeActivity)

    const first = await runWith(
      { streamUrl },
      workflowLayer,
      ShapeWorkflow.execute({ id: "same" }),
    )
    const second = await runWithLayer(
      DurableStreamsWorkflowEngine.layer({ streamUrl }) as Layer.Layer<never, unknown, unknown>,
      workflowLayer,
      ShapeWorkflow.execute({ id: "same" }),
    )

    expect(first).toBe(1)
    expect(second).toBe(1)
    expect(runs).toBe(1)
  })

  it("workflow-engine-durable-state.VALIDATION.1 and firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.5 replays a completed activity from Durable Streams State", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/workflow-replay-${crypto.randomUUID()}`
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

  it("workflow-engine-durable-state.VALIDATION.2 and firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.5 resolves a suspended workflow through a DurableDeferred token", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/workflow-deferred-${crypto.randomUUID()}`
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

  it("workflow-engine-durable-state.VALIDATION.3 and firegrid-durable-subscriber-webhooks.RUNTIME_VERTICAL.5 persists a workflow DurableClock wakeup and fires it after engine reconstruction without an external clock driver", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/workflow-clock-${crypto.randomUUID()}`
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
          duration: Duration.millis(200),
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
    expect(await inspectTable(streamUrl, table =>
      table.clockWakeups.query((coll) =>
        coll.toArray.filter(row => row.status === "pending"),
      ),
    )).toHaveLength(1)

    await Effect.runPromise(Effect.sleep(Duration.millis(250)))

    const result = await runWith(
      { streamUrl },
      workflowLayer,
      ClockWorkflow.execute({ id: "sleepy" }),
    )

    expect(result).toBe("awake")
  })

  it("workflow-engine-durable-state.VALIDATION.4 round-trips workflow, activity, and deferred values through upstream schemas", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/workflow-schema-roundtrip-${crypto.randomUUID()}`
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
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/workflow-registration-${crypto.randomUUID()}`
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
          duration: Duration.millis(200),
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
    expect(await inspectTable(streamUrl, table =>
      table.clockWakeups.query((coll) =>
        coll.toArray.filter(row => row.status === "pending"),
      ),
    )).toHaveLength(1)

    await Effect.runPromise(Effect.sleep(Duration.millis(250)))

    const result = await runWith(
      { streamUrl },
      workflowLayer,
      ClockWorkflow.execute({ id: "registration" }),
    )

    expect(result).toBe("registered")
  })

  it("workflow-engine-durable-state.VALIDATION.6 firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.1 firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.2 firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.3 claims a raced activity once across concurrent workers", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/workflow-activity-race-${crypto.randomUUID()}`
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

    const claims = await inspectTable(streamUrl, table =>
      table.activityClaims.query((coll) => coll.toArray),
    )

    expect(resultA).toBe(8)
    expect(resultB).toBe(8)
    expect(activityRuns).toBe(1)
    expect(claims).toHaveLength(1)
    expect(claims[0]?.claimKey).toContain("/race-once/")
    expect(["worker-a", "worker-b"]).toContain(claims[0]?.workerId)
  })
})
