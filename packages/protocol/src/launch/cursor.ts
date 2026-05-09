import type { RuntimeEvent } from "./schema.ts"

export interface RuntimeOutputCursor {
  readonly activityAttempt: number
  readonly sequence: number
}

export const compareRuntimeOutputOrder = (
  left: RuntimeEvent,
  right: RuntimeEvent,
): number =>
  left.activityAttempt - right.activityAttempt ||
  left.sequence - right.sequence

export const isAfterRuntimeOutputCursor = (
  row: RuntimeEvent,
  since: RuntimeOutputCursor | undefined,
): boolean =>
  since === undefined ||
  row.activityAttempt > since.activityAttempt ||
  (
    row.activityAttempt === since.activityAttempt &&
    row.sequence > since.sequence
  )
