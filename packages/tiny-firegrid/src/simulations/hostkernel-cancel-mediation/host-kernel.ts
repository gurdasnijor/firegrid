/**
 * tf-r06u.46 — HostKernel cancel-mediation spike: the kernel workflow.
 *
 * `kernel-owned-write-arm.md` says there is no concrete `HostKernelWorkflow`
 * today — it's a target ROLE: a host-side serialized controller that
 * exclusively owns RuntimeContextWorkflow lifecycle. This spike builds the
 * narrowest concrete instance on the unified substrate to validate the
 * MEDIATION: a long-running kernel workflow that, on a cancel/close signal,
 * drives a per-context `RuntimeContextSessionWorkflow` to TERMINAL by emitting
 * its EXISTING terminal input (runtime-context.ts:124, `kind === "terminal"`).
 * It does NOT invent a new terminal — it proves the kernel can EMIT the
 * terminal signal.
 *
 * Router/driver = thin dispatch-intent: it signals the kernel with a
 * `CancelIntent`; the kernel (not the router, not the session workflow itself)
 * owns the lifecycle transition. The kernel-owned write+arm is exactly
 * `sendSignal` (write the workflow-owned signal row + `resume`), with the
 * emitted terminal keyed by a DETERMINISTIC signal name so a re-delivered
 * cancel (replay) dedups via `insertOrGet` → exactly-once. That durable
 * identity is the DUAL of the .44 emitter durability finding.
 */

import { Workflow, WorkflowEngine } from "@effect/workflow"
import { Effect, type ParseResult, Schema } from "effect"
import {
  readSignalsFor,
  RuntimeContextSessionWorkflow,
  type SessionInputPayload,
  sendSignal,
  SignalTable,
} from "@firegrid/runtime/unified"

/** A cancel/close intent the router dispatches to the kernel. */
export const CancelIntentSchema = Schema.Struct({
  targetContextId: Schema.String,
  targetAttempt: Schema.Number,
  /** Stable id of this cancel request (dedups the intent at the kernel). */
  requestId: Schema.String,
})
export type CancelIntent = Schema.Schema.Type<typeof CancelIntentSchema>

export const HostKernelCancelPayloadSchema = Schema.Struct({
  kernelId: Schema.String,
})
export type HostKernelCancelPayload = Schema.Schema.Type<typeof HostKernelCancelPayloadSchema>

export const HostKernelCancelResultSchema = Schema.Struct({
  kernelId: Schema.String,
  cancelsEmitted: Schema.Number,
})

// The kernel is the exclusive lifecycle owner — a long-running serialized
// controller, idempotency-keyed on its own id (one kernel per host).
export const HostKernelCancelWorkflow = Workflow.make({
  name: "spike.host-kernel-cancel",
  payload: HostKernelCancelPayloadSchema,
  success: HostKernelCancelResultSchema,
  idempotencyKey: (p) => p.kernelId,
})

const decodeCancelIntent = Schema.decodeUnknown(CancelIntentSchema)

// Deterministic name for the terminal input the kernel emits to a target.
// Keyed on the target identity (not the requestId) so ANY cancel for the same
// target emits the SAME signal → insertOrGet dedups → exactly-once terminal.
const kernelTerminalSignalName = (contextId: string, attempt: number): string =>
  `kernel-terminal:${contextId}:${attempt}`

const terminalInput = (requestId: string): SessionInputPayload => ({
  kind: "terminal",
  payloadJson: JSON.stringify({ reason: "cancel", requestId }),
})

const body = (
  payload: HostKernelCancelPayload,
  executionId: string,
) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const signals = yield* SignalTable

    // Long-running exclusive owner: drain cancel intents, park when caught up.
    let consumed = 0
    while (true) {
      const rows = yield* readSignalsFor(signals, executionId).pipe(Effect.orDie)
      if (consumed >= rows.length) {
        yield* Effect.annotateCurrentSpan({
          "firegrid.spike.kernel.decision": "suspend",
          "firegrid.spike.kernel.cursor": consumed,
        })
        yield* Workflow.suspend(instance)
        return yield* Effect.never
      }
      while (consumed < rows.length) {
        const cursor = consumed
        const intent = yield* decodeCancelIntent(
          JSON.parse(rows[cursor]!.payloadJson) as unknown,
        ).pipe(
          Effect.mapError((e: ParseResult.ParseError) =>
            new Error(`malformed cancel intent at cursor ${cursor}: ${e.message}`)),
          Effect.orDie,
        )
        const targetExecutionId = yield* RuntimeContextSessionWorkflow.executionId({
          contextId: intent.targetContextId,
          attempt: intent.targetAttempt,
        })
        // Kernel-owned write+arm: emit the EXISTING terminal input to the
        // target session workflow. Deterministic signal name → idempotent.
        yield* sendSignal({
          signals,
          workflow: RuntimeContextSessionWorkflow,
          executionId: targetExecutionId,
          name: kernelTerminalSignalName(intent.targetContextId, intent.targetAttempt),
          write: () => Effect.void,
          value: terminalInput(intent.requestId),
          serializeValue: (v) => JSON.stringify(v),
        }).pipe(Effect.orDie)
        consumed += 1
      }
    }
  }) as Effect.Effect<
    Schema.Schema.Type<typeof HostKernelCancelResultSchema>,
    never,
    SignalTable | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
  >

export const HostKernelCancelWorkflowLayer = HostKernelCancelWorkflow.toLayer(body)

/** Thin dispatch-intent: the router signals the kernel with a cancel intent.
 * It owns NO lifecycle — it only delivers the intent (deterministic name =
 * requestId → the intent itself dedups at the kernel). */
export const dispatchCancelIntent = (options: {
  readonly signals: SignalTable["Type"]
  readonly kernelExecutionId: string
  readonly intent: CancelIntent
}): Effect.Effect<void, unknown, WorkflowEngine.WorkflowEngine> =>
  sendSignal({
    signals: options.signals,
    workflow: HostKernelCancelWorkflow,
    executionId: options.kernelExecutionId,
    name: `cancel-intent:${options.intent.requestId}`,
    write: () => Effect.void,
    value: options.intent,
    serializeValue: (v) => JSON.stringify(v),
  })
