import { randomUUID } from "node:crypto"
import { DurableStream } from "@durable-streams/client"
import { Effect } from "effect"
import {
  ClaimMissingCursorError,
  ClaimStreamError,
  ClaimWinnerMissingError,
  firstValidClaim,
} from "./operator-errors.ts"
import { readRetainedClaimAttempts } from "./retained-records.ts"
import type { ClaimAttemptValue } from "./schema/rows.ts"
import { substrateState } from "./schema/state.ts"

// Internal-only shared claim helper. Used by:
//   - operator.processReadyWorkItem (kernel single-shot operator)
//   - facade/work.WorkClaimLive (facade WorkClaim service)
// Not re-exported via src/index.ts. Both call paths share one implementation
// of head -> append claim.attempt -> readRetained -> first-valid winner so
// claim semantics cannot drift between kernel and facade.
//
// claim-and-operator-authority.CLAIM_ATTEMPT.6, .7, .8
// claim-and-operator-authority.CLAIM_AUTHORITY.7
export interface AttemptClaimArgs {
  readonly streamUrl: string
  readonly contentType?: string
  readonly workId: string
  readonly ownerId: string
  // Test/internal-only override; production callers omit and a fresh UUID is used.
  readonly claimIdOverride?: string
}

export interface AttemptClaimOutcome {
  readonly claimId: string
  readonly winner: ClaimAttemptValue
}

export type AttemptClaimError =
  | ClaimStreamError
  | ClaimMissingCursorError
  | ClaimWinnerMissingError

export const attemptClaim = (
  args: AttemptClaimArgs,
): Effect.Effect<AttemptClaimOutcome, AttemptClaimError> =>
  Effect.gen(function* () {
    const contentType = args.contentType ?? "application/json"
    const stream = new DurableStream({ url: args.streamUrl, contentType })

    const head = yield* Effect.tryPromise({
      try: () => stream.head(),
      catch: (cause) => new ClaimStreamError({ cause }),
    })
    if (head.offset === undefined) {
      return yield* Effect.fail(
        new ClaimMissingCursorError({ streamUrl: args.streamUrl }),
      )
    }
    const observedCursor: string = head.offset

    const claimId = args.claimIdOverride ?? randomUUID()
    const claim: ClaimAttemptValue = {
      claimId,
      workId: args.workId,
      ownerId: args.ownerId,
      observedCursor,
      status: "attempted",
    }
    const claimEvent = substrateState.claimAttempts.insert({ value: claim })
    yield* Effect.tryPromise({
      try: () => stream.append(JSON.stringify(claimEvent)),
      catch: (cause) => new ClaimStreamError({ cause }),
    })

    const attempts = yield* Effect.mapError(
      readRetainedClaimAttempts(args.streamUrl, args.workId),
      (cause) => new ClaimStreamError({ cause }),
    )
    const winner = firstValidClaim(args.workId, attempts)
    if (winner === undefined) {
      return yield* Effect.fail(
        new ClaimWinnerMissingError({ workId: args.workId }),
      )
    }
    return { claimId, winner }
  })
