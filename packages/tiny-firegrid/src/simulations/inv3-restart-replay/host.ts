import { Workflow, WorkflowEngine } from "@effect/workflow"
import {
  durableStreamUrl,
  type FiregridHost,
} from "@firegrid/host-sdk"
import {
  RuntimeAgentOutputEvents,
} from "@firegrid/runtime/runtime-output"
import {
  RuntimeRuns,
} from "@firegrid/runtime/control-plane"
import {
  CallerOwnedFactStreams,
  DurableToolsTable,
  DurableToolsWaitForLive,
  WaitFor,
  type WaitForOutcome,
  type WaitRow,
} from "@firegrid/runtime/durable-tools"
import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
  type WorkflowClockWakeupRow,
  type WorkflowExecutionRow,
} from "@firegrid/runtime/workflow-engine"
import { Cause, Clock, Duration, Effect, Fiber, Layer, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

const factStream = "inv3.restartReplay.facts"
const eventType = "inv3.match"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  scenario: Schema.String,
  eventType: Schema.String,
  value: Schema.String,
  acceptedAtMs: Schema.Number,
})

type FactRow = Schema.Schema.Type<typeof FactRowSchema>

const WorkflowResultSchema = Schema.Struct({
  scenario: Schema.String,
  executionId: Schema.String,
  outcome: Schema.Literal("Match", "Timeout"),
  row: Schema.optional(FactRowSchema),
  completedAtMs: Schema.Number,
})

type WorkflowResult = Schema.Schema.Type<typeof WorkflowResultSchema>

const PayloadSchema = Schema.Struct({
  id: Schema.String,
  scenario: Schema.String,
  timeoutMs: Schema.optional(Schema.Number),
})

type Payload = Schema.Schema.Type<typeof PayloadSchema>

class Inv3FactTable extends DurableTable("inv3RestartReplay", {
  facts: FactRowSchema,
}) {}

interface Streams {
  readonly workflow: string
  readonly waits: string
  readonly facts: string
}

interface ScenarioVerdict {
  readonly scenario: string
  readonly executionId: string
  readonly gen1ExecutionId: string
  readonly gen2ExecutionId: string
  readonly outcome: WorkflowResult["outcome"]
  readonly value: string | undefined
  readonly waitStatus: string | undefined
  readonly deadlinePreserved: boolean | undefined
}

interface Inv3RestartReplayResult {
  readonly alreadyWritten: ScenarioVerdict
  readonly liveAfterRestart: ScenarioVerdict
  readonly timeoutAfterRestart: ScenarioVerdict
}

/* eslint-disable local/no-module-durable-cache -- simulation-local host/driver handshake; replay state under test still lives only in Durable Streams. */
let resolveResult: (result: Inv3RestartReplayResult) => void
let rejectResult: (error: unknown) => void

export const inv3RestartReplayResult = new Promise<Inv3RestartReplayResult>(
  (resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  },
)
/* eslint-enable local/no-module-durable-cache */

const WaitForWorkflow = Workflow.make({
  name: "inv3.wait-for-workflow",
  payload: PayloadSchema,
  success: WorkflowResultSchema,
  error: Schema.String,
  idempotencyKey: (payload: Payload) => payload.id,
})

const waitNameFor = (scenario: string): string => `inv3/${scenario}`

const payloadFor = (
  scenario: string,
  options: { readonly timeoutMs?: number } = {},
): Payload => ({
  id: scenario,
  scenario,
  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
})

const factFor = (
  scenario: string,
  value: string,
): Effect.Effect<FactRow> =>
  Effect.map(Clock.currentTimeMillis, acceptedAtMs => ({
    factId: `${scenario}:${value}`,
    scenario,
    eventType,
    value,
    acceptedAtMs,
  }))

const workflowLayer = WaitForWorkflow.toLayer((payload: Payload) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const outcome: WaitForOutcome<FactRow> = yield* WaitFor.match<FactRow>({
      name: waitNameFor(payload.scenario),
      source: { _tag: "CallerFact", stream: factStream },
      trigger: [
        { path: ["scenario"], equals: payload.scenario },
        { path: ["eventType"], equals: eventType },
      ],
      resultSchema: FactRowSchema,
      ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
    }).pipe(Effect.mapError(cause => String(cause)))
    const completedAtMs = yield* Clock.currentTimeMillis
    return outcome._tag === "Match"
      ? {
        scenario: payload.scenario,
        executionId: instance.executionId,
        outcome: "Match" as const,
        row: outcome.row,
        completedAtMs,
      }
      : {
        scenario: payload.scenario,
        executionId: instance.executionId,
        outcome: "Timeout" as const,
        completedAtMs,
      }
  }))

