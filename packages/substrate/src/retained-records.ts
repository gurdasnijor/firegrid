import { stream } from "@durable-streams/client"
import type { ChangeEvent } from "@durable-streams/state"
import { Data, Effect, Either, Schema } from "effect"
import {
  ClaimAttemptRowType,
  ClaimAttemptValue,
  RunRowType,
  RunValue,
} from "./schema/rows.ts"
import { foldRunRecords } from "./schema/state-machine.ts"

// claim-and-operator-authority.CLAIM_AUTHORITY.7
// claim-and-operator-authority.OPERATOR_INVOCATION.14
// Helpers that read retained durable rows in append order via Durable Streams'
// raw client. Used by the operator to derive claim authority and by stress
// tests to prove once-only terminal authority over runs.

export class RetainedReadError extends Data.TaggedError("RetainedReadError")<{
  readonly cause: unknown
}> {}

const decodeClaim = Schema.decodeUnknownEither(ClaimAttemptValue)
const decodeRun = Schema.decodeUnknownEither(RunValue)

export const readJsonItems = (
  streamUrl: string,
): Effect.Effect<ReadonlyArray<ChangeEvent>, RetainedReadError> =>
  Effect.gen(function* () {
    const session = yield* Effect.tryPromise({
      try: () =>
        stream<ChangeEvent>({
          url: streamUrl,
          live: false,
          offset: "-1",
        }),
      catch: (cause) => new RetainedReadError({ cause }),
    })
    return yield* Effect.tryPromise({
      try: () => session.json<ChangeEvent>(),
      catch: (cause) => new RetainedReadError({ cause }),
    })
  })

// firegrid-remediation-hardening.CODE_REUSE.7
const readRetainedByField = <A>(
  streamUrl: string,
  rowType: string,
  decode: (value: unknown) => Either.Either<A, unknown>,
  fieldMatches: (value: A) => boolean,
): Effect.Effect<ReadonlyArray<A>, RetainedReadError> =>
  Effect.gen(function* () {
    const items = yield* readJsonItems(streamUrl)
    const result: A[] = []
    for (const event of items) {
      if (event.type !== rowType) continue
      const decoded = decode(event.value)
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(new RetainedReadError({ cause: decoded.left }))
      }
      if (!fieldMatches(decoded.right)) continue
      result.push(decoded.right)
    }
    return result
  })

export const readRetainedClaimAttempts = (
  streamUrl: string,
  workId: string,
): Effect.Effect<ReadonlyArray<ClaimAttemptValue>, RetainedReadError> =>
  readRetainedByField(
    streamUrl,
    ClaimAttemptRowType,
    decodeClaim,
    (claim) => claim.workId === workId,
  )

export const readRetainedRunRecords = (
  streamUrl: string,
  runId: string,
): Effect.Effect<ReadonlyArray<RunValue>, RetainedReadError> =>
  readRetainedByField(
    streamUrl,
    RunRowType,
    decodeRun,
    (run) => run.runId === runId,
  )

// firegrid-remediation-hardening.CODE_REUSE.3
export const readAuthoritativeRun = (
  streamUrl: string,
  runId: string,
): Effect.Effect<RunValue | undefined, RetainedReadError> =>
  readRetainedRunRecords(streamUrl, runId).pipe(
    Effect.map((records) => foldRunRecords(runId, records)),
  )
