import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Duration, Effect, Layer } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  awaitFinalResult,
  DeferredWorkflow,
  type GenerationUrls,
  hasFinalResult,
  isSuspended,
  kernelRecordAndWrite,
  kernelWriteArm,
  type KernelServices,
  observeWake,
  resolveGate,
  runKernelGeneration,
  type WakeObservation,
  WakeWorkflow,
} from "./workflow.ts"

// The kernel-owned write+arm controller lives behind the host boundary (drivers
// touch only @firegrid/client-sdk). The host owns the engine orchestration and
// exposes the probes to the driver as ready-to-run Effects via a module latch —
// same pattern as tiny-input-append-wakeup / loop-state-table / S1.
//
// Each probe reconstructs the engine (a fresh generation over the SAME stream
// URLs = crash/restart). The kernel's startup recovery (replayPendingWriteArm,
// run inside runKernelGeneration before the program) is what recovers parked
// table-wait bodies — the driver never issues an explicit re-drive.

export interface WriteArmProbeResult {
  readonly probe: string
  readonly beforeCrash: WakeObservation
  // After reconstruction, with NO driver re-drive — the kernel replay alone.
  readonly afterRecovery: WakeObservation
  readonly autoRecovered: boolean
  readonly recoveredValue: string | undefined
}

export interface SoundnessProbeResult {
  readonly deferredSuspendedBeforeCrash: boolean
  // The load-bearing soundness measurement: after the kernel replay runs on
  // restart, the deferred-await execution is STILL parked (the kernel did not
  // sweep it — it owns no write+arm fact for it).
  readonly deferredUntouchedByReplay: boolean
  // Its own recovery path (deferredDone) still completes it independently.
  readonly recoveredViaOwnPath: boolean
}

interface KwaRuntime {
  readonly runProbeA: Effect.Effect<WriteArmProbeResult, unknown>
  readonly runProbeB: Effect.Effect<WriteArmProbeResult, unknown>
  readonly runProbeC: Effect.Effect<SoundnessProbeResult, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: KwaRuntime) => void = () => undefined
  const promise = new Promise<KwaRuntime>(resolve => {
    resolveRuntime = resolve
  })
  return { promise, resolve: resolveRuntime }
})()

export const kwaRuntime = runtimeLatch.promise

