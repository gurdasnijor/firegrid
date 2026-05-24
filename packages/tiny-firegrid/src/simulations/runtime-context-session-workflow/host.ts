import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Duration, Effect, Layer, Ref, Stream } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"
import {
  type GenerationUrls,
  kernelWriteArm,
  type KernelServices,
  type RcswPayload,
  type RecordingState,
  RecordingSessionAdapter,
  recordingSessionAdapterLayer,
  runRcswGeneration,
  RuntimeContextSessionWorkflow,
} from "./workflow.ts"

export interface RcswProbeResult {
  readonly probe: string
  readonly recording: RecordingState
  readonly inputsConsumed: number
  readonly notes: ReadonlyArray<string>
}

interface RcswRuntime {
  readonly runProbeA: Effect.Effect<RcswProbeResult, unknown>
  readonly runProbeB: Effect.Effect<RcswProbeResult, unknown>
  readonly runProbeC: Effect.Effect<RcswProbeResult, unknown>
}

const runtimeLatch = (() => {
  let resolveRuntime: (runtime: RcswRuntime) => void = () => undefined
  const promise = new Promise<RcswRuntime>((resolve) => {
    resolveRuntime = resolve
  })
  return { promise, resolve: resolveRuntime }
})()

export const rcswRuntime = runtimeLatch.promise

const urlsFor = (env: TinyFiregridHostEnv, probe: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.rcsw.${env.runId}.${probe}.engine`,
  ),
  inputStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.rcsw.${env.runId}.${probe}.input`,
  ),
  kernelStreamUrl: durableStreamUrl(
    env.durableStreamsBaseUrl,
    `${env.namespace}.rcsw.${env.runId}.${probe}.kernel`,
  ),
})

// Bounded passive wait for an execution to gain a finalResult — same idiom as
// kernel-owned-write-arm's `awaitFinalResult`. Used by probe C to await each
// resume without busy-polling.
const awaitFinalResult = (
  engineTable: KernelServices["engineTable"],
  executionId: string,
  timeout: Duration.DurationInput,
) =>
  engineTable.executions.get(executionId).pipe(
    Effect.flatMap((opt) =>
      opt._tag === "Some" && opt.value.finalResult !== undefined
        ? Effect.succeed(true)
        : engineTable.executions.rows().pipe(
          Stream.filter((row) =>
            row.executionId === executionId && row.finalResult !== undefined),
          Stream.runHead,
          Effect.map((o) => o._tag === "Some"),
          Effect.timeoutTo({
            duration: timeout,
            onTimeout: () => false,
            onSuccess: (found) => found,
          }),
        ),
    ),
  )

// === Probe A: early-input-then-start =======================================
// Append an input row BEFORE executing the workflow. Body must spawn once and
// consume the pre-existing input.
const probeA = (env: TinyFiregridHostEnv): Effect.Effect<RcswProbeResult, unknown> =>
  Effect.gen(function*() {
    const urls = urlsFor(env, "probe-a")
    const recording = recordingSessionAdapterLayer
    const recordingRef = yield* Ref.make<RecordingState>({ spawns: [], sends: [] })
    const sharedRecording = Layer.succeed(RecordingSessionAdapter, recordingRef)
    const payload: RcswPayload = {
      contextId: "ctx-A",
      activityAttempt: 1,
      expectedInputs: 1,
    }
    const inputId = "input-A0"
    return yield* runRcswGeneration(urls, sharedRecording, (services) =>
      Effect.gen(function*() {
        // Pre-write the input row BEFORE executing the workflow.
        const executionId = yield* RuntimeContextSessionWorkflow.executionId(payload)
        yield* services.factTable.facts.insertOrGet({
          factKey: `${executionId}|0`,
          executionId,
          contextId: payload.contextId,
          activityAttempt: payload.activityAttempt,
          sequence: 0,
          inputId,
          value: "early",
          status: "pending",
        })
        yield* services.inputTable.inputs.insertOrGet({
          inputKey: `${payload.contextId}:${payload.activityAttempt}:0`,
          contextId: payload.contextId,
          activityAttempt: payload.activityAttempt,
          sequence: 0,
          inputId,
          value: "early",
        })
        // Execute synchronously to finalResult.
        const result = yield* RuntimeContextSessionWorkflow.execute(payload)
        const state = yield* Ref.get(recordingRef)
        return {
          probe: "A",
          recording: state,
          inputsConsumed: result.inputsConsumed,
          notes: [
            `executionId=${executionId}`,
            `spawn_count=${state.spawns.length}`,
            `send_count=${state.sends.length}`,
            `first_send_input=${state.sends[0]?.inputId ?? "(none)"}`,
          ],
        }
      })).pipe(Effect.scoped, Effect.provide(recording))
  }).pipe(Effect.withSpan("firegrid.rcsw.probe_a"))

