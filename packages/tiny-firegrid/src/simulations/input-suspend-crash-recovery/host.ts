import type { FiregridHost } from "@firegrid/host-sdk"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Duration, Effect, Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  awaitFinalResult,
  ClockWorkflow,
  type ExecObservation,
  type GenerationUrls,
  isSuspended,
  observeWake,
  pendingClockWakeups,
  runClockGeneration,
  runWakeGeneration,
  WakeWorkflow,
} from "./workflow.ts"

// This sim drives the real DurableStreamsWorkflowEngine, which lives behind the
// host boundary (drivers may only touch @firegrid/client-sdk). So the host owns
// all engine orchestration and exposes the three probes to the driver as
// ready-to-run, fully-provided Effects via a module latch — same pattern as
// tiny-input-append-wakeup / loop-state-table. The driver stays a thin client
// that triggers probes and asserts on the returned plain data.

export interface ProbeResult {
  readonly probe: string
  // Snapshot just before the simulated crash (body parked, input durable).
  readonly beforeCrash: ExecObservation
  // Snapshot after engine reconstruction, BEFORE any external re-drive.
  // The load-bearing measurement: did reconstruction process the input?
  readonly afterRestart: ExecObservation
  // Snapshot after an explicit external re-drive (resume / execute).
  readonly afterRedrive: ExecObservation
  readonly redriveValue: string
}

export interface ClockProbeResult {
  readonly suspendedBeforeCrash: boolean
  readonly pendingClockWakeupBeforeCrash: number
  readonly autoCompletedAfterRestart: boolean
}

interface S1Runtime {
  readonly runProbeA: Effect.Effect<ProbeResult, unknown>
  readonly runProbeB: Effect.Effect<ProbeResult, unknown>
  readonly runProbeC: Effect.Effect<ClockProbeResult, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: S1Runtime) => void = () => undefined
  const promise = new Promise<S1Runtime>(resolve => {
    resolveRuntime = resolve
  })
  return { promise, resolve: resolveRuntime }
})()

export const s1Runtime = runtimeLatch.promise

const urlsFor = (env: TinyFiregridHostEnv, probe: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.s1.${env.runId}.${probe}.engine`,
  ),
  inputStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.s1.${env.runId}.${probe}.input`,
  ),
})

const annotateObservation = (phase: string, obs: ExecObservation) =>
  Effect.annotateCurrentSpan({
    [`firegrid.s1.${phase}.execution_exists`]: obs.executionExists,
    [`firegrid.s1.${phase}.suspended`]: obs.suspended ?? false,
    [`firegrid.s1.${phase}.has_final_result`]: obs.hasFinalResult,
    [`firegrid.s1.${phase}.deferred_count`]: obs.deferredCount,
    [`firegrid.s1.${phase}.input_processed`]: obs.processed,
  })

