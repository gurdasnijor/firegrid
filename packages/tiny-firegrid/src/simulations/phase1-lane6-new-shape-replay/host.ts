import { durableStreamUrl } from "@firegrid/protocol/launch"
import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import { CallerOwnedFactStreams } from "@firegrid/runtime/channels/observation-streams"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
  type WorkflowActivityClaimRow,
  type WorkflowActivityRow,
  type WorkflowClockWakeupRow,
  type WorkflowDeferredRow,
  type WorkflowExecutionRow,
} from "@firegrid/runtime/workflow-engine"
import { Cause, Clock, Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  WaitForWorkflow,
  WaitForWorkflowLayer,
  type WaitForWorkflowOutcome,
} from "../inv2-waitforworkflow/wait-for-workflow.ts"

const factStream = "phase1-lane6.new-shape-replay.facts"
const eventType = "phase1.lane6.match"
const stableWorkerId = "phase1-lane6-new-shape-replay-worker"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  scenario: Schema.String,
  eventType: Schema.String,
  value: Schema.String,
  acceptedAtMs: Schema.Number,
})

type FactRow = Schema.Schema.Type<typeof FactRowSchema>

interface ScenarioVerdict {
  readonly scenario: string
  readonly executionId: string
  readonly generation1WorkerId: string
  readonly generation2WorkerId: string
  readonly replayCompleted: boolean
  readonly outcome?: "Match" | "Timeout"
  readonly value?: string
  readonly failureMessage?: string
  readonly activityClaimWorkerId: string
  readonly activityResultWritten: boolean
  readonly raceDeferredWritten: boolean
  readonly timeoutClockDeadlinePreserved?: boolean
}

interface ProbeResult {
  readonly alreadyWrittenAfterRestart: ScenarioVerdict
  readonly liveAfterRestart: ScenarioVerdict
  readonly timeoutAfterRestart: ScenarioVerdict
}

class Phase1Lane6FactTable extends DurableTable("phase1Lane6NewShapeFacts", {
  facts: FactRowSchema,
}) {}

interface Streams {
  readonly workflow: string
  readonly facts: string
}

interface Gen1Suspension {
  readonly executionId: string
  readonly activityClaim: WorkflowActivityClaimRow
  readonly clockWakeup: WorkflowClockWakeupRow
}

/* eslint-disable local/no-module-durable-cache -- simulation-local host/driver handshake; all replay state under test lives in Durable Streams. */
let resolveResult: (result: ProbeResult) => void
let rejectResult: (error: unknown) => void

export const phase1Lane6ReplayResult = new Promise<ProbeResult>(
  (resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  },
)
/* eslint-enable local/no-module-durable-cache */

const tableOptions = (streamUrl: string): DurableTableLayerOptions => ({
  streamOptions: {
    url: streamUrl,
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const factLayer = (streams: Streams) =>
  Phase1Lane6FactTable.layer(tableOptions(streams.facts))

const callerFactsLayer = (streams: Streams) =>
  Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(Phase1Lane6FactTable, (table) => ({
      streamFor: (stream: string) =>
        stream === factStream ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factLayer(streams)))

const workflowTableLayer = (streams: Streams) =>
  WorkflowEngineTable.layer(tableOptions(streams.workflow))

const generationLayer = (
  streams: Streams,
  _generation: 1 | 2,
): Layer.Layer<never, unknown, never> =>
  WaitForWorkflowLayer.pipe(
    Layer.provideMerge(callerFactsLayer(streams)),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: streams.workflow,
      workerId: stableWorkerId,
    }) as Layer.Layer<never, unknown, unknown>),
    Layer.provideMerge(factLayer(streams)),
  ) as Layer.Layer<never, unknown, never>

const withGeneration = <A, E>(
  streams: Streams,
  generation: 1 | 2,
  effect: Effect.Effect<A, E, unknown>,
): Effect.Effect<A, unknown, never> =>
  (Effect.scoped(
    effect.pipe(Effect.provide(generationLayer(streams, generation))),
  ).pipe(
    Effect.withSpan("firegrid.phase1.lane6.host_generation", {
      kind: "internal",
      attributes: {
        "firegrid.phase1.lane6.generation": generation,
        "firegrid.phase1.lane6.worker_id": stableWorkerId,
      },
    }),
  ) as Effect.Effect<A, unknown, never>)

const payloadFor = (
  scenario: string,
  timeoutMs: number,
) => ({
  executionKey: `phase1-lane6:${scenario}`,
  stream: factStream,
  whereFields: {
    scenario,
    eventType,
  },
  timeoutMs,
})

const activityNameFor = (scenario: string): string =>
  `wait-for-workflow.match/${payloadFor(scenario, 1).executionKey}`

const clockNameFor = (scenario: string): string =>
  `wait-for-workflow.timeout/${payloadFor(scenario, 1).executionKey}`

const raceDeferredNameFor = (scenario: string): string =>
  `raceAll/wait-for-workflow.race/${payloadFor(scenario, 1).executionKey}`

const factFor = (
  scenario: string,
  value: string,
): Effect.Effect<FactRow> =>
  Effect.map(Clock.currentTimeMillis, (acceptedAtMs) => ({
    factId: `${scenario}:${value}`,
    scenario,
    eventType,
    value,
    acceptedAtMs,
  }))

const upsertFact = (
  streams: Streams,
  row: FactRow,
): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const table = yield* Phase1Lane6FactTable
      yield* table.facts.upsert(row)
    }).pipe(Effect.provide(factLayer(streams))),
  )

