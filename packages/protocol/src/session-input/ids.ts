export const sessionInputRowId = (
  contextId: string,
  sessionInputId: string,
): string =>
  `session.input:${contextId}:${sessionInputId}`

export const sessionInputIdForIdempotencyKey = (
  contextId: string,
  idempotencyKey: string,
): string =>
  `input_${contextId}_${idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_")}`
