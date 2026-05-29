/**
 * Unified Subscriber Kernel — durable tables.
 *
 * One `DurableTable` namespace for the whole sim. Each row family
 * captures a single product concern (input, output, run lifecycle, tool
 * result, permission, scheduled, peer-event, webhook fact). All rows
 * have a domain-identity primary key; `insertOrGet` is the universal
 * idempotent write.
 *
 * Tables alone do NOT wake parked workflow bodies — that's the kernel's
 * job. Subscribers consume tables by point-read or row stream; the
 * kernel arms the body via `kernelWriteArm` whenever an input row is
 * written that should trigger a body.
 */

import { Schema } from "effect"
import { DurableTable } from "effect-durable-operators"

// ── Runtime context (the keyed entity) ──────────────────────────────────────

export const RuntimeContextRowSchema = Schema.Struct({
  contextId: Schema.String.pipe(DurableTable.primaryKey),
  agent: Schema.String,
  createdAt: Schema.String,
})

// ── Input intent (workflow-owned input table; the kernel arms on write) ─────

export const InputRowSchema = Schema.Struct({
  /** Domain-identity primary key: `${contextId}/${inputId}`. */
  inputKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  /** Caller-supplied stable id. Used for identity-keyed dedup. */
  inputId: Schema.String,
  /** `kind` distinguishes prompt / permission-response / tool-result / etc. */
  kind: Schema.Literal(
    "prompt",
    "permission-response",
    "tool-result",
    "peer-event",
    "scheduled-fire",
  ),
  /** JSON-encoded payload the subscriber decodes. */
  payloadJson: Schema.String,
  appendedAt: Schema.String,
})

export const InputIdsRowSchema = Schema.Struct({
  /** Idempotency index for caller-supplied `inputId` per context. */
  key: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  inputId: Schema.String,
  /** Points at the canonical inputKey the first caller reserved. */
  inputKey: Schema.String,
})

// ── Output (durable sparse fact log the subscriber writes) ──────────────────

export const OutputRowSchema = Schema.Struct({
  /** Primary key: `${contextId}/${sequence}`. */
  outputKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  sequence: Schema.Number,
  kind: Schema.Literal(
    "text-chunk",
    "permission-request",
    "tool-use",
    "ready",
    "turn-complete",
    "terminated",
    "error",
  ),
  payloadJson: Schema.String,
  emittedAt: Schema.String,
})

// ── Run lifecycle (the durable terminal evidence — terminal-after-settlement) ─

export const RunRowSchema = Schema.Struct({
  /** Primary key: `${contextId}/${attempt}`. */
  runKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  attempt: Schema.Number,
  status: Schema.Literal("started", "exited", "failed"),
  exitCode: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
  recordedAt: Schema.String,
})

// ── Tool dispatch results (Shape D MCP-entry idempotency) ──────────────────

export const ToolResultRowSchema = Schema.Struct({
  /** Primary key: `${contextId}/${toolUseId}`. */
  toolKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  toolUseId: Schema.String,
  toolName: Schema.String,
  resultJson: Schema.String,
  /** Increments on each genuine executor invocation. Asserted == 1 across replays. */
  invocationCount: Schema.Number,
  recordedAt: Schema.String,
})

// ── Permission requests (paired with permission-response inputs by id) ──────

export const PermissionRequestRowSchema = Schema.Struct({
  /** Primary key: `${contextId}/${permissionRequestId}`. */
  permissionKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  permissionRequestId: Schema.String,
  toolUseId: Schema.String,
  status: Schema.Literal("pending", "responded"),
  decisionJson: Schema.optional(Schema.String),
  requestedAt: Schema.String,
  respondedAt: Schema.optional(Schema.String),
})

// ── Scheduled-prompt commitments (Shape D DurableClock case) ────────────────

export const ScheduledRowSchema = Schema.Struct({
  scheduleKey: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  fireAtMs: Schema.Number,
  payloadJson: Schema.String,
  status: Schema.Literal("pending", "fired"),
  firedAt: Schema.optional(Schema.String),
})

// ── External adapters (webhook + peer event) ────────────────────────────────

export const WebhookFactRowSchema = Schema.Struct({
  /** Primary key: `${source}/${deliveryId}`. */
  factKey: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  deliveryId: Schema.String,
  eventType: Schema.String,
  payloadJson: Schema.String,
  receivedAt: Schema.String,
})

export const PeerEventRowSchema = Schema.Struct({
  /** Primary key: `${name}/${eventId}`. */
  eventKey: Schema.String.pipe(DurableTable.primaryKey),
  name: Schema.String,
  eventId: Schema.String,
  emitterContextId: Schema.String,
  payloadJson: Schema.String,
  emittedAt: Schema.String,
})

// ── The unified table ───────────────────────────────────────────────────────

export class UnifiedTable extends DurableTable("firegrid.unified.tables", {
  contexts: RuntimeContextRowSchema,
  inputs: InputRowSchema,
  inputIds: InputIdsRowSchema,
  outputs: OutputRowSchema,
  runs: RunRowSchema,
  toolResults: ToolResultRowSchema,
  permissions: PermissionRequestRowSchema,
  schedules: ScheduledRowSchema,
  webhookFacts: WebhookFactRowSchema,
  peerEvents: PeerEventRowSchema,
}) {}

export type UnifiedTableService = UnifiedTable["Type"]

// ── Domain-key helpers (so contributors don't recompute keys ad hoc) ────────

export const inputKey = (contextId: string, inputId: string): string =>
  `${contextId}/${inputId}`
export const inputIdsKey = (contextId: string, inputId: string): string =>
  `${contextId}/${inputId}`
export const outputKey = (contextId: string, sequence: number): string =>
  `${contextId}/${sequence}`
export const runKey = (contextId: string, attempt: number): string =>
  `${contextId}/${attempt}`
export const toolKey = (contextId: string, toolUseId: string): string =>
  `${contextId}/${toolUseId}`
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
