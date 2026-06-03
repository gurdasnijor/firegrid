/**
 * Scheduled prompts + peer-event external adapter.
 *
 *   1. `ScheduledPromptWorkflow` — DurableClock.sleep for a wall-clock
 *      wakeup, then return. No `status` flag — engine clock recovery
 *      + `executions.finalResult` is the durable evidence of firing.
 *   2. `emitPeerEvent` — host helper that writes a `peerEvents` row
 *      and optionally sends a `peer-event` signal.
 *   3. `PeerEventObserverWorkflow` — specialized observer for a
 *      `(name, eventId)` peer event.
 *
 * The verified-webhook ingest path is owned by `verified-webhook-ingest/`
 * (`ingestVerifiedWebhook` + `VerifiedWebhookFactTable`); the dead duplicate
 * that used to live here was removed (tf-0awo.37).
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

// ── 2. Shared observer-signal helpers ───────────────────────────────────────

interface MissingSignaledRowError {
  readonly _tag: "MissingSignaledRowError"
  readonly message: string
}

const MissingSignaledRowError = Data.tagged<MissingSignaledRowError>("MissingSignaledRowError")

export const PEER_EVENT_SIGNAL = "peer-event"

/**
 * await-once durable completion the observer workflow parks on. tf-k00i:
 * `@effect/workflow` `DurableDeferred` replaces the bespoke `signal.ts`
 * await/send (it already rides `DurableStreamsWorkflowEngine`). The value is
 * unused (the observer re-reads its owned row), so success is `Void`.
 */
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

// ── 4. PeerEventObserverWorkflow ────────────────────────────────────────────

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
