/**
 * P2 — RuntimeContext session as workflow body — runtime probes.
 *
 *   - probeP2A: concurrent executes for the same (contextId, attempt)
 *     admit one body. Activity-memoized spawn fires once; per-position
 *     send activities run once.
 *   - probeP2B: input arrival via `sendSignal` after the body parks.
 *     Recorder sees each delivery exactly once.
 *   - probeP2C: crash recovery. Gen-1 records a terminal signal
 *     without resuming; gen-2 recovery re-arms, body completes,
 *     spawn Activity is memoized so the fresh gen-2 recorder sees
 *     zero spawn side effects.
 */

import type { WorkflowEngine } from "@effect/workflow"
import { Duration, Effect, Exit } from "effect"
import { sendSignal, type SignalTableService } from "../signal.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../substrate.ts"
import {
  buildRuntimeContextSessionLayer,
  makeRuntimeContextRecorder,
  RuntimeContextSessionWorkflow,
  type SessionInputPayload,
} from "../subscribers/runtime-context.ts"
import { awaitFinalLanded } from "./_helpers.ts"

const inputPayload = (text: string) => JSON.stringify({ text })

const sendInput = (options: {
  readonly signals: SignalTableService
  readonly executionId: string
  readonly inputId: string
  readonly kind: SessionInputPayload["kind"]
  readonly payloadJson: string
}) =>
  sendSignal({
    signals: options.signals,
    workflow: RuntimeContextSessionWorkflow,
    executionId: options.executionId,
    name: options.inputId,
    write: () => Effect.void,
    value: { kind: options.kind, payloadJson: options.payloadJson } satisfies SessionInputPayload,
    serializeValue: (v) => JSON.stringify(v),
  })

const setupFor = (
  urls: GenerationUrls,
  recorder: ReturnType<typeof makeRuntimeContextRecorder> extends Effect.Effect<infer R> ? R : never,
) => ({
  urls,
  workflowLayers: [buildRuntimeContextSessionLayer(recorder)],
  catalog: makeCatalog([RuntimeContextSessionWorkflow]),
})

export interface ProbeP2AResult {
  readonly spawns: number
  readonly sends: number
  readonly inputsConsumed1: number
  readonly inputsConsumed2: number
  readonly reachedTerminal1: boolean
  readonly reachedTerminal2: boolean
}

export const probeP2A = (urls: GenerationUrls): Effect.Effect<ProbeP2AResult, unknown> =>
  Effect.gen(function*() {
    const recorder = yield* makeRuntimeContextRecorder()
    return yield* runGeneration(
      setupFor(urls, recorder),
      (services) =>
        Effect.gen(function*() {
          const contextId = "ctx-single"
          const attempt = 1
          const executionId = yield* RuntimeContextSessionWorkflow.executionId({
            contextId, attempt,
          })
          yield* sendInput({
            signals: services.signals,
            executionId,
            inputId: "in-1",
            kind: "prompt",
            payloadJson: inputPayload("hello"),
          })
          yield* sendInput({
            signals: services.signals,
            executionId,
            inputId: "in-term",
            kind: "terminal",
            payloadJson: inputPayload("done"),
          })

          const both = yield* Effect.all(
            [
              RuntimeContextSessionWorkflow.execute({ contextId, attempt }),
              RuntimeContextSessionWorkflow.execute({ contextId, attempt }),
            ],
            { concurrency: 2 },
          ).pipe(Effect.orDie)
          const snapshot = yield* recorder.snapshot
          return {
            spawns: snapshot.spawns.length,
            sends: snapshot.sends.length,
            inputsConsumed1: both[0].inputsConsumed,
            inputsConsumed2: both[1].inputsConsumed,
            reachedTerminal1: both[0].reachedTerminal,
            reachedTerminal2: both[1].reachedTerminal,
          } satisfies ProbeP2AResult
        }),
    )
  })

export interface ProbeP2BResult {
  readonly spawns: number
  readonly sends: number
  readonly finalLanded: boolean
}

export const probeP2B = (urls: GenerationUrls): Effect.Effect<ProbeP2BResult, unknown> =>
  Effect.gen(function*() {
    const recorder = yield* makeRuntimeContextRecorder()
    return yield* runGeneration(
      setupFor(urls, recorder),
      (services) =>
        Effect.gen(function*() {
          const contextId = "ctx-arrival"
          const attempt = 1
          const executionId = yield* RuntimeContextSessionWorkflow.executionId({
            contextId, attempt,
          })

          const fiber = yield* Effect.fork(
            RuntimeContextSessionWorkflow.execute({ contextId, attempt }),
          )
          yield* Effect.sleep("100 millis")

          yield* sendInput({
            signals: services.signals,
            executionId, inputId: "i-1", kind: "prompt",
            payloadJson: inputPayload("one"),
          })
          yield* sendInput({
            signals: services.signals,
            executionId, inputId: "i-2", kind: "prompt",
            payloadJson: inputPayload("two"),
          })
          yield* sendInput({
            signals: services.signals,
            executionId, inputId: "i-3", kind: "terminal",
            payloadJson: inputPayload("three-terminal"),
          })

          const exit = yield* fiber.await
          if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
          const snapshot = yield* recorder.snapshot
          const finalLanded = yield* awaitFinalLanded(
            services.engineTable,
            executionId,
            Duration.seconds(3),
          )
          return {
            spawns: snapshot.spawns.length,
            sends: snapshot.sends.length,
            finalLanded,
          } satisfies ProbeP2BResult
        }),
    )
  })

export interface ProbeP2CResult {
  readonly recoveredFinalLanded: boolean
  readonly gen2Spawns: number
  readonly gen2Sends: number
  readonly replayed: number
}

export const probeP2C = (urls: GenerationUrls): Effect.Effect<ProbeP2CResult, unknown> =>
  Effect.gen(function*() {
    const contextId = "ctx-crash"
    const attempt = 1
    let executionId = ""

    const gen1Recorder = yield* makeRuntimeContextRecorder()
    yield* runGeneration(
      setupFor(urls, gen1Recorder),
      (services) =>
        Effect.gen(function*() {
          executionId = yield* RuntimeContextSessionWorkflow.executionId({
            contextId, attempt,
          })
          yield* Effect.fork(
            RuntimeContextSessionWorkflow.execute({ contextId, attempt }),
          )
          yield* Effect.sleep("100 millis")
          // Record the terminal signal — NO resume.
          yield* services.signals.signals.insertOrGet({
            signalKey: `${executionId}|terminal`,
            workflowName: RuntimeContextSessionWorkflow.name,
            executionId,
            name: "terminal",
            payloadJson: JSON.stringify({
              kind: "terminal",
              payloadJson: inputPayload("terminal-payload"),
            } satisfies SessionInputPayload),
            recordedAt: new Date().toISOString(),
          }).pipe(Effect.orDie)
          yield* Effect.sleep("50 millis")
        }) as Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine>,
    )

    const gen2Recorder = yield* makeRuntimeContextRecorder()
    return yield* runGeneration(
      setupFor(urls, gen2Recorder),
      (services) =>
        Effect.gen(function*() {
          const finalLanded = yield* awaitFinalLanded(
            services.engineTable, executionId, Duration.seconds(5),
          )
          const snapshot = yield* gen2Recorder.snapshot
          return {
            recoveredFinalLanded: finalLanded,
            gen2Spawns: snapshot.spawns.length,
            gen2Sends: snapshot.sends.length,
            replayed: services.replayed,
          } satisfies ProbeP2CResult
        }),
    )
  })
