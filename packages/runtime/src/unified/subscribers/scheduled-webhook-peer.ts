/**
 * Scheduled prompts + external adapters (webhook + peer event).
 *
 *   1. `ScheduledPromptWorkflow` — DurableClock.sleep for a wall-clock
 *      wakeup, then return. No `status` flag — engine clock recovery
 *      + `executions.finalResult` is the durable evidence of firing.
 *   2. `verifyAndIngestWebhook` — host-side helper that verifies an
 *      HMAC on raw bytes, decodes JSON, writes a `webhookFacts` row,
 *      and optionally sends a `webhook-fact` signal to a waiting
 *      observer.
 *   3. `emitPeerEvent` — host helper that writes a `peerEvents` row
 *      and optionally sends a `peer-event` signal.
 *   4. `WebhookFactObserverWorkflow` — specialized observer for a
 *      `(source, deliveryId)` webhook fact. Parks via `awaitSignal`;
 *      reads the corresponding row from `webhookFacts`.
 *   5. `PeerEventObserverWorkflow` — specialized observer for a
 *      `(name, eventId)` peer event.
 */

import {
  Activity,
  DurableClock,
  DurableDeferred,
  Workflow,
  type WorkflowEngine,
} from "@effect/workflow"
import { Clock, Data, Duration, Effect, Option, Schema } from "effect"
import {
  peerEventKey,
  scheduleKey,
  UnifiedTable,
  type UnifiedTableService,
  webhookFactKey,
} from "../tables.ts"
import {
  bytesToHex,
  hexToBytes,
  signHmacSha256,
} from "../../events/webhook-crypto.ts"

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

// workflow-make-admission: see docs/workflow-make-admission-ledger.md
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

    // Record the commitment so the host can list pending schedules.
    yield* Activity.make({
      name: `unified.scheduled.record/${key}`,
      success: Schema.Void,
      execute: table.schedules.insertOrGet({
        scheduleKey: key,
        contextId: payload.contextId,
        fireAtMs: payload.fireAtMs,
        payloadJson: payload.payloadJson,
      }).pipe(Effect.orDie, Effect.asVoid),
    })

    // DurableClock — the engine recovers this on reconstruction.
    const now = yield* Clock.currentTimeMillis
    const delay = Math.max(0, payload.fireAtMs - now)
    yield* DurableClock.sleep({
      name: `unified.scheduled-prompt/${key}`,
      duration: Duration.millis(delay),
      inMemoryThreshold: Duration.zero,
    })

    const firedAtMs = yield* Clock.currentTimeMillis
    return { scheduleId: payload.scheduleId, firedAt: new Date(firedAtMs).toISOString() }
  }) as Effect.Effect<
    Schema.Schema.Type<typeof ScheduledPromptResultSchema>,
    never,
    UnifiedTable | WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
  >

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

const decoder = new TextDecoder()

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
): Effect.Effect<string, VerifiedWebhookError> =>
  Effect.tryPromise({
    try: async () => bytesToHex(await signHmacSha256(secret, rawBody)),
    catch: (cause) =>
      VerifiedWebhookError({
        message: `HMAC digest failed: ${String(cause)}`,
        op: "signature/digest",
      }),
  })

export interface VerifiedWebhookError {
  readonly _tag: "VerifiedWebhookError"
  readonly message: string
  readonly op: string
}

export const VerifiedWebhookError = Data.tagged<VerifiedWebhookError>("VerifiedWebhookError")

export const isVerifiedWebhookError = (value: unknown): value is VerifiedWebhookError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "VerifiedWebhookError" &&
  "op" in value &&
  typeof value.op === "string"

interface MissingSignaledRowError {
  readonly _tag: "MissingSignaledRowError"
  readonly message: string
}

const MissingSignaledRowError = Data.tagged<MissingSignaledRowError>("MissingSignaledRowError")

export interface VerifyAndIngestResult {
  readonly _tag: "Inserted" | "Duplicate"
  readonly factKey: string
}

export const WEBHOOK_FACT_SIGNAL = "webhook-fact"
export const PEER_EVENT_SIGNAL = "peer-event"

/**
 * await-once durable completions the observer workflows park on. tf-k00i:
 * `@effect/workflow` `DurableDeferred` replaces the bespoke `signal.ts`
 * await/send (it already rides `DurableStreamsWorkflowEngine`). The value is
 * unused (the observer re-reads its owned row), so success is `Void`.
 */
export const webhookFactDeferred = DurableDeferred.make(WEBHOOK_FACT_SIGNAL)
export const peerEventDeferred = DurableDeferred.make(PEER_EVENT_SIGNAL)

/** Target for resolving an observer's await-once deferred. */
export interface ObserverSignalTarget {
  readonly workflow: Workflow.Any
  readonly executionId: string
}

const lookupExisting = <A>(
  get: Effect.Effect<Option.Option<A>, unknown>,
) =>
  get.pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orDie,
  )

const signalFact = (options: {
  readonly deferred: DurableDeferred.DurableDeferred<typeof Schema.Void>
  readonly signalOptions: ObserverSignalTarget | undefined
}) =>
  options.signalOptions === undefined
    ? Effect.void
    : DurableDeferred.succeed(options.deferred, {
      token: DurableDeferred.tokenFromExecutionId(options.deferred, {
        workflow: options.signalOptions.workflow,
        executionId: options.signalOptions.executionId,
      }),
      value: void 0,
    }).pipe(Effect.orDie)

/**
 * Verify HMAC + write a webhookFacts row. Idempotent on `(source,
 * deliveryId)`. If `signalOptions` is provided, also sends a
 * `webhook-fact` signal to wake a waiting observer.
 */