const urlsFor = (env: TinyFiregridHostEnv, probe: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.kwa.${env.runId}.${probe}.engine`,
  ),
  inputStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.kwa.${env.runId}.${probe}.input`,
  ),
  kernelStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.kwa.${env.runId}.${probe}.kernel`,
  ),
})

const annotateObservation = (phase: string, obs: WakeObservation) =>
  Effect.annotateCurrentSpan({
    [`firegrid.kwa.${phase}.execution_exists`]: obs.executionExists,
    [`firegrid.kwa.${phase}.suspended`]: obs.suspended ?? false,
    [`firegrid.kwa.${phase}.has_final_result`]: obs.hasFinalResult,
    [`firegrid.kwa.${phase}.deferred_count`]: obs.deferredCount,
    [`firegrid.kwa.${phase}.input_processed`]: obs.processed,
  })

const assertHost = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new Error(`kwa host invariant failed: ${message}`))

// Probe A — crash between write and arm. The kernel records the write+arm fact
// and writes the workflow-owned input row, then crashes before arming (no
// resume). On restart the kernel replay finds its own pending fact and completes
// the arm. No driver re-drive.
const probeA = (env: TinyFiregridHostEnv): Effect.Effect<WriteArmProbeResult, unknown> =>
  Effect.gen(function*() {
    const urls = urlsFor(env, "probe-a")
    const id = "a"
    const value = "delivered-by-A"
    const executionId = yield* WakeWorkflow.executionId({ id })

    const beforeCrash = yield* runKernelGeneration(urls, (services) => Effect.gen(function*() {
      yield* WakeWorkflow.execute({ id }, { discard: true })
      const parked = yield* observeWake(services.engineTable, services.inputTable, executionId, id)
      yield* assertHost(
        parked.suspended === true && !parked.hasFinalResult,
        "probe A body did not park on Workflow.suspend",
      )
      yield* assertHost(
        parked.deferredCount === 0,
        "probe A suspension created a deferred mailbox (expected table-wait, no deferred)",
      )
      yield* assertHost(!parked.processed, "probe A processed input before any row existed")
      // Kernel records the owned fact + writes the input row, then CRASHES
      // before arming (no kernelArm). The arm is what restart must replay.
      yield* kernelRecordAndWrite(services, executionId, id, value)
      yield* Effect.annotateCurrentSpan({ "firegrid.kwa.probe_a.marker": "recorded-wrote-arm-lost" })
      return parked
    }).pipe(Effect.withSpan("firegrid.kwa.probe_a.gen1_record_write_then_crash")))

    const recovery = yield* runKernelGeneration(urls, (services) => Effect.gen(function*() {
      // runKernelGeneration already ran replayPendingWriteArm at startup; just
      // passively wait for the recovered body to complete and observe.
      const autoRecovered = yield* awaitWake(services, executionId)
      const obs = yield* observeWake(services.engineTable, services.inputTable, executionId, id)
      yield* annotateObservation("probe_a_after_recovery", obs)
      yield* Effect.annotateCurrentSpan({
        "firegrid.kwa.probe_a.marker": "reconstructed-kernel-replay-armed",
        "firegrid.kwa.probe_a.auto_recovered": autoRecovered,
      })
      return { obs, autoRecovered }
    }).pipe(Effect.withSpan("firegrid.kwa.probe_a.gen2_reconstruct_kernel_replay")))

    return {
      probe: "A",
      beforeCrash,
      afterRecovery: recovery.obs,
      autoRecovered: recovery.autoRecovered,
      recoveredValue: recovery.obs.processedValue,
    }
  }).pipe(Effect.withSpan("firegrid.kwa.probe_a"))

// Probe B — arm issued but body did not finish before the crash. The kernel
// does the full write+arm (record + write + resume) but the generation crashes
// before the body writes its processed marker. On restart the kernel replay
// re-arms (idempotent) and the body completes.
const probeB = (env: TinyFiregridHostEnv): Effect.Effect<WriteArmProbeResult, unknown> =>
  Effect.gen(function*() {
    const urls = urlsFor(env, "probe-b")
    const id = "b"
    const value = "delivered-by-B"
    const executionId = yield* WakeWorkflow.executionId({ id })

    const beforeCrash = yield* runKernelGeneration(urls, (services) => Effect.gen(function*() {
      yield* WakeWorkflow.execute({ id }, { discard: true })
      const parked = yield* observeWake(services.engineTable, services.inputTable, executionId, id)
      yield* assertHost(
        parked.suspended === true && !parked.hasFinalResult && !parked.processed,
        "probe B body did not park with input absent",
      )
      // Full write+arm (one step): record + write + resume. The resume forks the
      // body; the generation then crashes (scope close) — the body may not have
      // written its processed marker. The owned fact stays pending for restart replay.
      yield* kernelWriteArm(services, executionId, id, value)
      yield* Effect.annotateCurrentSpan({ "firegrid.kwa.probe_b.marker": "armed-then-crash" })
      return parked
    }).pipe(Effect.withSpan("firegrid.kwa.probe_b.gen1_write_arm_then_crash")))

    const recovery = yield* runKernelGeneration(urls, (services) => Effect.gen(function*() {
      const autoRecovered = yield* awaitWake(services, executionId)
      const obs = yield* observeWake(services.engineTable, services.inputTable, executionId, id)
      yield* annotateObservation("probe_b_after_recovery", obs)
      yield* Effect.annotateCurrentSpan({
        "firegrid.kwa.probe_b.marker": "reconstructed-kernel-replay-rearmed",
        "firegrid.kwa.probe_b.auto_recovered": autoRecovered,
      })
      return { obs, autoRecovered }
    }).pipe(Effect.withSpan("firegrid.kwa.probe_b.gen2_reconstruct_kernel_replay")))

    return {
      probe: "B",
      beforeCrash,
      afterRecovery: recovery.obs,
      autoRecovered: recovery.autoRecovered,
      recoveredValue: recovery.obs.processedValue,
    }
  }).pipe(Effect.withSpan("firegrid.kwa.probe_b"))

// Probe C — soundness contrast. A DurableDeferred-await execution parked across
// restart, with NO kernel write+arm fact referencing it. The kernel replay must
// leave it untouched (no generic resume-all sweep — the property tf-12q9 lacked);
// its own deferredDone path still recovers it independently.
const probeC = (env: TinyFiregridHostEnv): Effect.Effect<SoundnessProbeResult, unknown> =>
  Effect.gen(function*() {
    const urls = urlsFor(env, "probe-c")
    const id = "d"
    const executionId = yield* DeferredWorkflow.executionId({ id })

    const before = yield* runKernelGeneration(urls, (services) => Effect.gen(function*() {
      yield* DeferredWorkflow.execute({ id }, { discard: true })
      const suspended = yield* isSuspended(services.engineTable, executionId)
      yield* Effect.annotateCurrentSpan({
        "firegrid.kwa.probe_c.suspended": suspended,
        "firegrid.kwa.probe_c.marker": "deferred-parked-then-crash",
      })
      return suspended
    }).pipe(Effect.withSpan("firegrid.kwa.probe_c.gen1_deferred_park_then_crash")))

    const recovery = yield* runKernelGeneration(urls, (services) => Effect.gen(function*() {
      // runKernelGeneration already ran the kernel replay. The deferred exec has
      // no owned write+arm fact, so the replay must NOT have touched it.
      const stillSuspended = yield* isSuspended(services.engineTable, executionId)
      const doneAfterReplay = yield* hasFinalResult(services.engineTable, executionId)
      yield* Effect.annotateCurrentSpan({
        "firegrid.kwa.probe_c.still_suspended_after_replay": stillSuspended,
        "firegrid.kwa.probe_c.done_after_replay": doneAfterReplay,
        "firegrid.kwa.probe_c.marker": "kernel-replay-left-deferred-untouched",
      })
      // Now its own recovery path completes it, independent of the kernel.
      yield* resolveGate("opened")
      const recoveredViaOwnPath = yield* awaitWakeDeferred(services, executionId)
      yield* Effect.annotateCurrentSpan({
        "firegrid.kwa.probe_c.recovered_via_own_path": recoveredViaOwnPath,
      })
      return { untouched: stillSuspended && !doneAfterReplay, recoveredViaOwnPath }
    }).pipe(Effect.withSpan("firegrid.kwa.probe_c.gen2_reconstruct_soundness")))

    return {
      deferredSuspendedBeforeCrash: before,
      deferredUntouchedByReplay: recovery.untouched,
      recoveredViaOwnPath: recovery.recoveredViaOwnPath,
    }
  }).pipe(Effect.withSpan("firegrid.kwa.probe_c"))

// Bounded passive wait for an execution's finalResult after kernel recovery.
const awaitWake = (services: KernelServices, executionId: string) =>
  awaitFinalResult(services.engineTable, executionId, Duration.seconds(3))

const awaitWakeDeferred = (services: KernelServices, executionId: string) =>
  awaitFinalResult(services.engineTable, executionId, Duration.seconds(3))

export const kernelOwnedWriteArmHost = (
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
