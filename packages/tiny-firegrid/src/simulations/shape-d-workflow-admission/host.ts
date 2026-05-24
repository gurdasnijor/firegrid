import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import { Clock, Duration, Effect, Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  awaitFinalResult,
  ClockWorkflow,
  engineStreamUrlFor,
  executeToolShapeC,
  isSuspended,
  pendingClockWakeups,
  provideCompletionTable,
  provideDueTimeTable,
  provideToolResultTable,
  resetToolSideEffectCount,
  runClockGeneration,
  runToolGeneration,
  ToolWorkflow,
  toolSideEffectRuns,
} from "./resources.ts"

// The Shape D arms drive the real DurableStreamsWorkflowEngine, which lives
// behind the host boundary (drivers may only touch @firegrid/client-sdk). So the
// host owns all engine + table orchestration and hands the driver ready-to-run,
// fully-provided probe Effects via a module latch (same pattern as
// input-suspend-crash-recovery / loop-state-table).

// ── Probe 1: tool execution (at-most-once external effect) ──────────────────
export interface ToolProbeResult {
  // Shape C: handler over a toolUseId-keyed DurableTable result row, no engine.
  readonly shapeC: {
    readonly deliveries: number
    readonly genuineExecutions: number
    readonly sideEffectRuns: number
    readonly resultsAllEqual: boolean
  }
  // Shape D: Activity inside a Workflow over the real engine, replayed across a
  // reconstruction.
  readonly shapeD: {
    readonly gen1Result: string
    readonly gen2Result: string
    readonly sideEffectRuns: number
  }
}

// ── Probe 2: wait routing (durable completion, the race/timeout substrate) ──
export interface WaitProbeResult {
  // Shape C durable completion: producer resolves a keyed row; the waiter
  // reconstructs purely from the row after a crash (no in-memory waiter).
  readonly observedPendingBeforeResolve: boolean
  readonly resolvedFromStateAfterCrash: boolean
  readonly recoveredValue: string | undefined
  // first-valid-terminal-wins across two completion rows (the "race" reduces to
  // reading rows; no engine combinator required).
  readonly raceWinner: string | undefined
}

// ── Probe 3: scheduled prompt (DurableClock true-future delivery) ───────────
export interface ScheduledProbeResult {
  // Shape D DurableClock: park, crash before fire, reconstruct -> auto-fires.
  readonly shapeD: {
    readonly suspendedBeforeCrash: boolean
    readonly pendingWakeupBeforeCrash: number
    readonly autoCompletedAfterRestart: boolean
  }
  // Shape C due-time row: after restart, nothing fires it; only an explicit
  // poll (external trigger) can observe the due row.
  readonly shapeC: {
    readonly autoFiredAfterRestart: boolean
    readonly observableOnlyByExternalPoll: boolean
  }
}

interface ShapeDAdmissionRuntime {
  readonly runToolProbe: Effect.Effect<ToolProbeResult, unknown>
  readonly runWaitProbe: Effect.Effect<WaitProbeResult, unknown>
  readonly runScheduledProbe: Effect.Effect<ScheduledProbeResult, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: ShapeDAdmissionRuntime) => void = () => undefined
  const promise = new Promise<ShapeDAdmissionRuntime>(resolve => {
    resolveRuntime = resolve
  })
  return { promise, resolve: resolveRuntime }
})()

export const shapeDAdmissionRuntime = runtimeLatch.promise

const now = (): string => new Date().toISOString()

