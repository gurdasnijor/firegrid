// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
//
// Client-written, namespace-scoped durable control requests.
//
// TFIND-002 / TFIND-003 (Option B, additive): a remote client must be able
// to *ask* for a RuntimeContext to be created and started without holding a
// host capability (`CurrentHostSession`, `RuntimeStartCapability`) or sharing
// a host Effect environment. These are the protocol-owned request rows that
// express that ask. They carry NO host binding — host binding and live
// execution remain host-owned; a host materializes the bound
// `RuntimeContext` and runs it from these requests.
//
// This file is intentionally inert in this PR: it defines the schemas, row
// types, and idempotent constructors only. No client/host wiring, no table
// membership change. The client/CLI/factory flip and the host reconciler are
// a later single coordinated transaction (see
// docs/sdds/SDD_FIREGRID_CLIENT_HOST_BOUNDARY.md, Q1 = Option B).
//
// Shape mirrors the already-blessed `RuntimeInputIntentRow` precedent
// (`@firegrid/protocol/runtime-ingress`): an append-only, idempotent row
// keyed by a deterministic id, with no status column (host claim is tracked
// host-side, not on the client-written request).

import { DurableTable } from "effect-durable-operators"
import { Schema } from "effect"
import { RowOtelContextSchema } from "../otel/row-otel.ts"
import { PublicLaunchRuntimeIntentSchema } from "./schema.ts"

const sanitizeIdSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_-]/g, "_")

/**
 * Deterministic id for a context-create request. Keyed by the
 * client-computed deterministic `contextId` so re-issuing create/load for the
 * same session is idempotent at the durable layer (mirrors
 * `runtimeIngressInputIdForIdempotencyKey`).
 */
export const runtimeContextRequestId = (contextId: string): string =>
  `req_ctx_${sanitizeIdSegment(contextId)}`

/**
 * Deterministic id for a start request. Keyed by `contextId`: a client
 * asking "start this session" twice records one durable intent, not two
 * competing runs. Host-side claim/attempt accounting is separate.
 */
export const runtimeStartRequestId = (contextId: string): string =>
  `req_start_${sanitizeIdSegment(contextId)}`

export const runtimeContextRequestClaimId = (
  requestId: string,
  claimWindowStartedAtMs: number,
): string =>
  `ctx_req_claim:${sanitizeIdSegment(requestId)}:${claimWindowStartedAtMs}`

export const runtimeStartRequestClaimId = (
  requestId: string,
  claimWindowStartedAtMs: number,
): string =>
  `start_req_claim:${sanitizeIdSegment(requestId)}:${claimWindowStartedAtMs}`

// tf-4ni Gap (session_cancel/session_close substrate): durable
// session-lifecycle terminate requests. Same blessed shape as the
// context/start control requests above — append-only, idempotent by
// `contextId` so re-issuing cancel/close for the same session records one
// durable intent, not competing terminations. Host claim/attempt accounting
// reuses the existing kind-generic claim/completion rows.
export const runtimeCancelRequestId = (contextId: string): string =>
  `req_cancel_${sanitizeIdSegment(contextId)}`

export const runtimeCloseRequestId = (contextId: string): string =>
  `req_close_${sanitizeIdSegment(contextId)}`

export const runtimeCancelRequestClaimId = (
  requestId: string,
  claimWindowStartedAtMs: number,
): string =>
  `cancel_req_claim:${sanitizeIdSegment(requestId)}:${claimWindowStartedAtMs}`

export const runtimeCloseRequestClaimId = (
  requestId: string,
  claimWindowStartedAtMs: number,
): string =>
  `close_req_claim:${sanitizeIdSegment(requestId)}:${claimWindowStartedAtMs}`

// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
//
// The unbound create/load request. `contextId` is the client-computed
// deterministic id (e.g. `sessionContextIdForExternalKey`); `runtime` is the
// public unbound intent (no journal, no host binding) exactly as
// `SessionCreateOrLoadInputSchema.runtime`. A host fills the host binding
// when it materializes the durable `RuntimeContext`.
export const RuntimeContextRequestRowSchema = Schema.Struct({
  requestId: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  runtime: PublicLaunchRuntimeIntentSchema,
  createdBy: Schema.optional(Schema.String),
  createdAt: Schema.String,
  // firegrid-row-otel-propagation.ROW_OTEL.1
  _otel: Schema.optional(RowOtelContextSchema),
}).annotations({
  identifier: "firegrid.runtimeContextRequest.row",
  title: "Runtime context request row",
  description:
    "Client-written durable request to create/load a RuntimeContext. Carries no host binding.",
})
export type RuntimeContextRequestRow = Schema.Schema.Type<
  typeof RuntimeContextRequestRowSchema
