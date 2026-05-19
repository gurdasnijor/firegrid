import { Clock, Effect, Option } from "effect"

export const waitRowId = (waitKey: { readonly executionId: string; readonly name: string }): string =>
  `${waitKey.executionId}/${waitKey.name}`

export const emitSpanEvent = (
  name: string,
  attributes: Record<string, unknown>,
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const maybeSpan = yield* Effect.option(Effect.currentSpan)
    if (Option.isNone(maybeSpan)) return
    const nowMs = yield* Clock.currentTimeMillis
    maybeSpan.value.event(name, BigInt(nowMs) * 1_000_000n, attributes)
  })
