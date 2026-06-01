/**
 * Re-export of the scheduled-prompt + webhook + peer signal
 * subscribers and host helpers from `@firegrid/runtime/unified`.
 * See `../signal.ts` for the Phase 2 migration context.
 */

export {
  buildPeerEventObserverLayer,
  buildScheduledPromptLayer,
  buildWebhookFactObserverLayer,
  emitPeerEvent,
  isVerifiedWebhookError,
  PEER_EVENT_SIGNAL,
  type PeerEventObserverPayload,
  PeerEventObserverPayloadSchema,
  PeerEventObserverResultSchema,
  PeerEventObserverWorkflow,
  type ScheduledPromptPayload,
  ScheduledPromptPayloadSchema,
  ScheduledPromptResultSchema,
  ScheduledPromptWorkflow,
  type VerifyAndIngestResult,
  VerifiedWebhookError,
  verifyAndIngestWebhook,
  type VerifyWebhookOptions,
  WEBHOOK_FACT_SIGNAL,
  type WebhookFactObserverPayload,
  WebhookFactObserverPayloadSchema,
  WebhookFactObserverResultSchema,
  WebhookFactObserverWorkflow,
} from "@firegrid/runtime/unified"
