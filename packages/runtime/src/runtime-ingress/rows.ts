import { Schema } from "effect"
import {
  runtimeIngressDeliveredRowId,
  runtimeIngressIdForIdempotencyKey,
  runtimeIngressRequestedRowId,
} from "./ids.ts"
import {
  RuntimeIngressDeliveredRowSchema,
  RuntimeIngressRequestSchema,
  RuntimeIngressRequestedRowSchema,
  type RuntimeIngressDeliveryRequest,
  type RuntimeIngressDeliveredRow,
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

export const makeRuntimeIngressDeliveredRow = (
  request: RuntimeIngressDeliveryRequest,
): RuntimeIngressDeliveredRow => {
  const deliveredAt = request.deliveredAt ?? nowIso()
  return Schema.decodeUnknownSync(RuntimeIngressDeliveredRowSchema)({
    type: "firegrid.runtime_ingress.delivered",
    id: runtimeIngressDeliveredRowId(request.contextId, request.subscriberId, request.ingressId),
    at: deliveredAt,
    ingressId: request.ingressId,
    contextId: request.contextId,
    subscriberId: request.subscriberId,
    provider: request.provider,
    deliveredAt,
  })
}