>

// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
//
// The start control request. Mirrors `RuntimeStartOptions` (contextId) as a
// durable, client-authored row a host observes/claims/executes. It is NOT a
// synchronous result: terminal status is read through the existing run/output
// projections.
export const RuntimeStartRequestRowSchema = Schema.Struct({
  requestId: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  requestedBy: Schema.optional(Schema.String),
  createdAt: Schema.String,
  // firegrid-row-otel-propagation.ROW_OTEL.1
  _otel: Schema.optional(RowOtelContextSchema),
}).annotations({
  identifier: "firegrid.runtimeStartRequest.row",
  title: "Runtime start request row",
  description:
    "Client-written durable request to start a RuntimeContext. Host claims and executes; not a synchronous run result.",
})
export type RuntimeStartRequestRow = Schema.Schema.Type<
  typeof RuntimeStartRequestRowSchema
>

// tf-4ni: the session-lifecycle terminate request. Mirrors
// `RuntimeStartRequestRowSchema` as a durable, client/host-authored row a
// host observes/claims/executes. `lifecycle` selects cancel vs close. It is
// NOT a synchronous result: terminal status is read through the existing
// run/output projections and the kind-generic completion row.
export const RuntimeLifecycleRequestRowSchema = Schema.Struct({
  requestId: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  lifecycle: Schema.Literal("cancel", "close"),
  requestedBy: Schema.optional(Schema.String),
  createdAt: Schema.String,
  // firegrid-row-otel-propagation.ROW_OTEL.1
  _otel: Schema.optional(RowOtelContextSchema),
}).annotations({
  identifier: "firegrid.runtimeLifecycleRequest.row",
  title: "Runtime lifecycle request row",
  description:
    "Client/host-written durable request to cancel or close a RuntimeContext. Host claims and drives the per-context engine to a durable terminal state; not a synchronous result.",
})
export type RuntimeLifecycleRequestRow = Schema.Schema.Type<
  typeof RuntimeLifecycleRequestRowSchema
>

export const RuntimeControlRequestKindSchema = Schema.Literal(
  "context",
  "start",
  "cancel",
  "close",
)
export type RuntimeControlRequestKind = Schema.Schema.Type<
  typeof RuntimeControlRequestKindSchema
>

export const RuntimeControlRequestCompletionStatusSchema = Schema.Literal(
  "succeeded",
  "failed",
  "abandoned",
)
export type RuntimeControlRequestCompletionStatus = Schema.Schema.Type<
  typeof RuntimeControlRequestCompletionStatusSchema
>

export const RuntimeControlRequestClaimRowSchema = Schema.Struct({
  claimId: Schema.String.pipe(DurableTable.primaryKey),
  requestKind: RuntimeControlRequestKindSchema,
  requestId: Schema.String,
  contextId: Schema.String,
  hostId: Schema.String,
  hostSessionId: Schema.String,
  claimWindowStartedAtMs: Schema.Number,
  claimWindowExpiresAtMs: Schema.Number,
  claimedAtMs: Schema.Number,
}).annotations({
  identifier: "firegrid.runtimeControlRequestClaim.row",
  title: "Runtime control request claim row",
  description:
    "Host-written first-writer-wins claim fact for a client-authored control request.",
})
export type RuntimeControlRequestClaimRow = Schema.Schema.Type<
  typeof RuntimeControlRequestClaimRowSchema
>

export const RuntimeControlRequestCompletionRowSchema = Schema.Struct({
  requestId: Schema.String.pipe(DurableTable.primaryKey),
  requestKind: RuntimeControlRequestKindSchema,
  contextId: Schema.String,
  status: RuntimeControlRequestCompletionStatusSchema,
  hostId: Schema.String,
  completedAtMs: Schema.Number,
  activityAttempt: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
}).annotations({
  identifier: "firegrid.runtimeControlRequestCompletion.row",
  title: "Runtime control request completion row",
  description:
    "Host-written terminal completion row for a client-authored control request.",
})
export type RuntimeControlRequestCompletionRow = Schema.Schema.Type<
  typeof RuntimeControlRequestCompletionRowSchema
>

// `makeRuntimeStartRequestAck` deleted with `RuntimeStartRequestAck`.
