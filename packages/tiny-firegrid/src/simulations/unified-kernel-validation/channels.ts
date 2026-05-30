/**
 * Unified product surface as channel registrations.
 *
 * Every product capability the driver exercises (sessions, prompts,
 * permissions, tools, scheduled prompts, webhooks, peer events) is a
 * `CallableChannel` from `@firegrid/protocol/channels`. The call
 * bindings route into the signal-based subscriber workflows
 * underneath. Callers use the channel abstraction directly —
 * `channel.binding.call(payload)` — and observe outcomes through the
 * channel's own response shape.
 *
 * This is the public surface that, in production, would replace the
 * Shape C / DurableDeferred-based control-plane bindings.
 */

import {
  type CallableChannel,
  makeCallableChannel,
} from "@firegrid/protocol/channels"
import { WorkflowEngine } from "@effect/workflow"
import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  sendSignal,
  SignalTable,
  type SignalTableService,
} from "./signal.ts"
import {
  PERMISSION_DECISION_SIGNAL,
  type PermissionDecisionPayload,
  PermissionRoundtripWorkflow,
  ToolDispatchPayloadSchema,
  ToolDispatchResultSchema,
  ToolDispatchWorkflow,
} from "./subscribers/permission-and-tool.ts"
import {
  RuntimeContextSessionPayloadSchema,
  RuntimeContextSessionResultSchema,
  RuntimeContextSessionWorkflow,
  type SessionInputPayload,
  SessionInputPayloadSchema,
} from "./subscribers/runtime-context.ts"
import {
  emitPeerEvent as emitPeerEventHelper,
  PeerEventObserverPayloadSchema,
  PeerEventObserverResultSchema,
  PeerEventObserverWorkflow,
  ScheduledPromptPayloadSchema,
  ScheduledPromptResultSchema,
  ScheduledPromptWorkflow,
  verifyAndIngestWebhook as verifyAndIngestWebhookHelper,
  WebhookFactObserverPayloadSchema,
  WebhookFactObserverResultSchema,
  WebhookFactObserverWorkflow,
} from "./subscribers/scheduled-webhook-peer.ts"
import {
  permissionKey,
  UnifiedTable,
  type UnifiedTableService,
} from "./tables.ts"

// ── Schemas ─────────────────────────────────────────────────────────────────

export const SessionHandleSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
  executionId: Schema.String,
})
export type SessionHandle = Schema.Schema.Type<typeof SessionHandleSchema>

export const SendInputRequestSchema = Schema.Struct({
  session: SessionHandleSchema,
  inputId: Schema.String,
  kind: SessionInputPayloadSchema.fields.kind,
  payloadJson: Schema.String,
})

export const PermissionHandleSchema = Schema.Struct({
  contextId: Schema.String,
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
  executionId: Schema.String,
})
export type PermissionHandle = Schema.Schema.Type<typeof PermissionHandleSchema>

export const PermissionOpenRequestSchema = Schema.Struct({
  contextId: Schema.String,
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
})

export const PermissionRequestRecordSchema = Schema.Struct({
  contextId: Schema.String,
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
  requestedAt: Schema.String,
})

export const PermissionRequestQuerySchema = Schema.Struct({
  contextId: Schema.String,
  permissionRequestId: Schema.String,
})

export const PermissionRequestRecordOptionSchema = Schema.NullOr(
  PermissionRequestRecordSchema,
)

export const PermissionDecisionSchema = Schema.Literal("allow", "deny", "cancelled")

export const PermissionRespondRequestSchema = Schema.Struct({
  handle: PermissionHandleSchema,
  decision: PermissionDecisionSchema,
})

export const PermissionDecisionResultSchema = Schema.Struct({
  permissionRequestId: Schema.String,
  decision: PermissionDecisionSchema,
})

export const WebhookIngestVerifySchema = Schema.Struct({
  source: Schema.String,
  deliveryId: Schema.String,
  eventType: Schema.String,
  secret: Schema.String,
  rawBody: Schema.instanceOf(Uint8Array),
  receivedSignatureHex: Schema.String,
})

