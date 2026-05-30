/**
 * Scheduled prompts + external adapters (webhook + peer event).
 *
 * 1. `ScheduledPromptWorkflow` — the one genuine Shape D admission
 *    that survives in the unified model: `DurableClock.sleep` for a
 *    wall-clock wakeup, then mark the schedule fired.
 * 2. `verifyAndIngestWebhook` — host-side helper that verifies an HMAC
 *    on raw bytes, decodes JSON, writes a `webhookFacts` row, and
 *    optionally kernel-arms `WebhookFactObserverWorkflow`. HMAC +
 *    idempotency shape mirrors `makeVerifiedWebhookSource` in
 *    production.
 * 3. `emitPeerEvent` — host helper that writes a `peerEvents` row and
 *    optionally kernel-arms `PeerEventObserverWorkflow`.
 * 4. `WebhookFactObserverWorkflow` — specialized observer for a
 *    `(source, deliveryId)` webhook fact. Parks on `Workflow.suspend`;
 *    kernel arm wakes; returns the row.
 * 5. `PeerEventObserverWorkflow` — specialized observer for a
 *    `(name, eventId)` peer event.
 *
 * Each observer is specialized to its fact family. There is no
 * "wait_for any fact" workflow in the simulation — string-dispatch
 * over a fact-table name reconstructs the retired SourceCollections
 * pattern.
 */

import {
  Activity,
  DurableClock,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import { Data, Duration, Effect, Option, Schema } from "effect"
import {
  kernelWriteArm,
  type KernelCommandTableService,
  type ResumableWorkflow,
} from "../kernel.ts"
import {
  peerEventKey,
  scheduleKey,
  UnifiedTable,
  type UnifiedTableService,
  webhookFactKey,
} from "../tables.ts"

// ── 1. ScheduledPromptWorkflow ──────────────────────────────────────────────

export const ScheduledPromptPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  scheduleId: Schema.String,
  fireAtMs: Schema.Number,
  payloadJson: Schema.String,
})
export type ScheduledPromptPayload = Schema.Schema.Type<typeof ScheduledPromptPayloadSchema>

export const ScheduledPromptResultSchema = Schema.Struct({
  scheduleId: Schema.String,
  firedAt: Schema.String,
})

export const ScheduledPromptWorkflow = Workflow.make({
  name: "unified.scheduled-prompt",
  payload: ScheduledPromptPayloadSchema,
  success: ScheduledPromptResultSchema,
  idempotencyKey: (p) => `${p.contextId}:${p.scheduleId}`,
})

const scheduledPromptBody = (payload: ScheduledPromptPayload) =>
  Effect.gen(function*() {
    const table = yield* UnifiedTable
    const key = scheduleKey(payload.contextId, payload.scheduleId)

    // Record the commitment (idempotent — first execute creates it).
    yield* Activity.make({
      name: `unified.scheduled.record/${key}`,
      success: Schema.Void,
      execute: table.schedules.insertOrGet({
        scheduleKey: key,
        contextId: payload.contextId,
        fireAtMs: payload.fireAtMs,
        payloadJson: payload.payloadJson,
        status: "pending",
      }).pipe(Effect.orDie, Effect.asVoid),
    })

    // DurableClock — the engine recovers this on reconstruction via
    // recoverPendingClockWakeups. The one safely-parked binding.
    const now = Date.now()
    const delay = Math.max(0, payload.fireAtMs - now)
    yield* DurableClock.sleep({
      name: `unified.scheduled-prompt/${key}`,
      duration: Duration.millis(delay),
      inMemoryThreshold: Duration.zero,
    })

    // Mark the schedule fired.
    const firedAt = new Date().toISOString()
    yield* Activity.make({
      name: `unified.scheduled.fire/${key}`,
      success: Schema.Void,
      execute: table.schedules.upsert({
        scheduleKey: key,
        contextId: payload.contextId,
        fireAtMs: payload.fireAtMs,
        payloadJson: payload.payloadJson,
        status: "fired",
        firedAt,
      }).pipe(Effect.orDie, Effect.asVoid),
    })

    return { scheduleId: payload.scheduleId, firedAt }
  })

export const buildScheduledPromptLayer = () =>
  ScheduledPromptWorkflow.toLayer(scheduledPromptBody)

// ── 2. Webhook ingest (host-side helper) ────────────────────────────────────

export interface VerifyWebhookOptions {
  readonly source: string
  readonly deliveryId: string
  readonly eventType: string
  readonly secret: string | Uint8Array
  readonly rawBody: Uint8Array
  readonly receivedSignatureHex: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const hexToBytes = (hex: string): Uint8Array | undefined => {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    const parsed = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (!Number.isFinite(parsed)) return undefined
    bytes[i] = parsed
  }
  return bytes
}