export const verifyAndIngestWebhook = (options: {
  readonly unified: UnifiedTableService
  readonly verify: VerifyWebhookOptions
  readonly signalOptions?: ObserverSignalTarget
}): Effect.Effect<VerifyAndIngestResult, VerifiedWebhookError, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function*() {
    const expected = yield* hmacSha256Hex(
      options.verify.secret,
      options.verify.rawBody,
    )
    if (!constantTimeHexEquals(expected, options.verify.receivedSignatureHex)) {
      return yield* Effect.fail(VerifiedWebhookError({
        message: "invalid signature",
        op: "signature/invalid",
      }))
    }
    const factKey = webhookFactKey(options.verify.source, options.verify.deliveryId)
    const existing = yield* lookupExisting(options.unified.webhookFacts.get(factKey))
    if (existing !== undefined) {
      return { _tag: "Duplicate" as const, factKey }
    }
    const payloadJson = decoder.decode(options.verify.rawBody)
    const receivedAtMs = yield* Clock.currentTimeMillis
    yield* options.unified.webhookFacts.insertOrGet({
      factKey,
      source: options.verify.source,
      deliveryId: options.verify.deliveryId,
      eventType: options.verify.eventType,
      payloadJson,
      receivedAt: new Date(receivedAtMs).toISOString(),
    }).pipe(Effect.orDie)
    yield* signalFact({
      deferred: webhookFactDeferred,
      signalOptions: options.signalOptions,
    })
    return { _tag: "Inserted" as const, factKey }
  })

// ── 3. Peer event emit (host-side) ──────────────────────────────────────────

export const emitPeerEvent = (options: {
  readonly unified: UnifiedTableService
  readonly name: string
  readonly eventId: string
  readonly emitterContextId: string
  readonly payloadJson: string
  readonly signalOptions?: ObserverSignalTarget
}): Effect.Effect<
  { readonly _tag: "Inserted" | "Duplicate"; readonly factKey: string },
  unknown,
  WorkflowEngine.WorkflowEngine
> =>
  Effect.gen(function*() {
    const factKey = peerEventKey(options.name, options.eventId)
    const existing = yield* lookupExisting(options.unified.peerEvents.get(factKey))
    if (existing !== undefined) {
      return { _tag: "Duplicate" as const, factKey }
    }
    const emittedAtMs = yield* Clock.currentTimeMillis
    yield* options.unified.peerEvents.insertOrGet({
      eventKey: factKey,
      name: options.name,
      eventId: options.eventId,
      emitterContextId: options.emitterContextId,
      payloadJson: options.payloadJson,
      emittedAt: new Date(emittedAtMs).toISOString(),
    }).pipe(Effect.orDie)
    yield* signalFact({
      deferred: peerEventDeferred,
      signalOptions: options.signalOptions,
    })
    return { _tag: "Inserted" as const, factKey }
  })

// ── 4. WebhookFactObserverWorkflow ──────────────────────────────────────────
//
// Specialized observer: parks on the `webhook-fact` signal. When the
// ingest path sends the signal, the body wakes and reads the matching
// `webhookFacts` row.

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

// workflow-make-admission: see docs/workflow-make-admission-ledger.md
export const WebhookFactObserverWorkflow = Workflow.make({
  name: "unified.webhook-fact-observer",
  payload: WebhookFactObserverPayloadSchema,
  success: WebhookFactObserverResultSchema,
  idempotencyKey: (p) => p.observerId,
})

const webhookFactObserverBody = (payload: WebhookFactObserverPayload) =>
  Effect.gen(function*() {
    const table = yield* UnifiedTable
    yield* DurableDeferred.await(webhookFactDeferred)
    const key = webhookFactKey(payload.source, payload.deliveryId)
    // Contract: the ingest path writes the fact row BEFORE sending the
    // signal, so by the time we wake, the row exists.
    const row = yield* table.webhookFacts.get(key).pipe(
      Effect.flatMap(Option.match({
        onNone: () =>
          Effect.fail(MissingSignaledRowError({
            message: `webhook fact ${key} signaled but not present in table`,
          })),
        onSome: Effect.succeed,
      })),
    )
    return {
      source: row.source,
      deliveryId: row.deliveryId,
      factKey: row.factKey,
      eventType: row.eventType,
    }
  }) as Effect.Effect<
    Schema.Schema.Type<typeof WebhookFactObserverResultSchema>,
    never,
    UnifiedTable | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
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

// workflow-make-admission: see docs/workflow-make-admission-ledger.md
export const PeerEventObserverWorkflow = Workflow.make({
  name: "unified.peer-event-observer",
  payload: PeerEventObserverPayloadSchema,
  success: PeerEventObserverResultSchema,
  idempotencyKey: (p) => p.observerId,
})

const peerEventObserverBody = (payload: PeerEventObserverPayload) =>
  Effect.gen(function*() {
    const table = yield* UnifiedTable
    yield* DurableDeferred.await(peerEventDeferred)
    const key = peerEventKey(payload.name, payload.eventId)
    const row = yield* table.peerEvents.get(key).pipe(
      Effect.flatMap(Option.match({
        onNone: () =>
          Effect.fail(MissingSignaledRowError({
            message: `peer event ${key} signaled but not present in table`,
          })),
        onSome: Effect.succeed,
      })),
    )
    return {
      name: row.name,
      eventId: row.eventId,
      factKey: row.eventKey,
      emitterContextId: row.emitterContextId,
    }
  }) as Effect.Effect<
    Schema.Schema.Type<typeof PeerEventObserverResultSchema>,
    never,
    UnifiedTable | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
  >

export const buildPeerEventObserverLayer = () =>
  PeerEventObserverWorkflow.toLayer(peerEventObserverBody)
