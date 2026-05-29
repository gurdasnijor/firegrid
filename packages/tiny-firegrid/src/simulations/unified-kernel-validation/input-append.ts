/**
 * Atomic input append helper.
 *
 * Pattern from the `tiny-input-append-wakeup` simulation: a single atomic
 * "table method" over `contexts` + `inputs` + `inputIds` ensures
 * idempotent input delivery with sequence allocation, without a bridge
 * table, deferred mailbox, dispatcher fiber, or external sequence
 * allocator.
 *
 *   - Caller-supplied `inputId` is the idempotency index. Duplicate
 *     calls with the same `(contextId, inputId)` return the original
 *     `inputKey` and the original `sequence`.
 *   - Distinct calls reserve a fresh `inputKey = ${contextId}/${sequence}`
 *     by advancing `contexts.nextInputSequence`.
 *
 * The append is paired with the kernel `kernelWriteArm` call at the
 * subscriber boundary — see `subscribers.ts`.
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
  readonly sequence: number
  readonly inserted: boolean
}

const now = (): string => new Date().toISOString()

/**
 * Ensure a context row exists. Idempotent: first caller writes; later
 * callers see the existing row. Required before atomic input append so
 * `nextInputSequence` can be advanced.
 */
export const ensureContext = (options: {
  readonly table: UnifiedTableService
  readonly contextId: string
  readonly agent: string
}): Effect.Effect<void, unknown> =>
  options.table.contexts.insertOrGet({
    contextId: options.contextId,
    agent: options.agent,
    nextInputSequence: 0,
    createdAt: now(),
  }).pipe(Effect.orDie, Effect.asVoid)

/**
 * Atomic append: idempotency dedup + sequence allocation + row write +
 * idempotency-index write + context sequence advance.
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
      const existingRow = yield* options.table.inputs.get(existing.inputKey).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orDie,
      )
      if (existingRow !== undefined) {
        return {
          inputKey: existingRow.inputKey,
          sequence: existingRow.sequence,
          inserted: false,
        }
      }
    }
    // Reserve a fresh sequence by advancing the context's allocator.
    const contextRow = yield* options.table.contexts.get(options.contextId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orDie,
    )
    if (contextRow === undefined) {
      return yield* Effect.die(
        new Error(`appendInputIntent: context ${options.contextId} not found; call ensureContext first`),
      )
    }
    const sequence = contextRow.nextInputSequence
    const key = makeInputKey(options.contextId, sequence)
    yield* options.table.inputs.insertOrGet({
      inputKey: key,
      contextId: options.contextId,
      inputId: options.inputId,
      sequence,
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
    yield* options.table.contexts.upsert({
      ...contextRow,
      nextInputSequence: sequence + 1,
    }).pipe(Effect.orDie)
    return { inputKey: key, sequence, inserted: true }
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