const constantTimeHexEquals = (left: string, right: string): boolean => {
  const l = hexToBytes(left)
  const r = hexToBytes(right)
  if (l === undefined || r === undefined) return false
  const len = Math.max(l.length, r.length)
  let diff = l.length === r.length ? 0 : 1
  for (let i = 0; i < len; i += 1) diff |= (l[i] ?? 0) ^ (r[i] ?? 0)
  return diff === 0
}

const hmacSha256Hex = (
  secret: string | Uint8Array,
  rawBody: Uint8Array,
): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        bytesToArrayBuffer(typeof secret === "string" ? encoder.encode(secret) : secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      )
      const digest = await globalThis.crypto.subtle.sign(
        "HMAC",
        key,
        bytesToArrayBuffer(rawBody),
      )
      return bytesToHex(new Uint8Array(digest))
    },
    catch: (e) => e as Error,
  })

export class VerifiedWebhookError extends Data.TaggedError("VerifiedWebhookError")<{
  readonly message: string
  readonly op: string
}> {}

export interface VerifyAndIngestResult {
  readonly _tag: "Inserted" | "Duplicate"
  readonly factKey: string
}

/**
 * Verify HMAC + write a webhookFacts row. Idempotent on `(source,
 * deliveryId)`: a duplicate delivery returns `_tag: "Duplicate"`.
 *
 * If `armOptions` is provided, also calls kernelWriteArm to wake a
 * waiting `WebhookFactObserverWorkflow` body.
 */
export const verifyAndIngestWebhook = (options: {
  readonly unified: UnifiedTableService
  readonly verify: VerifyWebhookOptions
  readonly armOptions?: {
    readonly kernel: KernelCommandTableService
    readonly workflow: ResumableWorkflow
    readonly executionId: string
  }
}): Effect.Effect<VerifyAndIngestResult, VerifiedWebhookError, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const expected = yield* hmacSha256Hex(
      options.verify.secret,
      options.verify.rawBody,
    ).pipe(
      Effect.mapError(
        (e) =>
          new VerifiedWebhookError({
            message: `HMAC digest failed: ${String(e)}`,
            op: "signature/digest",
          }),
      ),
    )
    if (!constantTimeHexEquals(expected, options.verify.receivedSignatureHex)) {
      return yield* Effect.fail(
        new VerifiedWebhookError({
          message: "invalid signature",
          op: "signature/invalid",
        }),
      )
    }
    const factKey = webhookFactKey(options.verify.source, options.verify.deliveryId)
    const existing = yield* options.unified.webhookFacts.get(factKey).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orDie,
    )
    if (existing !== undefined) {
      return { _tag: "Duplicate" as const, factKey }
    }
    const payloadJson = decoder.decode(options.verify.rawBody)
    yield* options.unified.webhookFacts.insertOrGet({
      factKey,
      source: options.verify.source,
      deliveryId: options.verify.deliveryId,
      eventType: options.verify.eventType,
      payloadJson,
      receivedAt: new Date().toISOString(),
    }).pipe(Effect.orDie)
    if (options.armOptions !== undefined) {
      yield* kernelWriteArm({
        kernel: options.armOptions.kernel,
        workflow: options.armOptions.workflow,
        executionId: options.armOptions.executionId,
        inputTable: "webhookFacts",
        inputKey: factKey,
        write: () => Effect.void, // row already written above
        value: { factKey, source: options.verify.source, deliveryId: options.verify.deliveryId },
        serializeValue: (v) => JSON.stringify(v),
      }).pipe(Effect.orDie)
    }
    return { _tag: "Inserted" as const, factKey }
  })

// ── 3. Peer event emit (host-side) ──────────────────────────────────────────

export const emitPeerEvent = (options: {
  readonly unified: UnifiedTableService
  readonly name: string
  readonly eventId: string
  readonly emitterContextId: string
  readonly payloadJson: string
  readonly armOptions?: {
    readonly kernel: KernelCommandTableService
    readonly workflow: ResumableWorkflow
    readonly executionId: string
  }
}): Effect.Effect<
  { readonly _tag: "Inserted" | "Duplicate"; readonly factKey: string },
  unknown,
  WorkflowEngine.WorkflowEngine