const tableOptions = (streamUrl: string): DurableTableLayerOptions => ({
  streamOptions: {
    url: streamUrl,
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const factLayer = (streams: Streams) =>
  Inv3FactTable.layer(tableOptions(streams.facts))

const callerFactsLayer = (streams: Streams) =>
  Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(Inv3FactTable, table => ({
      streamFor: (stream: string) =>
        stream === factStream ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factLayer(streams)))

const sourceLayer = (streams: Streams) =>
  Layer.mergeAll(
    callerFactsLayer(streams),
    Layer.succeed(
      RuntimeRuns,
      Stream.empty as unknown as RuntimeRuns["Type"],
    ),
    Layer.succeed(
      RuntimeAgentOutputEvents,
      Stream.empty as unknown as RuntimeAgentOutputEvents["Type"],
    ),
  )

const generationLayer = (
  streams: Streams,
  generation: 1 | 2,
): Layer.Layer<never, unknown, never> =>
  workflowLayer.pipe(
    Layer.provideMerge(DurableToolsWaitForLive({ streamUrl: streams.waits })),
    Layer.provideMerge(sourceLayer(streams)),
    Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
      streamUrl: streams.workflow,
      workerId: `inv3-generation-${generation}`,
    }) as Layer.Layer<never, unknown, unknown>),
    Layer.provideMerge(factLayer(streams)),
  ) as Layer.Layer<never, unknown, never>

const waitTableLayer = (streams: Streams) =>
  DurableToolsTable.layer(tableOptions(streams.waits))

const workflowTableLayer = (streams: Streams) =>
  WorkflowEngineTable.layer(tableOptions(streams.workflow))

const withGeneration = <A, E>(
  streams: Streams,
  generation: 1 | 2,
  effect: Effect.Effect<A, E, unknown>,
): Effect.Effect<A, unknown, never> =>
  (Effect.scoped(
    effect.pipe(Effect.provide(generationLayer(streams, generation))),
  ).pipe(
    Effect.withSpan("firegrid.inv3.host_generation", {
      kind: "internal",
      attributes: {
        "firegrid.inv3.generation": generation,
      },
    }),
  ) as Effect.Effect<A, unknown, never>)

const inspectWaits = (
  streams: Streams,
): Effect.Effect<ReadonlyArray<WaitRow>, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const table = yield* DurableToolsTable
      return yield* table.waits.query(coll => coll.toArray)
    }).pipe(Effect.provide(waitTableLayer(streams))),
  )

const inspectExecutions = (
  streams: Streams,
): Effect.Effect<ReadonlyArray<WorkflowExecutionRow>, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const table = yield* WorkflowEngineTable
      return yield* table.executions.query(coll => coll.toArray)
    }).pipe(Effect.provide(workflowTableLayer(streams))),
  )

const inspectClockWakeups = (
  streams: Streams,
): Effect.Effect<ReadonlyArray<WorkflowClockWakeupRow>, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const table = yield* WorkflowEngineTable
      return yield* table.clockWakeups.query(coll => coll.toArray)
    }).pipe(Effect.provide(workflowTableLayer(streams))),
  )

const waitRowFor = (
  rows: ReadonlyArray<WaitRow>,
  scenario: string,
): WaitRow | undefined =>
  rows.find(row => row.waitKey.name === waitNameFor(scenario))

const executionFor = (
  rows: ReadonlyArray<WorkflowExecutionRow>,
  executionId: string,
): WorkflowExecutionRow | undefined =>
  rows.find(row => row.executionId === executionId)

const waitUntil = <A>(
  label: string,
  poll: Effect.Effect<A, unknown>,
  satisfied: (value: A) => boolean,
): Effect.Effect<A, unknown> =>
  /* eslint-disable local/no-fixed-polling -- bounded probe polling waits for durable-table visibility while characterizing restart replay. */
  Effect.gen(function*() {
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

const waitForActiveWait = (
  streams: Streams,
  scenario: string,
): Effect.Effect<WaitRow, unknown> =>
  Effect.map(
    waitUntil(
      `active wait ${scenario}`,
      inspectWaits(streams),
      rows => waitRowFor(rows, scenario)?.status === "active",
    ),
    rows => waitRowFor(rows, scenario)!,
  )

const waitForCompletedWait = (
  streams: Streams,
  scenario: string,
): Effect.Effect<WaitRow, unknown> =>
  Effect.map(
    waitUntil(
      `completed wait ${scenario}`,
      inspectWaits(streams),
      rows => waitRowFor(rows, scenario)?.status === "completed",
    ),
    rows => waitRowFor(rows, scenario)!,
  )

const waitForFinalExecution = (
  streams: Streams,
  executionId: string,
): Effect.Effect<WorkflowExecutionRow, unknown> =>
  Effect.map(
    waitUntil(
      `final execution ${executionId}`,
      inspectExecutions(streams),
      rows => executionFor(rows, executionId)?.finalResult !== undefined,
    ),
    rows => executionFor(rows, executionId)!,
  )

const upsertFact = (
  streams: Streams,
  row: FactRow,
): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function*() {
      const table = yield* Inv3FactTable
      yield* table.facts.upsert(row)
    }).pipe(Effect.provide(factLayer(streams))),
  )

