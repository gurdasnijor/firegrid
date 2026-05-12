import { Schema } from "effect"
import {
  runtimeIngressAcceptedRowId,
  runtimeIngressIdForIdempotencyKey,
  runtimeIngressRequestedRowId,
} from "./ids.ts"
import {
  PublicPromptRequestSchema,
  RuntimeIngressAcceptedRowSchema,
  RuntimeIngressRequestSchema,
  RuntimeIngressRequestedRowSchema,
  type PublicPromptRequest,
  type RuntimeIngressAcceptanceRequest,
  type RuntimeIngressAcceptedRow,
  type RuntimeIngressRequest,
  type RuntimeIngressRequestedRow,
} from "./schema.ts"

const nowIso = (): string => new Date().toISOString()

export const ingressIdForRequest = (
  request: RuntimeIngressRequest,
): string =>
  request.ingressId ??
  (request.idempotencyKey === undefined
    ? `ing_${crypto.randomUUID()}`
    : runtimeIngressIdForIdempotencyKey(request.contextId, request.idempotencyKey))

export const promptToRuntimeIngressRequest = (
  request: PublicPromptRequest,
): RuntimeIngressRequest => {
  const decoded = Schema.decodeUnknownSync(PublicPromptRequestSchema)(request)
  return {
    contextId: decoded.contextId,
    kind: "message",
    authoredBy: "client",
    payload: decoded.payload,
    ...(decoded.idempotencyKey === undefined ? {} : { idempotencyKey: decoded.idempotencyKey }),
    ...(decoded.metadata === undefined ? {} : { metadata: decoded.metadata }),
  }
}

export const makeRuntimeIngressRequestedRow = (
  request: RuntimeIngressRequest,
  options?: {
    readonly ingressId?: string
    readonly createdAt?: string
  },
): RuntimeIngressRequestedRow => {
  const decoded = Schema.decodeUnknownSync(RuntimeIngressRequestSchema)(request)
  const ingressId = options?.ingressId ?? ingressIdForRequest(decoded)
  const createdAt = options?.createdAt ?? nowIso()
  return Schema.decodeUnknownSync(RuntimeIngressRequestedRowSchema)({
    type: "firegrid.runtime_ingress.requested",
    id: runtimeIngressRequestedRowId(decoded.contextId, ingressId),
    at: createdAt,
    ingressId,
    contextId: decoded.contextId,
    kind: decoded.kind,
    authoredBy: decoded.authoredBy,
    payload: decoded.payload,
    ...(decoded.idempotencyKey === undefined ? {} : { idempotencyKey: decoded.idempotencyKey }),
    createdAt,
    ...(decoded.metadata === undefined ? {} : { metadata: decoded.metadata }),
  })
}

export const makeRuntimeIngressAcceptedRow = (
  request: RuntimeIngressAcceptanceRequest,
): RuntimeIngressAcceptedRow => {
  const acceptedAt = request.acceptedAt ?? nowIso()
  return Schema.decodeUnknownSync(RuntimeIngressAcceptedRowSchema)({
    type: "firegrid.runtime_ingress.accepted",
    id: runtimeIngressAcceptedRowId(request.contextId, request.subscriberId, request.ingressId),
    at: acceptedAt,
    ingressId: request.ingressId,
    contextId: request.contextId,
    subscriberId: request.subscriberId,
    provider: request.provider,
    acceptedAt,
  })
}
