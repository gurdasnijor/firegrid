import { Data } from "effect"
import type { ClaimAttemptValue } from "./schema/rows.ts"

// Error classes shared between operator.ts (kernel single-shot operator) and
// internal-claim.ts (shared claim helper used by facade/work.WorkClaimLive).
// Extracted to break the would-be cycle introduced when operator.ts also
// imports the shared claim helper.

export class ClaimStreamError extends Data.TaggedError("ClaimStreamError")<{
  readonly cause: unknown
}> {}

// claim-and-operator-authority.CLAIM_ATTEMPT.8
export class ClaimMissingCursorError extends Data.TaggedError(
  "ClaimMissingCursorError",
)<{
  readonly streamUrl: string
}> {}

export class ClaimWinnerMissingError extends Data.TaggedError(
  "ClaimWinnerMissingError",
)<{
  readonly workId: string
}> {}

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