const assertSame = (
  label: string,
  left: unknown,
  right: unknown,
): Effect.Effect<void, Error> =>
  left === right
    ? Effect.void
    : Effect.fail(new Error(`${label}: expected ${String(left)} === ${String(right)}`))

const runAlreadyWrittenScenario = (
  streams: Streams,
): Effect.Effect<ScenarioVerdict, unknown> =>
  Effect.gen(function*() {
    const scenario = "already-written"
    const payload = payloadFor(scenario, { timeoutMs: 30_000 })
    const executionId = yield* WaitForWorkflow.executionId(payload)

    const gen1Wait = yield* withGeneration(
      streams,
      1,
      Effect.gen(function*() {
        yield* WaitForWorkflow.execute(payload, { discard: true })
        return yield* waitForActiveWait(streams, scenario)
      }),
    )

    const row = yield* factFor(scenario, "row-written-before-generation-2")
    yield* upsertFact(streams, row)

    const gen2Result = yield* withGeneration(
      streams,
      2,
      WaitForWorkflow.execute(payload),
    )
    const finalWait = yield* waitForCompletedWait(streams, scenario)
    yield* assertSame("already-written execution id", executionId, gen2Result.executionId)
    yield* assertSame("already-written wait execution id", gen1Wait.executionId, finalWait.executionId)
    yield* assertSame("already-written replayed row", row.value, gen2Result.row?.value)

    return {
      scenario,
      executionId,
      gen1ExecutionId: gen1Wait.executionId,
      gen2ExecutionId: gen2Result.executionId,
      outcome: gen2Result.outcome,
      value: gen2Result.row?.value,
      waitStatus: finalWait.status,
      deadlinePreserved: finalWait.deadlineMs === gen1Wait.deadlineMs,
    }
  }).pipe(
    Effect.withSpan("firegrid.inv3.scenario.already_written", {
      kind: "internal",
    }),
  )

const runLiveAfterRestartScenario = (
  streams: Streams,
): Effect.Effect<ScenarioVerdict, unknown> =>
  Effect.gen(function*() {
    const scenario = "live-after-restart"
    const payload = payloadFor(scenario, { timeoutMs: 30_000 })
    const executionId = yield* WaitForWorkflow.executionId(payload)

    const gen1Wait = yield* withGeneration(
      streams,
      1,
      Effect.gen(function*() {
        yield* WaitForWorkflow.execute(payload, { discard: true })
        return yield* waitForActiveWait(streams, scenario)
      }),
    )

    const gen2Result = yield* withGeneration(
      streams,
      2,
      Effect.gen(function*() {
        const fiber = yield* WaitForWorkflow.execute(payload).pipe(Effect.fork)
        yield* Effect.sleep(Duration.millis(100))
        const row = yield* factFor(scenario, "row-written-after-generation-2")
        yield* upsertFact(streams, row)
        return yield* Fiber.join(fiber)
      }),
    )
    const finalWait = yield* waitForCompletedWait(streams, scenario)
    yield* assertSame("live-after-restart execution id", executionId, gen2Result.executionId)
    yield* assertSame("live-after-restart wait execution id", gen1Wait.executionId, finalWait.executionId)

    return {
      scenario,
      executionId,
      gen1ExecutionId: gen1Wait.executionId,
      gen2ExecutionId: gen2Result.executionId,
      outcome: gen2Result.outcome,
      value: gen2Result.row?.value,
      waitStatus: finalWait.status,
      deadlinePreserved: finalWait.deadlineMs === gen1Wait.deadlineMs,
    }
  }).pipe(
    Effect.withSpan("firegrid.inv3.scenario.live_after_restart", {
      kind: "internal",
    }),
  )