// Probe A — crash between write and resume (the lost-wakeup half of Q3 §3).
// gen1: start (no input) -> park; write input row; DROP the process before
// engine.resume. gen2: reconstruct, observe passively (no re-drive) -> the
// input is durable but the body never processed it. gen3: replay the lost
// resume -> the body recovers.
const probeA = (env: TinyFiregridHostEnv): Effect.Effect<ProbeResult, unknown> =>
  Effect.gen(function*() {
    const urls = urlsFor(env, "probe-a")
    const id = "a"
    const value = "delivered-by-A"
    const executionId = yield* WakeWorkflow.executionId({ id })

    // gen1: park the body, then write the input without resuming, then crash.
    const beforeCrash = yield* runWakeGeneration(urls, ({ engineTable, inputTable }) => Effect.gen(function*() {
      yield* WakeWorkflow.execute({ id }, { discard: true })
      const parked = yield* observeWake(engineTable, inputTable, executionId, id)
      // No settle needed: execute(discard) joins the body fiber, which durably
      // upserts the suspended row before returning.
      // tf-e5rf invariants at the suspend point: parked, no result, NO deferred
      // mailbox, not processed.
      yield* assertHost(
        parked.suspended === true && !parked.hasFinalResult,
        "probe A body did not park on Workflow.suspend",
      )
      yield* assertHost(
        parked.deferredCount === 0,
        "probe A suspension created a deferred mailbox (expected table-wait, no deferred)",
      )
      yield* assertHost(
        !parked.processed,
        "probe A processed the input before any input row existed",
      )
      // Durable write of the workflow-owned input row. NO engine.resume — the
      // wake-up signal is lost to the crash that follows (scope close).
      yield* inputTable.inputs.insert({ key: id, value })
      yield* Effect.annotateCurrentSpan({
        "firegrid.s1.probe_a.marker": "wrote-input-resume-lost",
      })
      return parked
    }).pipe(Effect.withSpan("firegrid.s1.probe_a.gen1_write_then_crash")))

    // gen2: reconstruct. Observe ONLY — calling execute/resume here would mask
    // the gap. Per Q3, nothing re-arms a table-wait suspension on restart.
    const afterRestart = yield* runWakeGeneration(urls, ({ engineTable, inputTable }) => Effect.gen(function*() {
      const obs = yield* observeWake(engineTable, inputTable, executionId, id)
      yield* annotateObservation("probe_a_after_restart", obs)
      yield* Effect.annotateCurrentSpan({
        "firegrid.s1.probe_a.marker": "reconstructed-no-redrive",
        "firegrid.s1.probe_a.input_durable_but_unprocessed":
          !obs.processed && !obs.hasFinalResult,
      })
      return obs
    }).pipe(Effect.withSpan("firegrid.s1.probe_a.gen2_reconstruct_observe")))

    // gen3: replay the lost resume -> the parked body recovers.
    const redrive = yield* runWakeGeneration(urls, ({ engineTable, inputTable }) => Effect.gen(function*() {
      yield* WakeWorkflow.resume(executionId)
      const redriveValue = yield* WakeWorkflow.execute({ id })
      const obs = yield* observeWake(engineTable, inputTable, executionId, id)
      yield* annotateObservation("probe_a_after_redrive", obs)
      yield* Effect.annotateCurrentSpan({
        "firegrid.s1.probe_a.marker": "resume-replayed-recovered",
        "firegrid.s1.probe_a.redrive_value": redriveValue,
      })
      return { obs, redriveValue }
    }).pipe(Effect.withSpan("firegrid.s1.probe_a.gen3_resume_recover")))

    return {
      probe: "A",
      beforeCrash,
      afterRestart,
      afterRedrive: redrive.obs,
      redriveValue: redrive.redriveValue,
    }
  }).pipe(Effect.withSpan("firegrid.s1.probe_a"))

// Probe B — restart while parked with input already present (the
// no-restart-sweep half of Q3 §3). Same setup, but the claim under test is
// that engine RECONSTRUCTION ALONE does not re-arm the parked body even though
// the input is durable; a single external re-drive then recovers it.
const probeB = (env: TinyFiregridHostEnv): Effect.Effect<ProbeResult, unknown> =>
  Effect.gen(function*() {
    const urls = urlsFor(env, "probe-b")
    const id = "b"
    const value = "delivered-by-B"
    const executionId = yield* WakeWorkflow.executionId({ id })

    // gen1: park, write input (now durably present), crash.
    const beforeCrash = yield* runWakeGeneration(urls, ({ engineTable, inputTable }) => Effect.gen(function*() {
      yield* WakeWorkflow.execute({ id }, { discard: true })
      const parked = yield* observeWake(engineTable, inputTable, executionId, id)
      yield* assertHost(
        parked.suspended === true && !parked.hasFinalResult && !parked.processed,
        "probe B body did not park with input absent",
      )
      yield* inputTable.inputs.insert({ key: id, value })
      yield* Effect.annotateCurrentSpan({
        "firegrid.s1.probe_b.marker": "input-present-then-crash",
      })
      return parked
    }).pipe(Effect.withSpan("firegrid.s1.probe_b.gen1_input_present_then_crash")))

    // gen2: reconstruct WITH the input already present. Observe BEFORE the
    // re-drive to capture whether reconstruction alone re-armed the body, then
    // issue a single external re-drive (what a recovery sweep / kernel-owned
    // writer would issue) and confirm recovery.
    const restartAndRedrive = yield* runWakeGeneration(urls, ({ engineTable, inputTable }) => Effect.gen(function*() {
      const afterRestart = yield* observeWake(engineTable, inputTable, executionId, id)
      yield* annotateObservation("probe_b_after_restart", afterRestart)
      yield* Effect.annotateCurrentSpan({
        "firegrid.s1.probe_b.marker": "reconstructed-input-present-no-rearm",
        "firegrid.s1.probe_b.rearmed_by_reconstruction": afterRestart.processed,
      })
      const redriveValue = yield* WakeWorkflow.execute({ id })
      const afterRedrive = yield* observeWake(engineTable, inputTable, executionId, id)
      yield* annotateObservation("probe_b_after_redrive", afterRedrive)
      yield* Effect.annotateCurrentSpan({
        "firegrid.s1.probe_b.redrive_value": redriveValue,
      })
      return { afterRestart, afterRedrive, redriveValue }
    }).pipe(Effect.withSpan("firegrid.s1.probe_b.gen2_reconstruct_then_redrive")))

    return {
      probe: "B",
      beforeCrash,
      afterRestart: restartAndRedrive.afterRestart,
      afterRedrive: restartAndRedrive.afterRedrive,
      redriveValue: restartAndRedrive.redriveValue,
    }
  }).pipe(Effect.withSpan("firegrid.s1.probe_b"))

