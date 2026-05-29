/**
 * Per-key mutex helper.
 *
 * From the `per-key-subscriber-push-restart` finding (tf-4fy3): the
 * substrate gives "serialization XOR cross-key concurrency, never both."
 * The kernel itself needs same-key write+arm serialization (so a
 * single workflow's commands don't interleave) plus cross-key
 * concurrency (so different workflows don't block each other).
 *
 * Mirrors the production helper at
 * `packages/runtime/src/subscribers/keyed-dispatch/per-key-mutex.ts`;
 * copied here so the simulation is self-contained.
 */

import { Effect, Ref } from "effect"

export interface PerKeyMutex {
  readonly withLock: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export const makePerKeyMutex = (): Effect.Effect<PerKeyMutex> =>
  Effect.gen(function*() {
    const registry = yield* Ref.make(new Map<string, Effect.Semaphore>())
    const semaphoreFor = (key: string): Effect.Effect<Effect.Semaphore> =>
      Effect.gen(function*() {
        const existing = (yield* Ref.get(registry)).get(key)
        if (existing !== undefined) return existing
        const created = yield* Effect.makeSemaphore(1)
        return yield* Ref.modify(registry, (current) => {
          const present = current.get(key)
          if (present !== undefined) return [present, current] as const
          const next = new Map(current)
          next.set(key, created)
          return [created, next] as const
        })
      })
    return {
      withLock: (key, effect) =>
        semaphoreFor(key).pipe(
          Effect.flatMap((semaphore) => semaphore.withPermits(1)(effect)),
        ),
    }
  })
