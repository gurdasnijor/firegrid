import {
  runtimeIngressIdForIdempotencyKey,
  runtimeIngressRequestedRowId,
} from "./ids.ts"
import {
  type PublicPromptRequest,
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

// `request` is already validated by the API boundary
// (`Firegrid.prompt` decodes `PublicPromptRequestSchema` and passes the
// validated value in). This trusted helper rebuilds it into the internal
// `RuntimeIngressRequest` shape without re-decoding.
export const promptToRuntimeIngressRequest = (
  request: PublicPromptRequest,
): RuntimeIngressRequest => ({
  contextId: request.contextId,
  kind: "message",
  authoredBy: "client",
  payload: request.payload,
  ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
  ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
})

// Trusted row constructor: `request` is already typed as
// `RuntimeIngressRequest` (validated upstream by `Firegrid.prompt`'s
// `Schema.decodeUnknown(PublicPromptRequestSchema)`). The wire-shape row
// is built directly and constrained via `satisfies`; the durable stream
// boundary re-encodes through `RuntimeIngressRowSchema` on append, so
// decoding here would be redundant.
export const makeRuntimeIngressRequestedRow = (
  request: RuntimeIngressRequest,
  options?: {
    readonly ingressId?: string
    readonly createdAt?: string
  },
): RuntimeIngressRequestedRow => {
  const ingressId = options?.ingressId ?? ingressIdForRequest(request)
  const createdAt = options?.createdAt ?? nowIso()
  return {
    type: "firegrid.runtime_ingress.requested",
    id: runtimeIngressRequestedRowId(request.contextId, ingressId),
    at: createdAt,
    ingressId,
    contextId: request.contextId,
    kind: request.kind,
    authoredBy: request.authoredBy,
    payload: request.payload,
    ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    createdAt,
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  } satisfies RuntimeIngressRequestedRow
}
