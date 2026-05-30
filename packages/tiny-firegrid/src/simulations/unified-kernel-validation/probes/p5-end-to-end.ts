/**
 * P5 — End-to-end product surface in one driver.
 *
 * Walks every capability through the unified-kernel composition in a
 * single execution: spawn → prompt input → tool dispatch → permission
 * roundtrip → permission-response input → scheduled prompt → webhook
 * ingest → peer event emit → terminal input → session completes.
 */

import type { WorkflowEngine } from "@effect/workflow"
import { Effect, Option, Ref } from "effect"
import { sendSignal } from "../signal.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../substrate.ts"
import {
  buildPermissionRoundtripLayer,
  buildToolDispatchLayer,
  makeToolExecutor,
  PERMISSION_DECISION_SIGNAL,
  type PermissionDecisionPayload,
  PermissionRoundtripWorkflow,
  ToolDispatchWorkflow,
} from "../subscribers/permission-and-tool.ts"
import {
  buildRuntimeContextSessionLayer,
  makeRuntimeContextRecorder,
  RuntimeContextSessionWorkflow,
  type SessionInputPayload,
} from "../subscribers/runtime-context.ts"
import {
  buildScheduledPromptLayer,
  emitPeerEvent,
  ScheduledPromptWorkflow,
  verifyAndIngestWebhook,
} from "../subscribers/scheduled-webhook-peer.ts"
import {
  peerEventKey,
  permissionKey,
  webhookFactKey,
} from "../tables.ts"