// === Probe B: concurrent-execute-no-dual-spawn =============================
// Two concurrent `Workflow.execute(payload)` calls with the same payload (=
// same idempotencyKey). Must collapse to one execution and one spawn.
const probeB = (env: TinyFiregridHostEnv): Effect.Effect<RcswProbeResult, unknown> =>
  Effect.gen(function*() {
    const urls = urlsFor(env, "probe-b")
    const recording = recordingSessionAdapterLayer
    const recordingRef = yield* Ref.make<RecordingState>({ spawns: [], sends: [] })
    const sharedRecording = Layer.succeed(RecordingSessionAdapter, recordingRef)
    const payload: RcswPayload = {
      contextId: "ctx-B",
      activityAttempt: 1,
      expectedInputs: 1,
    }
    return yield* runRcswGeneration(urls, sharedRecording, (services) =>
      Effect.gen(function*() {
        const executionId = yield* RuntimeContextSessionWorkflow.executionId(payload)
        // Pre-write the input so both executes can complete instead of suspend.
        yield* services.inputTable.inputs.insertOrGet({
          inputKey: `${payload.contextId}:${payload.activityAttempt}:0`,
          contextId: payload.contextId,
          activityAttempt: payload.activityAttempt,
          sequence: 0,
          inputId: "input-B0",
          value: "shared",
        })
        // Race two executes. Same idempotencyKey ⇒ engine collapses to ONE
        // execution. Both fibers see the same finalResult.
        const both = yield* Effect.all(
          [
            RuntimeContextSessionWorkflow.execute(payload),
            RuntimeContextSessionWorkflow.execute(payload),
          ],
          { concurrency: "unbounded" },
        )
        const state = yield* Ref.get(recordingRef)
        return {
          probe: "B",
          recording: state,
          inputsConsumed: Math.max(both[0].inputsConsumed, both[1].inputsConsumed),
          notes: [
            `executionId=${executionId}`,
            `spawn_count=${state.spawns.length}`,
            `send_count=${state.sends.length}`,
            `result_a=${JSON.stringify(both[0])}`,
            `result_b=${JSON.stringify(both[1])}`,
          ],
        }
      })).pipe(Effect.scoped, Effect.provide(recording))
  }).pipe(Effect.withSpan("firegrid.rcsw.probe_b"))

// === Probe C: post-start-input-in-order ====================================
// Execute first; body suspends on empty input cursor. Kernel write+arm
// delivers three inputs in order. Body consumes them in append order, each
// via one Activity send, spawn still == 1.
const probeC = (env: TinyFiregridHostEnv): Effect.Effect<RcswProbeResult, unknown> =>
  Effect.gen(function*() {
    const urls = urlsFor(env, "probe-c")
    const recording = recordingSessionAdapterLayer
    const recordingRef = yield* Ref.make<RecordingState>({ spawns: [], sends: [] })
    const sharedRecording = Layer.succeed(RecordingSessionAdapter, recordingRef)
    const payload: RcswPayload = {
      contextId: "ctx-C",
      activityAttempt: 1,
      expectedInputs: 3,
    }
    return yield* runRcswGeneration(urls, sharedRecording, (services) =>
      Effect.gen(function*() {
        const executionId = yield* RuntimeContextSessionWorkflow.executionId(payload)
        // Start (discard); body suspends on first cursor miss.
        yield* RuntimeContextSessionWorkflow.execute(payload, { discard: true })
        // Append + arm three inputs in order. Each arm wakes the body to
        // consume that single input then suspend again.
        const inputs = [
          { sequence: 0, inputId: "C-0", value: "alpha" },
          { sequence: 1, inputId: "C-1", value: "beta" },
          { sequence: 2, inputId: "C-2", value: "gamma" },
        ] as const
        let index = 0
        while (index < inputs.length) {
          yield* kernelWriteArm(services, executionId, payload, inputs[index]!)
          index += 1
        }
        // Wait for finalResult (body terminates after consuming expectedInputs).
        const done = yield* awaitFinalResult(
          services.engineTable,
          executionId,
          Duration.seconds(5),
        )
        if (!done) {
          return yield* Effect.fail(
            new Error("probe C: workflow did not reach finalResult within 5s"),
          )
        }
        const state = yield* Ref.get(recordingRef)
        return {
          probe: "C",
          recording: state,
          inputsConsumed: state.sends.length,
          notes: [
            `executionId=${executionId}`,
            `spawn_count=${state.spawns.length}`,
            `send_count=${state.sends.length}`,
            `send_order=${state.sends.map((s) => s.inputId).join(",")}`,
          ],
        }
      })).pipe(Effect.scoped, Effect.provide(recording))
  }).pipe(Effect.withSpan("firegrid.rcsw.probe_c"))

export const runtimeContextSessionWorkflowHost = (
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