const inspectExecutions = (
  streams: Streams,
): Effect.Effect<ReadonlyArray<WorkflowExecutionRow>, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const table = yield* WorkflowEngineTable
      return yield* table.executions.query((coll) => coll.toArray)
    }).pipe(Effect.provide(workflowTableLayer(streams))),
  )

const inspectActivityClaims = (
  streams: Streams,
): Effect.Effect<ReadonlyArray<WorkflowActivityClaimRow>, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const table = yield* WorkflowEngineTable
      return yield* table.activityClaims.query((coll) => coll.toArray)
    }).pipe(Effect.provide(workflowTableLayer(streams))),
  )

const inspectActivities = (
  streams: Streams,
): Effect.Effect<ReadonlyArray<WorkflowActivityRow>, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const table = yield* WorkflowEngineTable
      return yield* table.activities.query((coll) => coll.toArray)
    }).pipe(Effect.provide(workflowTableLayer(streams))),
  )

const inspectDeferreds = (
  streams: Streams,
): Effect.Effect<ReadonlyArray<WorkflowDeferredRow>, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const table = yield* WorkflowEngineTable
      return yield* table.deferreds.query((coll) => coll.toArray)
    }).pipe(Effect.provide(workflowTableLayer(streams))),
  )

const inspectClockWakeups = (
  streams: Streams,
): Effect.Effect<ReadonlyArray<WorkflowClockWakeupRow>, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const table = yield* WorkflowEngineTable
      return yield* table.clockWakeups.query((coll) => coll.toArray)
    }).pipe(Effect.provide(workflowTableLayer(streams))),
  )

const waitUntil = <A>(
  label: string,
  poll: Effect.Effect<A, unknown>,
  satisfied: (value: A) => boolean,
): Effect.Effect<A, unknown> =>
  /* eslint-disable local/no-fixed-polling -- bounded probe polling durable-table visibility while characterizing restart replay. */
  Effect.gen(function* () {
    const deadlineMs = (yield* Clock.currentTimeMillis) + 5_000
    let latest = yield* poll
    while (!satisfied(latest)) {
      if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
        return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
      }
      yield* Effect.sleep(Duration.millis(25))
      latest = yield* poll
    }
    return latest
  })
/* eslint-enable local/no-fixed-polling */

const findExecution = (
  rows: ReadonlyArray<WorkflowExecutionRow>,
  executionId: string,
): WorkflowExecutionRow | undefined =>
  rows.find((row) => row.executionId === executionId)

const findActivityClaim = (
  rows: ReadonlyArray<WorkflowActivityClaimRow>,
  executionId: string,
  scenario: string,
): WorkflowActivityClaimRow | undefined =>
  rows.find((row) =>
    row.executionId === executionId &&
    row.activityName === activityNameFor(scenario),
  )