const runTimeoutAfterRestartScenario = (
  streams: Streams,
): Effect.Effect<ScenarioVerdict, unknown> =>
  Effect.gen(function*() {
    const scenario = "timeout-after-restart"
    const payload = payloadFor(scenario, { timeoutMs: 350 })
    const executionId = yield* WaitForWorkflow.executionId(payload)

    const gen1Wait = yield* withGeneration(
      streams,
      1,
      Effect.gen(function*() {
        yield* WaitForWorkflow.execute(payload, { discard: true })
        return yield* waitForActiveWait(streams, scenario)
      }),
    )
    const gen1Clock = (yield* inspectClockWakeups(streams)).find(row =>
      row.executionId === executionId &&
      row.clockName === `wait-for/${waitNameFor(scenario)}/clock`,
    )
    if (gen1Clock === undefined) {
      return yield* Effect.fail(new Error("timeout-after-restart missing gen1 clock row"))
    }

    const nowMs = yield* Clock.currentTimeMillis
    yield* Effect.sleep(Duration.millis(Math.max(0, gen1Clock.deadlineMs - nowMs + 75)))

    const gen2Result = yield* withGeneration(
      streams,
      2,
      WaitForWorkflow.execute(payload),
    )
    const finalExecution = yield* waitForFinalExecution(streams, executionId)
    const finalWait = waitRowFor(yield* inspectWaits(streams), scenario)
    const gen2Clock = (yield* inspectClockWakeups(streams)).find(row =>
      row.executionId === executionId &&
      row.clockName === gen1Clock.clockName,
    )
    yield* assertSame("timeout-after-restart execution id", executionId, gen2Result.executionId)
    yield* assertSame("timeout-after-restart outcome", "Timeout", gen2Result.outcome)

    return {
      scenario,
      executionId: finalExecution.executionId,
      gen1ExecutionId: gen1Wait.executionId,
      gen2ExecutionId: gen2Result.executionId,
      outcome: gen2Result.outcome,
      value: gen2Result.row?.value,
      waitStatus: finalWait?.status,
      deadlinePreserved: gen2Clock?.deadlineMs === gen1Clock.deadlineMs &&
        finalWait?.deadlineMs === gen1Wait.deadlineMs,
    }
  }).pipe(
    Effect.withSpan("firegrid.inv3.scenario.timeout_after_restart", {
      kind: "internal",
    }),
  )

const runProbe = (env: TinyFiregridHostEnv): Effect.Effect<Inv3RestartReplayResult, unknown> => {
  const streamPrefix = `${env.namespace}.${env.runId}.inv3`
  const streams: Streams = {
    workflow: durableStreamUrl(env.durableStreamsBaseUrl, `${streamPrefix}.workflow`),
    waits: durableStreamUrl(env.durableStreamsBaseUrl, `${streamPrefix}.waits`),
    facts: durableStreamUrl(env.durableStreamsBaseUrl, `${streamPrefix}.facts`),
  }
  return Effect.gen(function*() {
    const alreadyWritten = yield* runAlreadyWrittenScenario(streams)
    const liveAfterRestart = yield* runLiveAfterRestartScenario(streams)
    const timeoutAfterRestart = yield* runTimeoutAfterRestartScenario(streams)
    const result = {
      alreadyWritten,
      liveAfterRestart,
      timeoutAfterRestart,
    }
    yield* Effect.annotateCurrentSpan({
      "firegrid.inv3.already_written.value": alreadyWritten.value ?? "",
      "firegrid.inv3.live_after_restart.value": liveAfterRestart.value ?? "",
      "firegrid.inv3.timeout_after_restart.outcome": timeoutAfterRestart.outcome,
      "firegrid.inv3.timeout_after_restart.deadline_preserved":
        timeoutAfterRestart.deadlinePreserved === true,
    })
    return result
  }).pipe(
    Effect.withSpan("firegrid.inv3.restart_replay.probe", {
      kind: "internal",
      attributes: {
        "firegrid.inv3.workflow_stream": streams.workflow,
        "firegrid.inv3.wait_stream": streams.waits,
        "firegrid.inv3.fact_stream": streams.facts,
      },
    }),
  )
}

const publishResult = (
  env: TinyFiregridHostEnv,
): Effect.Effect<void, unknown> =>
  runProbe(env).pipe(
    Effect.matchCauseEffect({
      onFailure: cause =>
        Effect.sync(() => {
          rejectResult(new Error(Cause.pretty(cause)))
        }).pipe(Effect.zipRight(Effect.failCause(cause))),
      onSuccess: result =>
        Effect.sync(() => {
          resolveResult(result)
        }),
    }),
  )

export const inv3RestartReplayHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  Layer.scopedDiscard(
    publishResult(env).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          rejectResult(new Error("inv3 restart replay host interrupted"))
        })),
      Effect.withSpan("firegrid.inv3.host"),
    ),
  ) as Layer.Layer<FiregridHost, unknown>
