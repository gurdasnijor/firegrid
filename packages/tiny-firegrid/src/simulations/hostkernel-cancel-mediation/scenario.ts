/**
 * tf-r06u.46 — HostKernel cancel-mediation spike scenario.
 *
 * Composes the REAL unified `RuntimeContextSessionWorkflow` (+ a fake codec
 * adapter) with the spike `HostKernelCancelWorkflow`, on a real
 * `DurableStreamsWorkflowEngine`. One pass:
 *   1. start the kernel (parks awaiting cancel intents) + the per-context
 *      session workflow (spawns, then parks awaiting inputs);
 *   2. router = thin: dispatch a `CancelIntent` to the kernel;
 *   3. the kernel emits the EXISTING terminal input to the session workflow;
 *   4. await the session workflow's terminal (re-execute = memoized result).
 *
 * Returns the proof observations (does not draw conclusions). The test runs
 * this twice over the SAME durable streams + ids = the replay boundary +
 * exactly-once assertion.
 */

import {
  DurableStreamsWorkflowEngine,
  WorkflowEngineTable,
} from "@firegrid/runtime/engine/durable-streams-workflow-engine"
import {
  recoverPendingSignals,
  RuntimeContextSessionWorkflow,
  RuntimeContextSessionWorkflowLayer,
  RuntimeOutputTable,
  SignalTable,
  UnifiedTable,
  type WorkflowCatalog,
} from "@firegrid/runtime/unified"
import { Duration, Effect, Layer } from "effect"
import { buildFakeCodecAdapter } from "../unified-kernel-validation/fake-codec.ts"
import {
  dispatchCancelIntent,
  HostKernelCancelWorkflow,
  HostKernelCancelWorkflowLayer,
} from "./host-kernel.ts"

export interface CancelMediationUrls {
  readonly unifiedTableStreamUrl: string
  readonly signalTableStreamUrl: string
  readonly outputTableStreamUrl: string
  readonly engineStreamUrl: string
}

export interface CancelMediationIds {
  readonly contextId: string
  readonly attempt: number
  readonly kernelId: string
  readonly requestId: string
}

export interface CancelMediationResult {
  readonly reachedTerminal: boolean
  readonly inputsConsumed: number
}

const streamOptions = (url: string) => ({
  streamOptions: { url, contentType: "application/json" as const },
  txTimeoutMs: 2_000,
})

// Recovery catalog: the two workflows this scenario runs. recoverPendingSignals
// re-arms any workflow that has pending durable signals after a restart — the
// replay-boundary path.
const catalog: WorkflowCatalog = {
  get: (name) =>
    name === RuntimeContextSessionWorkflow.name
      ? RuntimeContextSessionWorkflow
      : name === HostKernelCancelWorkflow.name
        ? HostKernelCancelWorkflow
        : undefined,
}

export const cancelMediationScenario = (
  urls: CancelMediationUrls,
  ids: CancelMediationIds,
): Effect.Effect<CancelMediationResult, unknown> =>
  Effect.gen(function*() {
    const { layer: fakeCodecLayer } = yield* buildFakeCodecAdapter()

    const substrateLayer = Layer.mergeAll(
      UnifiedTable.layer(streamOptions(urls.unifiedTableStreamUrl)),
      SignalTable.layer(streamOptions(urls.signalTableStreamUrl)),
      RuntimeOutputTable.layer(streamOptions(urls.outputTableStreamUrl)),
    )
    const engineLayer = DurableStreamsWorkflowEngine.layer({
      streamUrl: urls.engineStreamUrl,
    })
    const upperLayers = Layer.mergeAll(
      RuntimeContextSessionWorkflowLayer.pipe(Layer.provide(fakeCodecLayer)),
      HostKernelCancelWorkflowLayer,
    )
    const generationLayer = upperLayers.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(substrateLayer),
    )

    return yield* Effect.scoped(
      Effect.gen(function*() {
        const engineTable = yield* WorkflowEngineTable
        const signals = yield* SignalTable
        // Replay-boundary recovery: re-arm anything with pending signals.
        yield* recoverPendingSignals({ signals, engineTable, catalog })

        const sessionPayload = { contextId: ids.contextId, attempt: ids.attempt }
        const kernelExecutionId = yield* HostKernelCancelWorkflow.executionId({
          kernelId: ids.kernelId,
        })

        // Start the kernel (exclusive lifecycle owner) and the session; both
        // park awaiting signals.
        yield* Effect.fork(HostKernelCancelWorkflow.execute({ kernelId: ids.kernelId }))
        yield* Effect.fork(RuntimeContextSessionWorkflow.execute(sessionPayload))
        yield* Effect.sleep(Duration.millis(150))

        // Router = thin dispatch-intent: signal the kernel a cancel intent.
        // The kernel — not the router, not the session itself — drives the
        // lifecycle transition.
        yield* dispatchCancelIntent({
          signals,
          kernelExecutionId,
          intent: {
            targetContextId: ids.contextId,
            targetAttempt: ids.attempt,
            requestId: ids.requestId,
          },
        }).pipe(Effect.orDie)

        // Await the session's terminal (re-execute returns the memoized result
        // once reachedTerminal). This blocks until the kernel-emitted terminal
        // is consumed.
        const result = yield* RuntimeContextSessionWorkflow.execute(sessionPayload)
        return {
          reachedTerminal: result.reachedTerminal,
          inputsConsumed: result.inputsConsumed,
        }
      }).pipe(Effect.provide(generationLayer)),
    )
  })
