import type { ClaimAttemptValue } from "./rows.ts"

// Error classes shared between operator.ts (kernel single-shot operator) and
// internal-claim.ts (shared claim helper used by facade/work.WorkClaimLive).
// Extracted to break the would-be cycle introduced when operator.ts also
// imports the shared claim helper.

export class ClaimStreamError extends Error {
  readonly _tag = "ClaimStreamError"
  constructor(readonly cause: unknown) {
    super(`claim stream error: ${String(cause)}`)
  }
}

// claim-and-operator-authority.CLAIM_ATTEMPT.8
export class ClaimMissingCursorError extends Error {
  readonly _tag = "ClaimMissingCursorError"
  constructor(readonly streamUrl: string) {
    super(`claim attempt requires a stream cursor; HEAD ${streamUrl} returned no offset`)
  }
}

export class ClaimWinnerMissingError extends Error {
  readonly _tag = "ClaimWinnerMissingError"
  constructor(readonly workId: string) {
    super(
      `internal: no claim attempts visible for workId ${workId} after appending — projection may be stale`,
    )
  }
}

// claim-and-operator-authority.CLAIM_AUTHORITY.1, .2, .3, .6
// First-valid-claim-by-stream-order fold scoped to one workId.
export function firstValidClaim(
  workId: string,
  attempts: ReadonlyArray<ClaimAttemptValue>,
): ClaimAttemptValue | undefined {
  for (const attempt of attempts) {
    if (attempt.workId !== workId) continue
    return attempt
  }
  return undefined
}