const findClockWakeup = (
  rows: ReadonlyArray<WorkflowClockWakeupRow>,
  executionId: string,
  scenario: string,
): WorkflowClockWakeupRow | undefined =>
  rows.find((row) =>
    row.executionId === executionId &&
    row.clockName === clockNameFor(scenario),
  )

const waitForGen1Suspension = (
  streams: Streams,
  scenario: string,
  executionId: string,
): Effect.Effect<Gen1Suspension, unknown> =>
  Effect.gen(function* () {
    const claims = yield* waitUntil(
      `activity claim for ${scenario}`,
      inspectActivityClaims(streams),
      (rows) => findActivityClaim(rows, executionId, scenario) !== undefined,
    )
    const clocks = yield* waitUntil(
      `pending clock for ${scenario}`,
      inspectClockWakeups(streams),
      (rows) => findClockWakeup(rows, executionId, scenario)?.status === "pending",
    )
    return {
      executionId,
      activityClaim: findActivityClaim(claims, executionId, scenario)!,
      clockWakeup: findClockWakeup(clocks, executionId, scenario)!,
    }
  })

const startAndBounceGen1 = (
  streams: Streams,
  scenario: string,
  timeoutMs: number,
): Effect.Effect<Gen1Suspension, unknown> =>
  Effect.gen(function* () {
    const payload = payloadFor(scenario, timeoutMs)
    const executionId = yield* WaitForWorkflow.executionId(payload)
    return yield* withGeneration(
      streams,
      1,
      Effect.gen(function* () {
        yield* WaitForWorkflow.execute(payload).pipe(Effect.forkDaemon)
        const suspended = yield* waitForGen1Suspension(
          streams,
          scenario,
          executionId,
        )
        return suspended
      }),
    )
  }).pipe(
    Effect.withSpan("firegrid.phase1.lane6.start_and_bounce_gen1", {
      kind: "internal",
      attributes: {
        "firegrid.phase1.lane6.scenario": scenario,
      },
    }),
  )

const completeMatchInGen2 = (
  streams: Streams,
  scenario: string,
  timeoutMs: number,
  rowTiming: "before-gen2" | "after-gen2",
): Effect.Effect<ScenarioVerdict, unknown> =>
  Effect.gen(function* () {
    const payload = payloadFor(scenario, timeoutMs)
    const executionId = yield* WaitForWorkflow.executionId(payload)
    const gen1 = yield* startAndBounceGen1(streams, scenario, timeoutMs)
    const row = yield* factFor(scenario, `matched-${rowTiming}`)
    if (rowTiming === "before-gen2") {
      yield* upsertFact(streams, row)
    }
    const outcomeExit = yield* withGeneration(
      streams,
      2,
      Effect.gen(function* () {
        const fiber = yield* WaitForWorkflow.execute(payload).pipe(Effect.fork)
        if (rowTiming === "after-gen2") {
          yield* Effect.sleep(Duration.millis(100))
          yield* upsertFact(streams, row)
        }
        return yield* Fiber.join(fiber).pipe(
          Effect.timeoutFail({
            duration: "5 seconds",
            onTimeout: () =>
              new Error(`timed out waiting for gen2 match ${scenario}`),
          }),
          Effect.exit,
        )
      }),
    )
    const finalExecution = findExecution(yield* inspectExecutions(streams), executionId)
    const activities = yield* inspectActivities(streams)
    const deferreds = yield* inspectDeferreds(streams)
    const value = Exit.isSuccess(outcomeExit)
      ? matchValue(outcomeExit.value)
      : undefined
    const replayCompleted = Exit.isSuccess(outcomeExit) &&
      outcomeExit.value._tag === "Match" &&
      value === row.value &&
      finalExecution?.executionId === executionId
    const verdict: ScenarioVerdict = {
      scenario,
      executionId,
      generation1WorkerId: stableWorkerId,
      generation2WorkerId: stableWorkerId,
      replayCompleted,
      ...(Exit.isSuccess(outcomeExit)
        ? { outcome: outcomeExit.value._tag }
        : { failureMessage: Cause.pretty(outcomeExit.cause) }),
      activityClaimWorkerId: gen1.activityClaim.workerId,
      activityResultWritten: activities.some((activity) =>
        activity.executionId === executionId &&
        activity.activityName === activityNameFor(scenario),
      ),
      raceDeferredWritten: deferreds.some((deferred) =>
        deferred.executionId === executionId &&
        deferred.deferredName === raceDeferredNameFor(scenario),
      ),
    }
    return value === undefined ? verdict : { ...verdict, value }
  }).pipe(
    Effect.withSpan("firegrid.phase1.lane6.match_after_restart", {
      kind: "internal",
      attributes: {
        "firegrid.phase1.lane6.scenario": scenario,
        "firegrid.phase1.lane6.row_timing": rowTiming,
      },
    }),
  )

