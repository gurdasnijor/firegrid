/**
 * P4 — Scheduled prompts + webhook + peer events — runtime probes.
 *
 *   - probeP4A: scheduled prompt fires after wall-clock delay; the
 *     commitment row is present; body returns firedAt.
 *   - probeP4B: webhook ingest with valid HMAC writes a fact row and
 *     wakes a parked observer via signal.
 *   - probeP4C: webhook ingest with invalid HMAC is rejected; no fact
 *     written.
 *   - probeP4D: peer event emit wakes a parked observer via signal.
 */

import type { WorkflowEngine } from "@effect/workflow"
import { Effect, Option } from "effect"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../substrate.ts"
import {
  buildPeerEventObserverLayer,
  buildScheduledPromptLayer,
  buildWebhookFactObserverLayer,
  emitPeerEvent,
  PeerEventObserverWorkflow,
  ScheduledPromptWorkflow,
  verifyAndIngestWebhook,
  VerifiedWebhookError,
  WebhookFactObserverWorkflow,
} from "../subscribers/scheduled-webhook-peer.ts"
import { scheduleKey, webhookFactKey } from "../tables.ts"

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

export interface ProbeP4AResult {
  readonly rowPresent: boolean
  readonly firedAt: string
  readonly scheduleIdMatch: boolean
}

export const probeP4A = (urls: GenerationUrls): Effect.Effect<ProbeP4AResult, unknown> =>
  runGeneration(
    {
      urls,
      workflowLayers: [buildScheduledPromptLayer()],
      catalog: makeCatalog([ScheduledPromptWorkflow]),
    },
    (services) =>
      Effect.gen(function*() {
        const contextId = "ctx-sched"
        const scheduleId = "sched-1"
        const fireAtMs = Date.now() + 200
        const result = yield* (ScheduledPromptWorkflow.execute({
          contextId, scheduleId, fireAtMs,
          payloadJson: JSON.stringify({ self_prompt: "wake up" }),
        }) as Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowEngine>)
        const scheduleRow = yield* services.unified.schedules.get(
          scheduleKey(contextId, scheduleId),
        ).pipe(Effect.map(Option.getOrUndefined))
        const typed = result as { readonly scheduleId: string; readonly firedAt: string }
        return {
          rowPresent: scheduleRow !== undefined,
          firedAt: typed.firedAt,
          scheduleIdMatch: typed.scheduleId === scheduleId,
        } satisfies ProbeP4AResult
      }),
  )

export interface ProbeP4BResult {
  readonly ingestTag: "Inserted" | "Duplicate"
  readonly factWritten: boolean
  readonly observerFactKey: string
  readonly observerEventType: string
}

export const probeP4B = (urls: GenerationUrls): Effect.Effect<ProbeP4BResult, unknown> =>
  Effect.gen(function*() {
    const secret = "linear-test-secret"
    const source = "linear"
    const deliveryId = "delivery-42"
    const payload = JSON.stringify({ action: "create", type: "Issue", webhookId: deliveryId })
    const rawBody = encoder.encode(payload)
    const signature = yield* hmacSign(secret, rawBody)
    const observerId = `obs-${crypto.randomUUID()}`
    const factKey = webhookFactKey(source, deliveryId)

    return yield* runGeneration(
      {
        urls,
        workflowLayers: [buildWebhookFactObserverLayer()],
        catalog: makeCatalog([WebhookFactObserverWorkflow]),
      },
      (services) =>
        Effect.gen(function*() {
          const executionId = yield* WebhookFactObserverWorkflow.executionId({
            source, deliveryId, observerId,
          })
          const fiber = yield* Effect.fork(
            WebhookFactObserverWorkflow.execute({ source, deliveryId, observerId }),
          )
          yield* Effect.sleep("100 millis")

          const ingestResult = yield* verifyAndIngestWebhook({
            unified: services.unified,
            verify: {
              source, deliveryId, eventType: "Issue.create",
              secret, rawBody, receivedSignatureHex: signature,
            },
            signalOptions: {
              signals: services.signals,
              workflow: WebhookFactObserverWorkflow,
              executionId,
            },
          })

          const exit = yield* fiber.await
          if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
          const factRow = yield* services.unified.webhookFacts.get(factKey).pipe(
            Effect.map(Option.getOrUndefined),
          )
          return {
            ingestTag: ingestResult._tag,
            factWritten: factRow !== undefined,
            observerFactKey: exit.value.factKey,
            observerEventType: exit.value.eventType,
          } satisfies ProbeP4BResult
        }),
    )
  })

export interface ProbeP4CResult {
  readonly rejected: boolean
  readonly errorOp: string | undefined
  readonly factWritten: boolean
}

export const probeP4C = (urls: GenerationUrls): Effect.Effect<ProbeP4CResult, unknown> =>
  Effect.gen(function*() {
    const secret = "real-secret"
    const source = "linear"
    const deliveryId = "delivery-bad"
    const rawBody = encoder.encode(JSON.stringify({ action: "create" }))
    const wrongSignature = yield* hmacSign("WRONG-secret", rawBody)

    return yield* runGeneration(
      { urls, workflowLayers: [], catalog: makeCatalog([]) },
      (services) =>
        Effect.gen(function*() {
          const result = yield* Effect.either(
            verifyAndIngestWebhook({
              unified: services.unified,
              verify: {
                source, deliveryId, eventType: "Issue.create",
                secret, rawBody, receivedSignatureHex: wrongSignature,
              },
            }),
          )
          const factRow = yield* services.unified.webhookFacts.get(
            webhookFactKey(source, deliveryId),
          ).pipe(Effect.map(Option.getOrUndefined))
          return {
            rejected: result._tag === "Left",
            errorOp: result._tag === "Left" && result.left instanceof VerifiedWebhookError
              ? result.left.op
              : undefined,
            factWritten: factRow !== undefined,
          } satisfies ProbeP4CResult
        }),
    )
  })

export interface ProbeP4DResult {
  readonly emitTag: "Inserted" | "Duplicate"
  readonly observerName: string
  readonly observerEventId: string
  readonly observerEmitter: string
}

export const probeP4D = (urls: GenerationUrls): Effect.Effect<ProbeP4DResult, unknown> =>
  Effect.gen(function*() {
    const eventName = "plan.ready"
    const eventId = "ev-1"
    const observerId = `obs-${crypto.randomUUID()}`

    return yield* runGeneration(
      {
        urls,
        workflowLayers: [buildPeerEventObserverLayer()],
        catalog: makeCatalog([PeerEventObserverWorkflow]),
      },
      (services) =>
        Effect.gen(function*() {
          const executionId = yield* PeerEventObserverWorkflow.executionId({
            name: eventName, eventId, observerId,
          })
          const fiber = yield* Effect.fork(
            PeerEventObserverWorkflow.execute({ name: eventName, eventId, observerId }),
          )
          yield* Effect.sleep("100 millis")

          const emitResult = yield* emitPeerEvent({
            unified: services.unified,
            name: eventName,
            eventId,
            emitterContextId: "ctx-emit",
            payloadJson: JSON.stringify({ phase: "planning" }),
            signalOptions: {
              signals: services.signals,
              workflow: PeerEventObserverWorkflow,
              executionId,
            },
          })

          const exit = yield* fiber.await
          if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
          return {
            emitTag: emitResult._tag,
            observerName: exit.value.name,
            observerEventId: exit.value.eventId,
            observerEmitter: exit.value.emitterContextId,
          } satisfies ProbeP4DResult
        }),
    )
  })
