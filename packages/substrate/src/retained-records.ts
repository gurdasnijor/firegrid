import { stream } from "@durable-streams/client"
import type { ChangeEvent } from "@durable-streams/state"
import { Effect, Either, Schema } from "effect"
import {
  ClaimAttemptRowType,
  ClaimAttemptValue,
  RunRowType,
  RunValue,
} from "./schema/rows.ts"

// claim-and-operator-authority.CLAIM_AUTHORITY.7
// claim-and-operator-authority.OPERATOR_INVOCATION.14
// Helpers that read retained durable rows in append order via Durable Streams'
// raw client. Used by the operator to derive claim authority and by stress
// tests to prove once-only terminal authority over runs.

export class RetainedReadError extends Error {
  readonly _tag = "RetainedReadError"
  constructor(readonly cause: unknown) {
    super(`retained read error: ${String(cause)}`)
  }
}

const decodeClaim = Schema.decodeUnknownEither(ClaimAttemptValue)
const decodeRun = Schema.decodeUnknownEither(RunValue)

const readJsonItems = (
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
      catch: (cause) => new RetainedReadError(cause),
    })
    return yield* Effect.tryPromise({
      try: () => session.json<ChangeEvent>(),
      catch: (cause) => new RetainedReadError(cause),
    })
  })

export const readRetainedClaimAttempts = (
  streamUrl: string,
  workId: string,
): Effect.Effect<ReadonlyArray<ClaimAttemptValue>, RetainedReadError> =>
  Effect.gen(function* () {
    const items = yield* readJsonItems(streamUrl)
    const result: ClaimAttemptValue[] = []
    for (const event of items) {
      if (event.type !== ClaimAttemptRowType) continue
      const decoded = decodeClaim(event.value)
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(new RetainedReadError(decoded.left))
      }
      if (decoded.right.workId !== workId) continue
      result.push(decoded.right)
    }
    return result
  })

export const readRetainedRunRecords = (
  streamUrl: string,
  runId: string,
): Effect.Effect<ReadonlyArray<RunValue>, RetainedReadError> =>
  Effect.gen(function* () {
    const items = yield* readJsonItems(streamUrl)
    const result: RunValue[] = []
    for (const event of items) {
      if (event.type !== RunRowType) continue
      const decoded = decodeRun(event.value)
      if (Either.isLeft(decoded)) {
        return yield* Effect.fail(new RetainedReadError(decoded.left))
      }
      if (decoded.right.runId !== runId) continue
      result.push(decoded.right)
    }
    return result
  })