const runTimeoutAfterRestart = (
  streams: Streams,
): Effect.Effect<ScenarioVerdict, unknown> =>
  Effect.gen(function* () {
    const scenario = "timeout-after-restart"
    const timeoutMs = 350
    const payload = payloadFor(scenario, timeoutMs)
    const executionId = yield* WaitForWorkflow.executionId(payload)
    const gen1 = yield* startAndBounceGen1(streams, scenario, timeoutMs)
    const nowMs = yield* Clock.currentTimeMillis
    yield* Effect.sleep(
      Duration.millis(Math.max(0, gen1.clockWakeup.deadlineMs - nowMs + 75)),
    )
    const outcomeExit = yield* withGeneration(
      streams,
      2,
      WaitForWorkflow.execute(payload).pipe(
        Effect.timeoutFail({
          duration: "5 seconds",
          onTimeout: () =>
            new Error(`timed out waiting for gen2 timeout ${scenario}`),
        }),
        Effect.exit,
      ),
    )
    const finalExecution = findExecution(yield* inspectExecutions(streams), executionId)
    const activities = yield* inspectActivities(streams)
    const deferreds = yield* inspectDeferreds(streams)
    const gen2Clock = findClockWakeup(
      yield* inspectClockWakeups(streams),
      executionId,
      scenario,
    )
    return {
      scenario,
      executionId,
      generation1WorkerId: stableWorkerId,
      generation2WorkerId: stableWorkerId,
      replayCompleted: Exit.isSuccess(outcomeExit) &&
        outcomeExit.value._tag === "Timeout" &&
        finalExecution?.executionId === executionId,
      ...(Exit.isSuccess(outcomeExit)
        ? { outcome: outcomeExit.value._tag }
        : { failureMessage: Cause.pretty(outcomeExit.cause) }),
      activityClaimWorkerId: gen1.activityClaim.workerId,
      activityResultWritten: activities.some((activity) =>
        activity.executionId === executionId &&
        activity.activityName === activityNameFor(scenario),
      ),
      raceDeferredWritten: deferreds.some((deferred) =>
        deferred.executionId === executionId &&
        deferred.deferredName === raceDeferredNameFor(scenario),
      ),
      timeoutClockDeadlinePreserved:
        gen2Clock?.deadlineMs === gen1.clockWakeup.deadlineMs,
    }
  }).pipe(
    Effect.withSpan("firegrid.phase1.lane6.timeout_after_restart", {
      kind: "internal",
    }),
  )

const matchValue = (
  outcome: WaitForWorkflowOutcome,
): string | undefined => {
  if (outcome._tag !== "Match") return undefined
  const raw = outcome.raw
  return typeof raw === "object" && raw !== null && "value" in raw &&
    typeof raw.value === "string"
    ? raw.value
    : undefined
}

const assertScenarioGreen = (
  verdict: ScenarioVerdict,
  expected: {
    readonly outcome: "Match" | "Timeout"
    readonly value?: string
    readonly deadlinePreserved?: true
  },
): Effect.Effect<void, Error> => {
  if (!verdict.replayCompleted) {
    return Effect.fail(
      new Error(
        `${verdict.scenario} did not complete replay: ${verdict.failureMessage ?? "no failure message"}`,
      ),
    )
  }
  if (verdict.outcome !== expected.outcome) {
    return Effect.fail(
      new Error(
        `${verdict.scenario} outcome ${verdict.outcome ?? "missing"} !== ${expected.outcome}`,
      ),
    )
  }
  if (expected.value !== undefined && verdict.value !== expected.value) {
    return Effect.fail(
      new Error(
        `${verdict.scenario} value ${verdict.value ?? "missing"} !== ${expected.value}`,
      ),
    )
  }
  if (expected.deadlinePreserved === true && verdict.timeoutClockDeadlinePreserved !== true) {
    return Effect.fail(
      new Error(`${verdict.scenario} did not preserve timeout clock deadline`),
    )
  }
  return Effect.void
}

