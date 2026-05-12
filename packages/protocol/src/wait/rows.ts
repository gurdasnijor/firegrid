// Trusted row constructors. Inputs are already typed; outputs are
// `satisfies`-validated against the schema. No `Schema.decodeUnknownSync`
// — decoding is for the public boundary, not trusted construction.

import {
  waitFailedRowId,
  waitMatchedRowId,
  waitRequestedRowId,
  waitTimedOutRowId,
} from "./ids.ts"
import type {
  WaitFailedRow,
  WaitFailure,
  WaitMatch,
  WaitMatchedRow,
  WaitRequestedRow,
  WaitSourceDescriptor,
  WaitTimedOutRow,
} from "./schema.ts"

const nowIso = (): string => new Date().toISOString()

export interface MakeWaitRequestedRow {
  readonly waitId: string
  readonly ownerId: string
  readonly idempotencyKey: string
  readonly source: WaitSourceDescriptor
  readonly matcherId: string
  readonly matcherVersion: number
  readonly matcherParams: unknown
  readonly timeoutAt?: string
  readonly at?: string
}

export const makeWaitRequestedRow = (
  input: MakeWaitRequestedRow,
): WaitRequestedRow => {
  const at = input.at ?? nowIso()
  return {
    type: "firegrid.wait.requested",
    id: waitRequestedRowId(input.waitId),
    at,
    waitId: input.waitId,
    ownerId: input.ownerId,
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    matcherId: input.matcherId,
    matcherVersion: input.matcherVersion,
    matcherParams: input.matcherParams,
    ...(input.timeoutAt === undefined ? {} : { timeoutAt: input.timeoutAt }),
  } satisfies WaitRequestedRow
}

export const makeWaitMatchedRow = (
  input: { readonly waitId: string; readonly match: WaitMatch; readonly at?: string },
): WaitMatchedRow => {
  const at = input.at ?? nowIso()
  return {
    type: "firegrid.wait.matched",
    id: waitMatchedRowId(input.waitId),
    at,
    waitId: input.waitId,
    match: input.match,
  } satisfies WaitMatchedRow
}

export const makeWaitTimedOutRow = (
  input: { readonly waitId: string; readonly timeoutAt: string; readonly at?: string },
): WaitTimedOutRow => {
  const at = input.at ?? nowIso()
  return {
    type: "firegrid.wait.timed_out",
    id: waitTimedOutRowId(input.waitId),
    at,
    waitId: input.waitId,
    timeoutAt: input.timeoutAt,
  } satisfies WaitTimedOutRow
}

export const makeWaitFailedRow = (
  input: { readonly waitId: string; readonly failure: WaitFailure; readonly at?: string },
): WaitFailedRow => {
  const at = input.at ?? nowIso()
  return {
    type: "firegrid.wait.failed",
    id: waitFailedRowId(input.waitId),
    at,
    waitId: input.waitId,
    failure: input.failure,
  } satisfies WaitFailedRow
}
