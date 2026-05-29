/**
 * Atomic input append helper.
 *
 * Pattern from the `tiny-input-append-wakeup` simulation: a single atomic
 * table method over `contexts` + `inputs` + `inputIds` ensures
 * idempotent input delivery without a bridge table, deferred mailbox,
 * dispatcher fiber, or sequence allocator.
 *
 * Caller-supplied `inputId` is the idempotency index. Duplicate calls
 * with the same `(contextId, inputId)` return the original `inputKey`;
 * distinct calls reserve fresh primary keys.
 *
 * The append is paired with the kernel `kernelWriteArm` call at the
 * subscriber boundary — see `subscribers.ts` for the
 * "append input + arm the workflow" composition.
 */

import { Effect, Option } from "effect"
import {
  inputIdsKey as makeInputIdsKey,
  inputKey as makeInputKey,
  type InputRowSchema,
  type UnifiedTableService,
} from "./tables.ts"

type InputRow = (typeof InputRowSchema)["Type"]

export interface AppendInputResult {
  readonly inputKey: string
  readonly inserted: boolean
}

const now = (): string => new Date().toISOString()

/**
 * Atomic append + idempotency dedup.
 *
 * - If the `(contextId, inputId)` pair has been seen before, returns the
 *   original `inputKey` with `inserted: false` (idempotent replay).
 * - Otherwise reserves a fresh `inputKey = ${contextId}/${inputId}` and
 *   writes both the input row and the idempotency index entry. Returns
 *   `inserted: true`.
 *
 * Note: this is the input-side of `kernelWriteArm`. The subscriber's
 * append helper composes this with the kernel command.
 */
export const appendInputIntent = (options: {
  readonly table: UnifiedTableService
  readonly contextId: string
  readonly inputId: string
  readonly kind: InputRow["kind"]
  readonly payloadJson: string
}): Effect.Effect<AppendInputResult, unknown> =>
  Effect.gen(function*() {
    const idsKey = makeInputIdsKey(options.contextId, options.inputId)
    const existing = yield* options.table.inputIds.get(idsKey).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orDie,
    )
    if (existing !== undefined) {
      return { inputKey: existing.inputKey, inserted: false }
    }
    const key = makeInputKey(options.contextId, options.inputId)
    yield* options.table.inputs.insertOrGet({
      inputKey: key,
      contextId: options.contextId,
      inputId: options.inputId,
      kind: options.kind,
      payloadJson: options.payloadJson,
      appendedAt: now(),
    }).pipe(Effect.orDie)
    yield* options.table.inputIds.insertOrGet({
      key: idsKey,
      contextId: options.contextId,
      inputId: options.inputId,
      inputKey: key,
    }).pipe(Effect.orDie)
    return { inputKey: key, inserted: true }
  }).pipe(
    Effect.withSpan("firegrid.unified.append_input_intent", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": options.contextId,
        "firegrid.input.id": options.inputId,
        "firegrid.input.kind": options.kind,
      },
    }),
  )
