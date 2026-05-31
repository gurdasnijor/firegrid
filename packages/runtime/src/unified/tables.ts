/**
 * Unified Subscriber Kernel — durable tables.
 *
 * Only families that hold data the workflow engine doesn't already track
 * remain here. The engine carries lifecycle (executions.finalResult),
 * activity memoization (durable return values), and clock recovery — so
 * `runs`, `outputs`, `toolResults`, `inputs`, `inputIds`, `contexts`,
 * and the row-level `status` flags on permissions/schedules were
 * dropped: every one of them duplicated state the engine or the kernel
 * command table already owns.
 *
 * What remains:
 *   - `permissions` — UI-renderable open requests. The decision is
 *     delivered as the kernel command payload, not as a `status`
 *     column. The row only holds what the host needs to render the
 *     pending request.
 *   - `schedules` — UI-renderable commitments. Firing is determined by
 *     engine DurableClock recovery and the workflow's finalResult.
 *   - `webhookFacts` — external HMAC-verified payload, multi-observer
 *     readable.
 *   - `peerEvents` — external peer-emitted payload, multi-observer
 *     readable.
 *
 * Session input intents are NOT a separate table. Each input is a
 * kernel command targeting the session workflow's executionId; the
 * command's `inputValueJson` carries the input payload. The session
 * body iterates its own kernel commands in `recordedAt` order.
 */

import { Schema } from "effect"
import { DurableTable } from "effect-durable-operators"

export const PermissionRequestRowSchema = Schema.Struct({
  permissionKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
  requestedAt: Schema.String,
})

export const ScheduledRowSchema = Schema.Struct({
  scheduleKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  fireAtMs: Schema.Number,
  payloadJson: Schema.String,
})

export const WebhookFactRowSchema = Schema.Struct({
  factKey: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  deliveryId: Schema.String,
  eventType: Schema.String,
  payloadJson: Schema.String,
  receivedAt: Schema.String,
})

export const PeerEventRowSchema = Schema.Struct({
  eventKey: Schema.String.pipe(DurableTable.primaryKey),
  name: Schema.String,
  eventId: Schema.String,
  emitterContextId: Schema.String,
  payloadJson: Schema.String,
  emittedAt: Schema.String,
})

export class UnifiedTable extends DurableTable("firegrid.unified.tables", {
  permissions: PermissionRequestRowSchema,
  schedules: ScheduledRowSchema,
  webhookFacts: WebhookFactRowSchema,
  peerEvents: PeerEventRowSchema,
}) {}

export type UnifiedTableService = UnifiedTable["Type"]

export const permissionKey = (
  contextId: string,
  permissionRequestId: string,
): string => `${contextId}/${permissionRequestId}`
export const scheduleKey = (
  contextId: string,
  scheduleId: string,
): string => `${contextId}/${scheduleId}`
export const webhookFactKey = (source: string, deliveryId: string): string =>
  `${source}/${deliveryId}`
export const peerEventKey = (name: string, eventId: string): string =>
  `${name}/${eventId}`
