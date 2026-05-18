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
import { PublicLaunchRuntimeIntentSchema } from "./schema.ts"

const nowIso = (): string => new Date().toISOString()

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
}).annotations({
  identifier: "firegrid.runtimeStartRequest.row",
  title: "Runtime start request row",
  description:
    "Client-written durable request to start a RuntimeContext. Host claims and executes; not a synchronous run result.",
})
export type RuntimeStartRequestRow = Schema.Schema.Type<
  typeof RuntimeStartRequestRowSchema
>

export const RuntimeControlRequestKindSchema = Schema.Literal("context", "start")
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

export const RuntimeStartRequestAckSchema = Schema.Struct({
  requestId: Schema.String,
  contextId: Schema.String,
  inserted: Schema.Boolean,
}).annotations({
  identifier: "firegrid.runtimeStartRequest.ack",
  title: "Runtime start request acknowledgement",
  description:
    "Client-visible acknowledgement that a durable RuntimeStartRequest was recorded.",
})
export type RuntimeStartRequestAck = Schema.Schema.Type<
  typeof RuntimeStartRequestAckSchema
>

export const makeRuntimeContextRequestRow = (
  input: {
    readonly contextId: string
    readonly runtime: Schema.Schema.Type<typeof PublicLaunchRuntimeIntentSchema>
    readonly createdBy?: string
  },
  options?: {
    readonly requestId?: string
    readonly createdAt?: string
  },
): RuntimeContextRequestRow => ({
  requestId: options?.requestId ?? runtimeContextRequestId(input.contextId),
  contextId: input.contextId,
  runtime: input.runtime,
  ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
  createdAt: options?.createdAt ?? nowIso(),
})

export const makeRuntimeStartRequestRow = (
  input: {
    readonly contextId: string
    readonly requestedBy?: string
  },
  options?: {
    readonly requestId?: string
    readonly createdAt?: string
  },
): RuntimeStartRequestRow => ({
  requestId: options?.requestId ?? runtimeStartRequestId(input.contextId),
  contextId: input.contextId,
  ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
  createdAt: options?.createdAt ?? nowIso(),
})

export const makeRuntimeControlRequestClaimRow = (
  input: {
    readonly requestKind: RuntimeControlRequestKind
    readonly requestId: string
    readonly contextId: string
    readonly hostId: string
    readonly hostSessionId: string
    readonly claimWindowStartedAtMs: number
    readonly claimWindowExpiresAtMs: number
    readonly claimedAtMs: number
  },
): RuntimeControlRequestClaimRow => ({
  claimId: input.requestKind === "context"
    ? runtimeContextRequestClaimId(input.requestId, input.claimWindowStartedAtMs)
    : runtimeStartRequestClaimId(input.requestId, input.claimWindowStartedAtMs),
  requestKind: input.requestKind,
  requestId: input.requestId,
  contextId: input.contextId,
  hostId: input.hostId,
  hostSessionId: input.hostSessionId,
  claimWindowStartedAtMs: input.claimWindowStartedAtMs,
  claimWindowExpiresAtMs: input.claimWindowExpiresAtMs,
  claimedAtMs: input.claimedAtMs,
})

export const makeRuntimeControlRequestCompletionRow = (
  input: {
    readonly requestKind: RuntimeControlRequestKind
    readonly requestId: string
    readonly contextId: string
    readonly status: RuntimeControlRequestCompletionStatus
    readonly hostId: string
    readonly completedAtMs: number
    readonly activityAttempt?: number
    readonly exitCode?: number
    readonly signal?: string
    readonly message?: string
  },
): RuntimeControlRequestCompletionRow => ({
  requestId: input.requestId,
  requestKind: input.requestKind,
  contextId: input.contextId,
  status: input.status,
  hostId: input.hostId,
  completedAtMs: input.completedAtMs,
  ...(input.activityAttempt === undefined ? {} : { activityAttempt: input.activityAttempt }),
  ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
  ...(input.signal === undefined ? {} : { signal: input.signal }),
  ...(input.message === undefined ? {} : { message: input.message }),
})

export const makeRuntimeStartRequestAck = (
  input: {
    readonly requestId: string
    readonly contextId: string
    readonly inserted: boolean
  },
): RuntimeStartRequestAck => ({
  requestId: input.requestId,
  contextId: input.contextId,
  inserted: input.inserted,
})