// Probe 1 — tool execution.
const toolProbe = (
  env: TinyFiregridHostEnv,
): Effect.Effect<ToolProbeResult, unknown> =>
  Effect.gen(function*() {
    resetToolSideEffectCount()

    // Shape C arm: deliver the same tool_use three times (re-deliveries / replays)
    // against the durable result table. Each delivery is a fresh handler
    // materialization. insertOrGet on the toolUseId-keyed row fences the side
    // effect to once.
    const toolUseId = "tool-c-1"
    const cResults = yield* Effect.forEach([1, 2, 3], () =>
      provideToolResultTable(env, table => executeToolShapeC(table, toolUseId)))
    const genuineExecutions = cResults.filter(r => r.genuinelyExecuted).length
    const resultsAllEqual = cResults.every(r => r.result === cResults[0]?.result)
    const shapeCSideEffectRuns = toolSideEffectRuns()

    yield* Effect.annotateCurrentSpan({
      "firegrid.tf28b8.tool.shape_c.deliveries": cResults.length,
      "firegrid.tf28b8.tool.shape_c.genuine_executions": genuineExecutions,
      "firegrid.tf28b8.tool.shape_c.side_effect_runs": shapeCSideEffectRuns,
    })

    // Shape D arm: same external effect wrapped in an Activity inside a Workflow.
    // gen1 executes; gen2 reconstructs the engine and executes the same key again
    // (the replay) — the Activity result is memoized so the effect does not re-run.
    resetToolSideEffectCount()
    const engineUrl = engineStreamUrlFor(env, "tool")
    const gen1Result = yield* runToolGeneration(engineUrl, () =>
      ToolWorkflow.execute({ toolUseId: "tool-d-1" }))
    const gen2Result = yield* runToolGeneration(engineUrl, () =>
      ToolWorkflow.execute({ toolUseId: "tool-d-1" }))
    const shapeDSideEffectRuns = toolSideEffectRuns()

    yield* Effect.annotateCurrentSpan({
      "firegrid.tf28b8.tool.shape_d.gen1_result": gen1Result,
      "firegrid.tf28b8.tool.shape_d.gen2_result": gen2Result,
      "firegrid.tf28b8.tool.shape_d.side_effect_runs": shapeDSideEffectRuns,
    })

    return {
      shapeC: {
        deliveries: cResults.length,
        genuineExecutions,
        sideEffectRuns: shapeCSideEffectRuns,
        resultsAllEqual,
      },
      shapeD: {
        gen1Result,
        gen2Result,
        sideEffectRuns: shapeDSideEffectRuns,
      },
    }
  }).pipe(Effect.withSpan("firegrid.tf28b8.tool_probe"))

// Probe 2 — wait routing as a durable completion (Shape C).
const waitProbe = (
  env: TinyFiregridHostEnv,
): Effect.Effect<WaitProbeResult, unknown> =>
  Effect.gen(function*() {
    const completionKey = "completion/perm-1"

    // gen1: a waiter handler point-reads the completion (snapshot-first) and sees
    // it pending. The producer then resolves the row. CRASH (scope close) — no
    // in-memory waiter survives.
    const observedPendingBeforeResolve = yield* provideCompletionTable(env, table =>
      Effect.gen(function*() {
        yield* table.completions.insertOrGet({
          completionKey,
          status: "pending",
          at: now(),
        })
        const snapshot = yield* table.completions.get(completionKey)
        const pending = snapshot._tag === "Some" && snapshot.value.status === "pending"
        // Producer resolves the wait by upserting the terminal row.
        yield* table.completions.upsert({
          completionKey,
          status: "resolved",
          value: "approved",
          at: now(),
        })
        return pending
      }))

    // gen2: a fresh handler reconstructs the wait purely from the durable row —
    // no in-memory waiter, no engine re-arm. C4: reconstruction reads durable
    // completion records.
    const recovered = yield* provideCompletionTable(env, table =>
      table.completions.get(completionKey).pipe(
        Effect.map(row =>
          row._tag === "Some" && row.value.status === "resolved"
            ? row.value.value
            : undefined),
      ))

    // Race: two completion rows; first-valid-terminal-wins is just reading the
    // resolved rows and picking the first — no DurableDeferred combinator.
    const raceWinner = yield* provideCompletionTable(env, table =>
      Effect.gen(function*() {
        yield* table.completions.upsert({
          completionKey: "completion/race-a",
          status: "resolved",
          value: "winner-a",
          at: now(),
        })
        yield* table.completions.upsert({
          completionKey: "completion/race-b",
          status: "resolved",
          value: "winner-b",
          at: now(),
        })
        const a = yield* table.completions.get("completion/race-a")
        const b = yield* table.completions.get("completion/race-b")
        const candidates = [a, b]
          .filter(row => row._tag === "Some" && row.value.status === "resolved")
          .map(row => (row._tag === "Some" ? row.value.value : undefined))
        return candidates[0]
      }))

    yield* Effect.annotateCurrentSpan({
      "firegrid.tf28b8.wait.observed_pending_before_resolve": observedPendingBeforeResolve,
      "firegrid.tf28b8.wait.recovered_from_state": recovered !== undefined,
      "firegrid.tf28b8.wait.recovered_value": recovered ?? "(none)",
      "firegrid.tf28b8.wait.race_winner": raceWinner ?? "(none)",
    })

    return {
      observedPendingBeforeResolve,
      resolvedFromStateAfterCrash: recovered !== undefined,
      recoveredValue: recovered,
      raceWinner,
    }
  }).pipe(Effect.withSpan("firegrid.tf28b8.wait_probe"))