// Probe C — contrast control. A DurableClock-parked body. The engine's
// recoverPendingClockWakeups re-arms clock wakeups on reconstruction (the ONE
// recovery mechanism it has), so this completes after restart WITHOUT any
// explicit resume — the asymmetry that motivates a table-wait recovery sweep.
const probeC = (env: TinyFiregridHostEnv): Effect.Effect<ClockProbeResult, unknown> =>
  Effect.gen(function*() {
    const engineStreamUrl = durableStreamUrl(
      env.durableStreamsBaseUrl,
      `${env.namespace}.s1.${env.runId}.probe-c.engine`,
    )
    const id = "c"
    const executionId = yield* ClockWorkflow.executionId({ id })

    // gen1: park on the durable clock (deadline ~400ms out), crash immediately.
    const before = yield* runClockGeneration(engineStreamUrl, engineTable => Effect.gen(function*() {
      yield* ClockWorkflow.execute({ id }, { discard: true })
      const suspended = yield* isSuspended(engineTable, executionId)
      const pending = yield* pendingClockWakeups(engineTable, executionId)
      yield* Effect.annotateCurrentSpan({
        "firegrid.s1.probe_c.suspended": suspended,
        "firegrid.s1.probe_c.pending_clock_wakeups": pending,
        "firegrid.s1.probe_c.marker": "clock-parked-then-crash",
      })
      return { suspended, pending }
    }).pipe(Effect.withSpan("firegrid.s1.probe_c.gen1_clock_park_then_crash")))

    // gen2: reconstruct. NO explicit resume — recoverPendingClockWakeups
    // re-arms the wakeup, which fires and completes the body asynchronously.
    const autoCompleted = yield* runClockGeneration(engineStreamUrl, engineTable => Effect.gen(function*() {
      const completed = yield* awaitFinalResult(
        engineTable,
        executionId,
        Duration.seconds(3),
      )
      yield* Effect.annotateCurrentSpan({
        "firegrid.s1.probe_c.auto_completed_after_restart": completed,
        "firegrid.s1.probe_c.marker": "reconstructed-clock-auto-fired",
      })
      return completed
    }).pipe(Effect.withSpan("firegrid.s1.probe_c.gen2_reconstruct_auto_recover")))

    return {
      suspendedBeforeCrash: before.suspended,
      pendingClockWakeupBeforeCrash: before.pending,
      autoCompletedAfterRestart: autoCompleted,
    }
  }).pipe(Effect.withSpan("firegrid.s1.probe_c"))

const assertHost = (condition: boolean, message: string) =>
  condition
    ? Effect.void
    : Effect.fail(new Error(`S1 host invariant failed: ${message}`))

export const inputSuspendCrashRecoveryHost = (
  env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown, never> =>
  Layer.scopedDiscard(
    Effect.sync(() => {
      runtimeLatch.resolve({
        runProbeA: probeA(env),
        runProbeB: probeB(env),
        runProbeC: probeC(env),
      })
    }),
  ) as unknown as Layer.Layer<FiregridHost, unknown, never>