> =>
  Effect.gen(function*() {
    const factKey = peerEventKey(options.name, options.eventId)
    const existing = yield* options.unified.peerEvents.get(factKey).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orDie,
    )
    if (existing !== undefined) {
      return { _tag: "Duplicate" as const, factKey }
    }
    yield* options.unified.peerEvents.insertOrGet({
      eventKey: factKey,
      name: options.name,
      eventId: options.eventId,
      emitterContextId: options.emitterContextId,
      payloadJson: options.payloadJson,
      emittedAt: new Date().toISOString(),
    }).pipe(Effect.orDie)
    if (options.armOptions !== undefined) {
      yield* kernelWriteArm({
        kernel: options.armOptions.kernel,
        workflow: options.armOptions.workflow,
        executionId: options.armOptions.executionId,
        inputTable: "peerEvents",
        inputKey: factKey,
        write: () => Effect.void,
        value: { factKey, name: options.name, eventId: options.eventId },
        serializeValue: (v) => JSON.stringify(v),
      }).pipe(Effect.orDie)
    }
    return { _tag: "Inserted" as const, factKey }
  })

// ── 4. WebhookFactObserverWorkflow ──────────────────────────────────────────
//
// Specialized observer: parks until a `webhookFacts` row exists for the
// requested `(source, deliveryId)`. The kernel write+arm path from
// `verifyAndIngestWebhook` wakes the body.
//
// There is deliberately no generic "wait_for any fact" workflow in the
// simulation. Each observer is specialized to one fact family — that
// keeps `Workflow.suspend` + point-read + predicate-match the canonical
// shape, and avoids string-dispatch over fact-table names (the retired
// SourceCollections / RuntimeObservationSourceNames pattern).

export const WebhookFactObserverPayloadSchema = Schema.Struct({
  source: Schema.String,
  deliveryId: Schema.String,
  observerId: Schema.String,
})
export type WebhookFactObserverPayload =
  Schema.Schema.Type<typeof WebhookFactObserverPayloadSchema>

export const WebhookFactObserverResultSchema = Schema.Struct({
  source: Schema.String,
  deliveryId: Schema.String,
  factKey: Schema.String,
  eventType: Schema.String,
})

export const WebhookFactObserverWorkflow = Workflow.make({
  name: "unified.webhook-fact-observer",
  payload: WebhookFactObserverPayloadSchema,
  success: WebhookFactObserverResultSchema,
  idempotencyKey: (p) => p.observerId,
})

const webhookFactObserverBody = (payload: WebhookFactObserverPayload) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const table = yield* UnifiedTable
    const key = webhookFactKey(payload.source, payload.deliveryId)
    while (true) {
      const row = yield* table.webhookFacts.get(key).pipe(Effect.orDie)
      if (Option.isSome(row)) {
        return {
          source: row.value.source,
          deliveryId: row.value.deliveryId,
          factKey: row.value.factKey,
          eventType: row.value.eventType,
        }
      }
      yield* Workflow.suspend(instance)
    }
  }) as Effect.Effect<
    Schema.Schema.Type<typeof WebhookFactObserverResultSchema>,
    never,
    WorkflowEngine.WorkflowInstance | UnifiedTable
  >

export const buildWebhookFactObserverLayer = () =>
  WebhookFactObserverWorkflow.toLayer(webhookFactObserverBody)

// ── 5. PeerEventObserverWorkflow ────────────────────────────────────────────

export const PeerEventObserverPayloadSchema = Schema.Struct({
  name: Schema.String,
  eventId: Schema.String,
  observerId: Schema.String,
})
export type PeerEventObserverPayload =
  Schema.Schema.Type<typeof PeerEventObserverPayloadSchema>

export const PeerEventObserverResultSchema = Schema.Struct({
  name: Schema.String,
  eventId: Schema.String,
  factKey: Schema.String,
  emitterContextId: Schema.String,
})

export const PeerEventObserverWorkflow = Workflow.make({
  name: "unified.peer-event-observer",
  payload: PeerEventObserverPayloadSchema,
  success: PeerEventObserverResultSchema,
  idempotencyKey: (p) => p.observerId,
})

const peerEventObserverBody = (payload: PeerEventObserverPayload) =>
  Effect.gen(function*() {
    const instance = yield* WorkflowEngine.WorkflowInstance
    const table = yield* UnifiedTable
    const key = peerEventKey(payload.name, payload.eventId)
    while (true) {
      const row = yield* table.peerEvents.get(key).pipe(Effect.orDie)
      if (Option.isSome(row)) {
        return {
          name: row.value.name,
          eventId: row.value.eventId,
          factKey: row.value.eventKey,
          emitterContextId: row.value.emitterContextId,
        }
      }
      yield* Workflow.suspend(instance)
    }
  }) as Effect.Effect<
    Schema.Schema.Type<typeof PeerEventObserverResultSchema>,
    never,
    WorkflowEngine.WorkflowInstance | UnifiedTable
  >

export const buildPeerEventObserverLayer = () =>
  PeerEventObserverWorkflow.toLayer(peerEventObserverBody)
