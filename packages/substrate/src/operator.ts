import { randomUUID } from "node:crypto"
import { DurableStream } from "@durable-streams/client"
import { Effect, Either } from "effect"
import type { ClaimAttemptValue } from "./rows.js"
import type { ReadyWorkItem } from "./ready-work.js"
import { substrateState } from "./state-schema.js"
import { rebuildProjection } from "./stream.js"
import {
  completeRun,
  failRun,
} from "./state-machine.js"

// claim-and-operator-authority.CLAIM_AUTHORITY.1, .2, .3, .6
// First-valid-claim-by-stream-order fold scoped to one workId.
// Same-owner later attempts are duplicate evidence (.2). Different-owner later
// attempts are losing conflicts (.3). Records for other workIds are filtered.
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

// claim-and-operator-authority.OPERATOR_INVOCATION.6, .7
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

export class ClaimStreamError extends Error {
  readonly _tag = "ClaimStreamError"
  constructor(readonly cause: unknown) {
    super(`claim stream error: ${String(cause)}`)
  }
}

// claim-and-operator-authority.CLAIM_ATTEMPT.8
// Fail typed if the stream has no cursor; do not synthesize one.
export class ClaimMissingCursorError extends Error {
  readonly _tag = "ClaimMissingCursorError"
  constructor(readonly streamUrl: string) {
    super(`claim attempt requires a stream cursor; HEAD ${streamUrl} returned no offset`)
  }
}

export class RunNotFoundError extends Error {
  readonly _tag = "RunNotFoundError"
  constructor(readonly runId: string) {
    super(`run ${runId} not found in retained projection`)
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

// claim-and-operator-authority.OPERATOR_INVOCATION.1, .2, .3, .4, .5, .9, .10, .11
// Single-shot operator for one ReadyWorkItem. Steps:
//   1. capture observedCursor from durable stream metadata (CLAIM_ATTEMPT.8)
//   2. append durable.claim.attempt with workId=runId, ownerId, observedCursor
//   3. rebuild and observe whether our claim is the first-valid winner
//   4. invoke handler ONLY if winning (.3, .4)
//   5. winning owner appends run terminal via state-machine builders (.5, .11)
export const processReadyWorkItem = <A, E>(
  args: ProcessReadyWorkItemArgs<A, E>,
): Effect.Effect<ClaimOutcome<A, E>, OperatorError> =>
  Effect.gen(function* () {
    const contentType = args.contentType ?? "application/json"
    const stream = new DurableStream({ url: args.streamUrl, contentType })

    // CLAIM_ATTEMPT.8 — capture cursor from real durable stream metadata.
    const head = yield* Effect.tryPromise({
      try: () => stream.head(),
      catch: (cause) => new ClaimStreamError(cause),
    })
    if (head.offset === undefined) {
      return yield* Effect.fail(new ClaimMissingCursorError(args.streamUrl))
    }
    const observedCursor: string = head.offset

    // CLAIM_ATTEMPT.6 — workId = runId
    // CLAIM_ATTEMPT.7 — claimId is unique per attempt
    const workId = args.item.runId
    const claimId = args.claimId ?? randomUUID()
    const claim: ClaimAttemptValue = {
      claimId,
      workId,
      ownerId: args.ownerId,
      observedCursor,
      status: "attempted",
    }
    const claimEvent = substrateState.claimAttempts.insert({ value: claim })
    yield* Effect.tryPromise({
      try: () => stream.append(JSON.stringify(claimEvent)),
      catch: (cause) => new ClaimStreamError(cause),
    })

    // OPERATOR_INVOCATION.3 — observe whether our claim is the winner before invoking handler.
    const snapshot = yield* Effect.tryPromise({
      try: () => rebuildProjection({ url: args.streamUrl, contentType }),
      catch: (cause) => new ClaimStreamError(cause),
    })
    const winner = firstValidClaim(workId, [...snapshot.claimAttempts.values()])
    if (winner === undefined) {
      return yield* Effect.fail(new ClaimWinnerMissingError(workId))
    }
    if (winner.claimId !== claimId) {
      // OPERATOR_INVOCATION.4 — speculative invocation forbidden; we lost.
      return {
        kind: "claim-lost" as const,
        runId: args.item.runId,
        claimId,
        winner,
      }
    }

    // OPERATOR_INVOCATION.5 — only the winning owner may attempt to terminalize.
    // OPERATOR_INVOCATION.11 — terminalization via state-machine builders.
    const currentRun = snapshot.runs.get(args.item.runId)
    if (currentRun === undefined) {
      return yield* Effect.fail(new RunNotFoundError(args.item.runId))
    }

    // OPERATOR_INVOCATION.6, .8 — handler returns/fails in Effect channels.
    const handlerResult = yield* Effect.either(args.handler(args.item))

    if (Either.isRight(handlerResult)) {
      const event = completeRun(currentRun, { result: handlerResult.right })
      yield* Effect.tryPromise({
        try: () => stream.append(JSON.stringify(event)),
        catch: (cause) => new ClaimStreamError(cause),
      })
      return {
        kind: "completed" as const,
        runId: args.item.runId,
        claimId,
        result: handlerResult.right,
      }
    }
    const event = failRun(currentRun, { error: handlerResult.left })
    yield* Effect.tryPromise({
      try: () => stream.append(JSON.stringify(event)),
      catch: (cause) => new ClaimStreamError(cause),
    })
    return {
      kind: "failed" as const,
      runId: args.item.runId,
      claimId,
      error: handlerResult.left,
    }
  })
