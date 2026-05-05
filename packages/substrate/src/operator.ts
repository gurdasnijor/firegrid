import { DurableStream } from "@durable-streams/client"
import { Data, Effect, Either } from "effect"
import { appendChange } from "./descriptors/append.ts"
import { attemptClaim } from "./internal-claim.ts"
import {
  ClaimMissingCursorError,
  ClaimStreamError,
  ClaimWinnerMissingError,
  firstValidClaim,
} from "./operator-errors.ts"
import type { ClaimAttemptValue, RunState, RunValue } from "./schema/rows.ts"
import type { ReadyWorkItem } from "./schema/ready-work.ts"
import { readAuthoritativeRun as readAuthoritativeRunRaw } from "./retained-records.ts"
import {
  completeRun,
  failRun,
} from "./schema/state-machine.ts"

// Re-export of the claim-fold function and error classes for callers that
// imported them from operator.ts before the shared-helper extraction.
export {
  ClaimMissingCursorError,
  ClaimStreamError,
  ClaimWinnerMissingError,
  firstValidClaim,
}

// claim-and-operator-authority.OPERATOR_INVOCATION.6, .7, .12, .13
export type ClaimOutcome<A, E> =
  | {
      readonly kind: "completed"
      readonly runId: string
      readonly claimId: string
      readonly result: A
    }
  | {
      readonly kind: "failed"
      readonly runId: string
      readonly claimId: string
      readonly error: E
    }
  | {
      readonly kind: "claim-lost"
      readonly runId: string
      readonly claimId: string
      readonly winner: ClaimAttemptValue
    }
  // OPERATOR_INVOCATION.12 — winning claim observed, but the run is already
  // terminal; handler is NOT invoked.
  | {
      readonly kind: "already-terminal"
      readonly runId: string
      readonly claimId: string
      readonly runState: RunState
    }
  // OPERATOR_INVOCATION.13 — handler ran, but a concurrent terminal state
  // was observed before our terminal append; no new terminal event appended.
  | {
      readonly kind: "terminalization-lost"
      readonly runId: string
      readonly claimId: string
      readonly terminalState: RunState
    }

export class RunNotFoundError extends Data.TaggedError("RunNotFoundError")<{
  readonly runId: string
}> {}

export type OperatorError =
  | ClaimStreamError
  | ClaimMissingCursorError
  | RunNotFoundError
  | ClaimWinnerMissingError

export interface ProcessReadyWorkItemArgs<A, E> {
  readonly streamUrl: string
  readonly contentType?: string
  readonly ownerId: string
  readonly item: ReadyWorkItem
  readonly handler: (input: ReadyWorkItem) => Effect.Effect<A, E>
  // Test/internal-only override; production callers omit this and the operator
  // generates a unique claimId per attempt (CLAIM_ATTEMPT.7).
  readonly claimId?: string
}

// claim-and-operator-authority.OPERATOR_INVOCATION.15 — terminal race detection
// uses retained run-row authority via raw stream read + first-valid-terminal fold,
// not StreamDB latest-state which can disagree with the durable origin order.
const readAuthoritativeRun = (
  streamUrl: string,
  runId: string,
): Effect.Effect<RunValue | undefined, ClaimStreamError> =>
  Effect.mapError(
    readAuthoritativeRunRaw(streamUrl, runId),
    (cause) => new ClaimStreamError({ cause }),
  )

