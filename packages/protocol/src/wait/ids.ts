// Deterministic row ids for durable wait facts. Used by producers + the
// evaluator so duplicate appends collapse at producer idempotency.

export const waitRequestedRowId = (waitId: string): string =>
  `wait.requested:${waitId}`

export const waitMatchedRowId = (waitId: string): string =>
  `wait.matched:${waitId}`

export const waitTimedOutRowId = (waitId: string): string =>
  `wait.timed_out:${waitId}`

export const waitFailedRowId = (waitId: string): string =>
  `wait.failed:${waitId}`