export const WebhookObserverHandleSchema = Schema.Struct({
  source: Schema.String,
  deliveryId: Schema.String,
  observerId: Schema.String,
  executionId: Schema.String,
})
export type WebhookObserverHandle = Schema.Schema.Type<typeof WebhookObserverHandleSchema>

export const WebhookIngestRequestSchema = Schema.Struct({
  verify: WebhookIngestVerifySchema,
  armObserver: Schema.optional(WebhookObserverHandleSchema),
})

export const WebhookIngestOutcomeSchema = Schema.Struct({
  _tag: Schema.Literal("Inserted", "Duplicate", "Rejected"),
  factKey: Schema.optional(Schema.String),
  errorOp: Schema.optional(Schema.String),
})

export const PeerEmitPayloadSchema = Schema.Struct({
  name: Schema.String,
  eventId: Schema.String,
  emitterContextId: Schema.String,
  payloadJson: Schema.String,
})

export const PeerObserverHandleSchema = Schema.Struct({
  name: Schema.String,
  eventId: Schema.String,
  observerId: Schema.String,
  executionId: Schema.String,
})
export type PeerObserverHandle = Schema.Schema.Type<typeof PeerObserverHandleSchema>

export const PeerEmitRequestSchema = Schema.Struct({
  payload: PeerEmitPayloadSchema,
  armObserver: Schema.optional(PeerObserverHandleSchema),
})

// ── UnifiedChannels service ─────────────────────────────────────────────────

export interface UnifiedChannelsShape {
  readonly sessionStart: CallableChannel<typeof RuntimeContextSessionPayloadSchema, typeof SessionHandleSchema>
  readonly sessionSendInput: CallableChannel<typeof SendInputRequestSchema, typeof Schema.Void>
  readonly sessionAwaitTerminal: CallableChannel<typeof SessionHandleSchema, typeof RuntimeContextSessionResultSchema>
  readonly permissionOpen: CallableChannel<typeof PermissionOpenRequestSchema, typeof PermissionHandleSchema>
  readonly permissionReadRequest: CallableChannel<typeof PermissionRequestQuerySchema, typeof PermissionRequestRecordOptionSchema>
  readonly permissionRespond: CallableChannel<typeof PermissionRespondRequestSchema, typeof Schema.Void>
  readonly permissionAwaitDecision: CallableChannel<typeof PermissionHandleSchema, typeof PermissionDecisionResultSchema>
  readonly toolDispatch: CallableChannel<typeof ToolDispatchPayloadSchema, typeof ToolDispatchResultSchema>
  readonly schedulePrompt: CallableChannel<typeof ScheduledPromptPayloadSchema, typeof ScheduledPromptResultSchema>
  readonly webhookIngest: CallableChannel<typeof WebhookIngestRequestSchema, typeof WebhookIngestOutcomeSchema>
  readonly webhookObserverStart: CallableChannel<typeof WebhookFactObserverPayloadSchema, typeof WebhookObserverHandleSchema>
  readonly webhookObserverAwait: CallableChannel<typeof WebhookObserverHandleSchema, typeof WebhookFactObserverResultSchema>
  readonly peerEmit: CallableChannel<typeof PeerEmitRequestSchema, typeof WebhookIngestOutcomeSchema>
  readonly peerObserverStart: CallableChannel<typeof PeerEventObserverPayloadSchema, typeof PeerObserverHandleSchema>
  readonly peerObserverAwait: CallableChannel<typeof PeerObserverHandleSchema, typeof PeerEventObserverResultSchema>
}

export class UnifiedChannels extends Context.Tag(
  "firegrid.unified.channels",
)<UnifiedChannels, UnifiedChannelsShape>() {}

// ── Live bindings ───────────────────────────────────────────────────────────