// claim-and-operator-authority.OPERATOR_INVOCATION.1, .2, .3, .4, .5, .9, .10, .11, .12, .13
// claim-and-operator-authority.CLAIM_AUTHORITY.7 — operator reads retained claim attempts
// in append order to derive the winner (no longer depends on snapshot iteration).
// Single-shot operator for one ReadyWorkItem.
export const processReadyWorkItem = <A, E>(
  args: ProcessReadyWorkItemArgs<A, E>,
): Effect.Effect<ClaimOutcome<A, E>, OperatorError> =>
  Effect.gen(function* () {
    const contentType = args.contentType ?? "application/json"
    const streamHandle = new DurableStream({ url: args.streamUrl, contentType })

    // CLAIM_ATTEMPT.6 — workId = runId; CLAIM_ATTEMPT.7 — claimId is unique per attempt.
    // CLAIM_ATTEMPT.8 + CLAIM_AUTHORITY.7 — head cursor + append + retained-fold are owned
    // by the shared internal helper so kernel and facade cannot drift.
    const workId = args.item.runId
    const { claimId, winner } = yield* attemptClaim({
      streamUrl: args.streamUrl,
      ...(args.contentType !== undefined ? { contentType: args.contentType } : {}),
      workId,
      ownerId: args.ownerId,
      ...(args.claimId !== undefined ? { claimIdOverride: args.claimId } : {}),
    })
    if (winner.claimId !== claimId) {
      // OPERATOR_INVOCATION.4 — speculative invocation forbidden; we lost.
      // CLAIM_AUTHORITY.8 — same-owner duplicate is also a loss (no second handler invocation).
      return {
        kind: "claim-lost" as const,
        runId: args.item.runId,
        claimId,
        winner,
      }
    }

    // OPERATOR_INVOCATION.12 + .15 — pre-handler stale check via authoritative
    // retained run fold (NOT StreamDB latest). The fold returns the first-valid
    // terminal if any exists; otherwise the most-recent non-terminal record.
    const preRun = yield* readAuthoritativeRun(args.streamUrl, args.item.runId)
    if (preRun === undefined) {
      return yield* Effect.fail(new RunNotFoundError({ runId: args.item.runId }))
    }
    if (preRun.state !== "blocked") {
      return {
        kind: "already-terminal" as const,
        runId: args.item.runId,
        claimId,
        runState: preRun.state,
      }
    }

    // OPERATOR_INVOCATION.6, .8 — handler returns/fails in Effect channels.
    const handlerResult = yield* Effect.either(args.handler(args.item))

    // OPERATOR_INVOCATION.13 + .15 — re-read authoritative folded run state
    // after handler and detect a concurrent terminalization race before
    // appending our terminal event.
    const postRun = yield* readAuthoritativeRun(args.streamUrl, args.item.runId)
    if (postRun === undefined) {
      return yield* Effect.fail(new RunNotFoundError({ runId: args.item.runId }))
    }
    if (postRun.state !== "blocked") {
      return {
        kind: "terminalization-lost" as const,
        runId: args.item.runId,
        claimId,
        terminalState: postRun.state,
      }
    }

    // OPERATOR_INVOCATION.11 — terminalization via state-machine builders, defensively wrapped.
    const buildResult = yield* Effect.either(
      Either.isRight(handlerResult)
        ? completeRun(postRun, { result: handlerResult.right })
        : failRun(postRun, { error: handlerResult.left }),
    )
    if (Either.isLeft(buildResult)) {
      // OPERATOR_INVOCATION.13 — race we did not catch via re-read; treat the
      // builder-rejected `from` state as the observed terminal state.
      const observed: RunState =
        buildResult.left.from === undefined || buildResult.left.from === "blocked"
          ? // Defensive fallback if `from` is somehow not a terminal label.
            "completed"
          : (buildResult.left.from)
      return {
        kind: "terminalization-lost" as const,
        runId: args.item.runId,
        claimId,
        terminalState: observed,
      }
    }

    yield* appendChange(streamHandle, buildResult.right, (cause) =>
      new ClaimStreamError({ cause }),
    )

    if (Either.isRight(handlerResult)) {
      return {
        kind: "completed" as const,
        runId: args.item.runId,
        claimId,
        result: handlerResult.right,
      }
    }
    return {
      kind: "failed" as const,
      runId: args.item.runId,
      claimId,
      error: handlerResult.left,
    }
  })