const assertProbeGreen = (
  result: ProbeResult,
): Effect.Effect<ProbeResult, Error> =>
  Effect.all([
    assertScenarioGreen(result.alreadyWrittenAfterRestart, {
      outcome: "Match",
      value: "matched-before-gen2",
    }),
    assertScenarioGreen(result.liveAfterRestart, {
      outcome: "Match",
      value: "matched-after-gen2",
    }),
    assertScenarioGreen(result.timeoutAfterRestart, {
      outcome: "Timeout",
      deadlinePreserved: true,
    }),
  ]).pipe(Effect.as(result))

const runProbe = (
  env: TinyFiregridHostEnv,
): Effect.Effect<ProbeResult, unknown> => {
  const streamPrefix = `${env.namespace}.${env.runId}.phase1Lane6NewShapeReplay`
  const streams: Streams = {
    workflow: durableStreamUrl(env.durableStreamsBaseUrl, `${streamPrefix}.workflow`),
    facts: durableStreamUrl(env.durableStreamsBaseUrl, `${streamPrefix}.facts`),
  }
  return Effect.gen(function* () {
    const alreadyWrittenAfterRestart = yield* completeMatchInGen2(
      streams,
      "already-written-after-restart",
      30_000,
      "before-gen2",
    )
    const liveAfterRestart = yield* completeMatchInGen2(
      streams,
      "live-after-restart",
      30_000,
      "after-gen2",
    )
    const timeoutAfterRestart = yield* runTimeoutAfterRestart(streams)
    const result = {
      alreadyWrittenAfterRestart,
      liveAfterRestart,
      timeoutAfterRestart,
    }
    yield* Effect.annotateCurrentSpan({
      "firegrid.phase1.lane6.already_written.replay_completed":
        alreadyWrittenAfterRestart.replayCompleted,
      "firegrid.phase1.lane6.already_written.outcome":
        alreadyWrittenAfterRestart.outcome ?? "",
      "firegrid.phase1.lane6.already_written.value":
        alreadyWrittenAfterRestart.value ?? "",
      "firegrid.phase1.lane6.live_after_restart.replay_completed":
        liveAfterRestart.replayCompleted,
      "firegrid.phase1.lane6.live_after_restart.outcome":
        liveAfterRestart.outcome ?? "",
      "firegrid.phase1.lane6.live_after_restart.value":
        liveAfterRestart.value ?? "",
      "firegrid.phase1.lane6.timeout_after_restart.replay_completed":
        timeoutAfterRestart.replayCompleted,
      "firegrid.phase1.lane6.timeout_after_restart.outcome":
        timeoutAfterRestart.outcome ?? "",
      "firegrid.phase1.lane6.timeout_after_restart.deadline_preserved":
        timeoutAfterRestart.timeoutClockDeadlinePreserved === true,
    })
    return result
  }).pipe(
    Effect.withSpan("firegrid.phase1.lane6.new_shape_replay.probe", {
      kind: "internal",
      attributes: {
        "firegrid.phase1.lane6.workflow_stream": streams.workflow,
        "firegrid.phase1.lane6.fact_stream": streams.facts,
        "firegrid.phase1.lane6.worker_id": stableWorkerId,
      },
    }),
  )
}

const publishResult = (
  env: TinyFiregridHostEnv,
): Effect.Effect<void, unknown> =>
  runProbe(env).pipe(
    Effect.flatMap(assertProbeGreen),
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.sync(() => {
          rejectResult(new Error(Cause.pretty(cause)))
        }).pipe(Effect.zipRight(Effect.failCause(cause))),
      onSuccess: (result) =>
        Effect.sync(() => {
          resolveResult(result)
        }),
    }),
  )

export const phase1Lane6NewShapeReplayHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  Layer.scopedDiscard(
    publishResult(env).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          rejectResult(new Error("phase1 lane6 replay host interrupted"))
        })),
      Effect.withSpan("firegrid.phase1.lane6.host"),
    ),
  ) as Layer.Layer<FiregridHost, unknown>