// Probe 3 — scheduled prompt (DurableClock).
const scheduledProbe = (
  env: TinyFiregridHostEnv,
): Effect.Effect<ScheduledProbeResult, unknown> =>
  Effect.gen(function*() {
    // Shape D arm: park on DurableClock, crash before fire, reconstruct -> the
    // engine's recoverPendingClockWakeups re-arms the wakeup with NO explicit
    // resume (the one recovery mechanism the engine has; see S1 Probe C).
    const clockEngineUrl = engineStreamUrlFor(env, "clock")
    const id = "sched-1"
    const executionId = yield* ClockWorkflow.executionId({ id })

    const before = yield* runClockGeneration(clockEngineUrl, engineTable =>
      Effect.gen(function*() {
        yield* ClockWorkflow.execute({ id }, { discard: true })
        const suspended = yield* isSuspended(engineTable, executionId)
        const pending = yield* pendingClockWakeups(engineTable, executionId)
        yield* Effect.annotateCurrentSpan({
          "firegrid.tf28b8.scheduled.shape_d.suspended": suspended,
          "firegrid.tf28b8.scheduled.shape_d.pending_wakeups": pending,
        })
        return { suspended, pending }
      }))

    const autoCompleted = yield* runClockGeneration(clockEngineUrl, engineTable =>
      awaitFinalResult(engineTable, executionId, Duration.seconds(3)).pipe(
        Effect.tap(completed =>
          Effect.annotateCurrentSpan({
            "firegrid.tf28b8.scheduled.shape_d.auto_completed_after_restart": completed,
          })),
      ))

    // Shape C arm: a due-time row in DurableTable. gen1 writes it with a fireAt in
    // the near future. gen2 reconstructs WITHOUT an external tick — nothing fires
    // it. Only an explicit poll past the due time observes the row, which is the
    // polling/external-trigger outcome the target architecture wants to avoid.
    const dueKey = "due/sched-c-1"
    yield* provideDueTimeTable(env, table =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap(nowMs =>
          table.dueTimes.insertOrGet({
            dueKey,
            fireAtMs: nowMs + 150,
            fired: false,
            at: now(),
          })),
      ))

    // Reconstruct (fresh table layer) and observe passively — no poll loop.
    // The row cannot fire itself: DurableTable offers no wall-clock push.
    const autoFiredAfterRestart = yield* provideDueTimeTable(env, table =>
      table.dueTimes.get(dueKey).pipe(
        Effect.map(row => row._tag === "Some" && row.value.fired),
      ))

    // An explicit external poll (the only Shape C path) reads the now-due row.
    yield* Effect.sleep(Duration.millis(200))
    const observableOnlyByExternalPoll = yield* provideDueTimeTable(env, table =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap(nowMs =>
          table.dueTimes.get(dueKey).pipe(
            Effect.map(row =>
              row._tag === "Some" && nowMs >= row.value.fireAtMs),
          )),
      ))

    yield* Effect.annotateCurrentSpan({
      "firegrid.tf28b8.scheduled.shape_c.auto_fired_after_restart": autoFiredAfterRestart,
      "firegrid.tf28b8.scheduled.shape_c.observable_only_by_external_poll":
        observableOnlyByExternalPoll,
    })

    return {
      shapeD: {
        suspendedBeforeCrash: before.suspended,
        pendingWakeupBeforeCrash: before.pending,
        autoCompletedAfterRestart: autoCompleted,
      },
      shapeC: {
        autoFiredAfterRestart,
        observableOnlyByExternalPoll,
      },
    }
  }).pipe(Effect.withSpan("firegrid.tf28b8.scheduled_probe"))

export const shapeDWorkflowAdmissionHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> =>
  Layer.scopedDiscard(
    Effect.sync(() => {
      runtimeLatch.resolve({
        runToolProbe: toolProbe(env),
        runWaitProbe: waitProbe(env),
        runScheduledProbe: scheduledProbe(env),
      })
    }),
  ) as unknown as Layer.Layer<FiregridHost, unknown, never>
