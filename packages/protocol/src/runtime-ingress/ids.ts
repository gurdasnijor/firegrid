export const runtimeIngressRequestedRowId = (
  contextId: string,
  ingressId: string,
): string =>
  `runtime_ingress.requested:${contextId}:${ingressId}`

export const runtimeIngressAcceptedRowId = (
  contextId: string,
  subscriberId: string,
  ingressId: string,
): string =>
  `runtime_ingress.accepted:${contextId}:${subscriberId}:${ingressId}`

export const runtimeIngressIdForIdempotencyKey = (
  contextId: string,
  idempotencyKey: string,
): string =>
  `ing_${contextId}_${idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_")}`