const makeChannels = (
  signals: SignalTableService,
  unified: UnifiedTableService,
  engine: WorkflowEngine.WorkflowEngine["Type"],
): UnifiedChannelsShape => {
  // Strip the WorkflowEngine requirement from any call effect before it
  // becomes a channel binding (channel bindings must be self-contained
  // — R = never).
  const lower = <A, E>(
    effect: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>,
  ): Effect.Effect<A, E, never> =>
    Effect.provideService(effect, WorkflowEngine.WorkflowEngine, engine)

  return {
    sessionStart: makeCallableChannel({
      target: "unified.session.start",
      requestSchema: RuntimeContextSessionPayloadSchema,
      responseSchema: SessionHandleSchema,
      call: (payload) =>
        lower(Effect.gen(function*() {
          const executionId = yield* RuntimeContextSessionWorkflow.executionId(payload)
          yield* Effect.fork(RuntimeContextSessionWorkflow.execute(payload))
          return {
            contextId: payload.contextId,
            attempt: payload.attempt,
            executionId,
          } satisfies SessionHandle
        })),
    }),

    sessionSendInput: makeCallableChannel({
      target: "unified.session.send_input",
      requestSchema: SendInputRequestSchema,
      responseSchema: Schema.Void,
      call: (request) =>
        lower(sendSignal({
          signals,
          workflow: RuntimeContextSessionWorkflow,
          executionId: request.session.executionId,
          name: request.inputId,
          write: () => Effect.void,
          value: {
            kind: request.kind,
            payloadJson: request.payloadJson,
          } satisfies SessionInputPayload,
          serializeValue: (v) => JSON.stringify(v),
        })).pipe(Effect.orDie, Effect.asVoid),
    }),

    sessionAwaitTerminal: makeCallableChannel({
      target: "unified.session.await_terminal",
      requestSchema: SessionHandleSchema,
      responseSchema: RuntimeContextSessionResultSchema,
      call: (handle) =>
        lower(RuntimeContextSessionWorkflow.execute({
          contextId: handle.contextId,
          attempt: handle.attempt,
        })).pipe(Effect.orDie),
    }),

    permissionOpen: makeCallableChannel({
      target: "unified.permission.open",
      requestSchema: PermissionOpenRequestSchema,
      responseSchema: PermissionHandleSchema,
      call: (payload) =>
        lower(Effect.gen(function*() {
          const executionId = yield* PermissionRoundtripWorkflow.executionId(payload)
          yield* Effect.fork(PermissionRoundtripWorkflow.execute(payload))
          return {
            contextId: payload.contextId,
            permissionRequestId: payload.permissionRequestId,
            toolUseId: payload.toolUseId,
            executionId,
          } satisfies PermissionHandle
        })),
    }),

    permissionReadRequest: makeCallableChannel({
      target: "unified.permission.read_request",
      requestSchema: PermissionRequestQuerySchema,
      responseSchema: PermissionRequestRecordOptionSchema,
      call: (query) =>
        unified.permissions.get(
          permissionKey(query.contextId, query.permissionRequestId),
        ).pipe(
          Effect.map(Option.match({
            onNone: () => null,
            onSome: (row) => ({
              contextId: row.contextId,
              permissionRequestId: row.permissionRequestId,
              toolUseId: row.toolUseId,
              requestedAt: row.requestedAt,
            }),
          })),
          Effect.orDie,
        ),
    }),

    permissionRespond: makeCallableChannel({
      target: "unified.permission.respond",
      requestSchema: PermissionRespondRequestSchema,
      responseSchema: Schema.Void,
      call: (request) =>
        lower(sendSignal({
          signals,
          workflow: PermissionRoundtripWorkflow,
          executionId: request.handle.executionId,
          name: PERMISSION_DECISION_SIGNAL,
          write: () => Effect.void,
          value: { decision: request.decision } satisfies PermissionDecisionPayload,
          serializeValue: (v) => JSON.stringify(v),
        })).pipe(Effect.orDie, Effect.asVoid),
    }),

    permissionAwaitDecision: makeCallableChannel({
      target: "unified.permission.await_decision",
      requestSchema: PermissionHandleSchema,
      responseSchema: PermissionDecisionResultSchema,
      call: (handle) =>
        lower(PermissionRoundtripWorkflow.execute({
          contextId: handle.contextId,
          permissionRequestId: handle.permissionRequestId,
          toolUseId: handle.toolUseId,
        })).pipe(Effect.orDie),
    }),

    toolDispatch: makeCallableChannel({
      target: "unified.tool.dispatch",
      requestSchema: ToolDispatchPayloadSchema,
      responseSchema: ToolDispatchResultSchema,
      call: (payload) =>
        lower(ToolDispatchWorkflow.execute(payload)).pipe(Effect.orDie),
    }),

    schedulePrompt: makeCallableChannel({
      target: "unified.schedule.prompt",
      requestSchema: ScheduledPromptPayloadSchema,
      responseSchema: ScheduledPromptResultSchema,
      call: (payload) =>
        lower(ScheduledPromptWorkflow.execute(payload)).pipe(Effect.orDie),
    }),

    webhookIngest: makeCallableChannel({
      target: "unified.webhook.ingest",
      requestSchema: WebhookIngestRequestSchema,
      responseSchema: WebhookIngestOutcomeSchema,
      call: (request) =>
        lower(verifyAndIngestWebhookHelper({
          unified,
          verify: request.verify,
          ...(request.armObserver !== undefined
            ? {
              signalOptions: {
                signals,
                workflow: WebhookFactObserverWorkflow,
                executionId: request.armObserver.executionId,
              },
            }
            : {}),
        })).pipe(
          Effect.map((r) => ({ _tag: r._tag, factKey: r.factKey })),
          Effect.catchAll((err) =>
            Effect.succeed({ _tag: "Rejected" as const, errorOp: err.op }),
          ),
        ),
    }),

    webhookObserverStart: makeCallableChannel({
      target: "unified.webhook.observer.start",
      requestSchema: WebhookFactObserverPayloadSchema,
      responseSchema: WebhookObserverHandleSchema,
      call: (payload) =>
        lower(Effect.gen(function*() {
          const executionId = yield* WebhookFactObserverWorkflow.executionId(payload)
          yield* Effect.fork(WebhookFactObserverWorkflow.execute(payload))
          return { ...payload, executionId } satisfies WebhookObserverHandle
        })),
    }),

    webhookObserverAwait: makeCallableChannel({
      target: "unified.webhook.observer.await",
      requestSchema: WebhookObserverHandleSchema,
      responseSchema: WebhookFactObserverResultSchema,
      call: (handle) =>
        lower(WebhookFactObserverWorkflow.execute({
          source: handle.source,
          deliveryId: handle.deliveryId,
          observerId: handle.observerId,
        })).pipe(Effect.orDie),
    }),

    peerEmit: makeCallableChannel({
      target: "unified.peer.emit",
      requestSchema: PeerEmitRequestSchema,
      responseSchema: WebhookIngestOutcomeSchema,
      call: (request) =>
        lower(emitPeerEventHelper({
          unified,
          name: request.payload.name,
          eventId: request.payload.eventId,
          emitterContextId: request.payload.emitterContextId,
          payloadJson: request.payload.payloadJson,
          ...(request.armObserver !== undefined
            ? {
              signalOptions: {
                signals,
                workflow: PeerEventObserverWorkflow,
                executionId: request.armObserver.executionId,
              },
            }
            : {}),
        })).pipe(
          Effect.map((r) => ({ _tag: r._tag, factKey: r.factKey })),
          Effect.orDie,
        ),
    }),

    peerObserverStart: makeCallableChannel({
      target: "unified.peer.observer.start",
      requestSchema: PeerEventObserverPayloadSchema,
      responseSchema: PeerObserverHandleSchema,
      call: (payload) =>
        lower(Effect.gen(function*() {
          const executionId = yield* PeerEventObserverWorkflow.executionId(payload)
          yield* Effect.fork(PeerEventObserverWorkflow.execute(payload))
          return { ...payload, executionId } satisfies PeerObserverHandle
        })),
    }),

    peerObserverAwait: makeCallableChannel({
      target: "unified.peer.observer.await",
      requestSchema: PeerObserverHandleSchema,
      responseSchema: PeerEventObserverResultSchema,
      call: (handle) =>
        lower(PeerEventObserverWorkflow.execute({
          name: handle.name,
          eventId: handle.eventId,
          observerId: handle.observerId,
        })).pipe(Effect.orDie),
    }),
  }
}

export const UnifiedChannelsLive = Layer.effect(
  UnifiedChannels,
  Effect.gen(function*() {
    const signals = yield* SignalTable
    const unified = yield* UnifiedTable
    const engine = yield* WorkflowEngine.WorkflowEngine
    return makeChannels(signals, unified, engine)
  }),
)