const encoder = new TextEncoder()

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const hmacSign = (secret: string, rawBody: Uint8Array): Effect.Effect<string, unknown> =>
  Effect.tryPromise(async () => {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      bytesToArrayBuffer(encoder.encode(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const digest = await globalThis.crypto.subtle.sign("HMAC", key, bytesToArrayBuffer(rawBody))
    return bytesToHex(new Uint8Array(digest))
  })

export interface ProbeP5E2EResult {
  readonly openPermissionRequestRecorded: boolean
  readonly sessionFinalResultPresent: boolean
  readonly spawnCount: number
  readonly sendCount: number
  readonly toolResult: string
  readonly toolInvocations: number
  readonly permDecision: string
  readonly scheduleFiredAt: string
  readonly webhookFactWritten: boolean
  readonly peerFactWritten: boolean
  readonly sessionConsumed: number
  readonly sessionTerminal: boolean
}

export const probeP5E2E = (urls: GenerationUrls): Effect.Effect<ProbeP5E2EResult, unknown> =>
  Effect.gen(function*() {
    const recorder = yield* makeRuntimeContextRecorder()
    const toolExecutor = yield* makeToolExecutor(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      (p) => JSON.stringify({ tool: p.toolName, echoed: JSON.parse(p.inputJson) }),
    )
    return yield* runGeneration(
      {
        urls,
        workflowLayers: [
          buildRuntimeContextSessionLayer(recorder),
          buildPermissionRoundtripLayer(),
          buildToolDispatchLayer(toolExecutor),
          buildScheduledPromptLayer(),
        ],
        catalog: makeCatalog([
          RuntimeContextSessionWorkflow,
          PermissionRoundtripWorkflow,
          ToolDispatchWorkflow,
          ScheduledPromptWorkflow,
        ]),
      },
      (services) =>
        Effect.gen(function*() {
          const contextId = "ctx-e2e"
          const attempt = 1

          // ── 1. Spawn the RuntimeContext session ──────────────
          const sessionExecutionId = yield* RuntimeContextSessionWorkflow.executionId({
            contextId, attempt,
          })
          const sessionFiber = yield* Effect.fork(
            RuntimeContextSessionWorkflow.execute({ contextId, attempt }),
          )

          // ── 2. Input #1: prompt ─────────────────────────────
          yield* Effect.sleep("50 millis")
          yield* sendSignal({
            signals: services.signals,
            workflow: RuntimeContextSessionWorkflow,
            executionId: sessionExecutionId,
            name: "prompt-1",
            write: () => Effect.void,
            value: {
              kind: "prompt",
              payloadJson: JSON.stringify({ text: "hello" }),
            } satisfies SessionInputPayload,
            serializeValue: (v) => JSON.stringify(v),
          })

          // ── 3. Tool dispatch (Shape D MCP-entry path) ───────
          const toolUseId = "tu-1"
          const toolResult = yield* (ToolDispatchWorkflow.execute({
            contextId, toolUseId, toolName: "echo",
            inputJson: JSON.stringify({ word: "hi" }),
          }) as Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowEngine>) as Effect.Effect<
            { readonly toolUseId: string; readonly resultJson: string },
            unknown,
            WorkflowEngine.WorkflowEngine
          >
          const toolInvocations = yield* Ref.get(toolExecutor.state.invocationCount)

          // ── 4. Permission roundtrip ─────────────────────────
          const permissionRequestId = "perm-1"
          const permKey = permissionKey(contextId, permissionRequestId)
          const permExec = yield* PermissionRoundtripWorkflow.executionId({
            contextId, permissionRequestId, toolUseId,
          })
          const permFiber = yield* Effect.fork(
            PermissionRoundtripWorkflow.execute({
              contextId, permissionRequestId, toolUseId,
            }),
          )
          yield* Effect.sleep("100 millis")
          const requestRow = yield* services.unified.permissions.get(permKey).pipe(
            Effect.map(Option.getOrUndefined),
          )
          yield* sendSignal({
            signals: services.signals,
            workflow: PermissionRoundtripWorkflow,
            executionId: permExec,
            name: PERMISSION_DECISION_SIGNAL,
            write: () => Effect.void,
            value: { decision: "allow" } satisfies PermissionDecisionPayload,
            serializeValue: (v) => JSON.stringify(v),
          })
          const permExit = yield* permFiber.await
          if (permExit._tag === "Failure") return yield* Effect.failCause(permExit.cause)
          const permResult = permExit.value as { readonly decision: string }

          // ── 5. Input #2: permission-response feeds back ─────
          yield* sendSignal({
            signals: services.signals,
            workflow: RuntimeContextSessionWorkflow,
            executionId: sessionExecutionId,
            name: "perm-response-1",
            write: () => Effect.void,
            value: {
              kind: "permission-response",
              payloadJson: JSON.stringify({ permissionRequestId, decision: permResult.decision }),
            } satisfies SessionInputPayload,
            serializeValue: (v) => JSON.stringify(v),
          })

          // ── 6. Scheduled prompt (Shape D DurableClock) ──────
          const scheduleId = "sched-1"
          const schedResult = yield* (ScheduledPromptWorkflow.execute({
            contextId, scheduleId,
            fireAtMs: Date.now() + 100,
            payloadJson: JSON.stringify({ self_prompt: "wake" }),
          }) as Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowEngine>) as Effect.Effect<
            { readonly firedAt: string },
            unknown,
            WorkflowEngine.WorkflowEngine
          >

          // ── 7. Webhook ingest (external adapter) ────────────
          const webhookSecret = "e2e-webhook-secret"
          const webhookSource = "linear"
          const deliveryId = "delivery-1"
          const webhookBody = encoder.encode(JSON.stringify({
            action: "create", type: "Issue", webhookId: deliveryId,
          }))
          const webhookSig = yield* hmacSign(webhookSecret, webhookBody)
          yield* verifyAndIngestWebhook({
            unified: services.unified,
            verify: {
              source: webhookSource, deliveryId,
              eventType: "Issue.create",
              secret: webhookSecret,
              rawBody: webhookBody,
              receivedSignatureHex: webhookSig,
            },
          })

          // ── 8. Peer event emit ──────────────────────────────
          const eventName = "plan.ready"
          const eventId = "ev-1"
          yield* emitPeerEvent({
            unified: services.unified,
            name: eventName, eventId,
            emitterContextId: contextId,
            payloadJson: JSON.stringify({ phase: "done" }),
          })

          // ── 9. Input #3: terminal ───────────────────────────
          yield* sendSignal({
            signals: services.signals,
            workflow: RuntimeContextSessionWorkflow,
            executionId: sessionExecutionId,
            name: "terminal",
            write: () => Effect.void,
            value: {
              kind: "terminal",
              payloadJson: JSON.stringify({ reason: "done" }),
            } satisfies SessionInputPayload,
            serializeValue: (v) => JSON.stringify(v),
          })

          const sessionExit = yield* sessionFiber.await
          if (sessionExit._tag === "Failure") return yield* Effect.failCause(sessionExit.cause)
          const sessionResult = sessionExit.value as {
            readonly inputsConsumed: number
            readonly reachedTerminal: boolean
          }

          // ── Final observations ──────────────────────────────
          const recordingSnapshot = yield* recorder.snapshot
          const sessionFinal = yield* services.engineTable.executions.get(
            sessionExecutionId,
          ).pipe(Effect.map(Option.getOrUndefined))
          const webhookRow = yield* services.unified.webhookFacts.get(
            webhookFactKey(webhookSource, deliveryId),
          ).pipe(Effect.map(Option.getOrUndefined))
          const peerRow = yield* services.unified.peerEvents.get(
            peerEventKey(eventName, eventId),
          ).pipe(Effect.map(Option.getOrUndefined))

          return {
            openPermissionRequestRecorded: requestRow !== undefined,
            sessionFinalResultPresent: sessionFinal?.finalResult !== undefined,
            spawnCount: recordingSnapshot.spawns.length,
            sendCount: recordingSnapshot.sends.length,
            toolResult: toolResult.resultJson,
            toolInvocations,
            permDecision: permResult.decision,
            scheduleFiredAt: schedResult.firedAt,
            webhookFactWritten: webhookRow !== undefined,
            peerFactWritten: peerRow !== undefined,
            sessionConsumed: sessionResult.inputsConsumed,
            sessionTerminal: sessionResult.reachedTerminal,
          } satisfies ProbeP5E2EResult
        }),
    )
  })
