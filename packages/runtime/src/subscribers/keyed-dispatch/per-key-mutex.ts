import { Effect, Ref } from "effect"

// A per-key mutex registry. One `Effect.Semaphore(1)` per key, created on
// first sight; `withKey(k, eff)` runs `eff` while holding key `k`'s permit so
// same-key effects are serialized and different-key effects run independently.
//
// This is the subscriber-runtime side of `runtime-design-constraints.md` C1
// ("all mutations for the same key are serialized by the runtime owner") —
// substrate per-key producer fencing covers writes, but subscriber-side
// handler serialization is the subscriber's job. tf-4fy3 proved this is the
// ONLY structural delta between an unserialized concurrent tail (per-key
// double-process) and a correct keyed subscriber (per-key serial, cross-key
// concurrent).
//
// The registry holds entries forever today. RuntimeContext keyspace is bounded
// to live `contextId`s during the host process; entries are not large. A future
// lifecycle hook (release-on-context-closed) is a downstream concern, not part
// of the helper's minimal surface.

export interface PerKeyMutex<K> {
  /**
   * Acquire `key`'s permit, run `effect`, release. Same-key invocations are
   * serialized FIFO by the underlying semaphore; different-key invocations
   * never contend with each other.
   */
  readonly withKey: <A, E, R>(
    key: K,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export const makePerKeyMutex = <K>(): Effect.Effect<PerKeyMutex<K>> =>
  Effect.gen(function*() {
    // The registry value is a plain Map; the Ref ensures atomic install of new
    // entries under concurrent first-sight access.
    const registry = yield* Ref.make(new Map<K, Effect.Semaphore>())
    const semaphoreFor = (key: K): Effect.Effect<Effect.Semaphore> =>
      Effect.gen(function*() {
        const existing = (yield* Ref.get(registry)).get(key)
        if (existing !== undefined) return existing
        // Create speculatively, then install atomically. `Ref.modify` is a
        // single read-write so we either install OURS and return it, or the
        // map already had one (a concurrent caller beat us) and we return
        // THAT one so every caller shares one permit per key. The unused
        // speculative semaphore is harmless if we lose the race.
        const created = yield* Effect.makeSemaphore(1)
        return yield* Ref.modify(registry, current => {
          const present = current.get(key)
          if (present !== undefined) return [present, current] as const
          const next = new Map(current)
          next.set(key, created)
          return [created, next] as const
        })
      })
    return {
      withKey: (key, effect) =>
        semaphoreFor(key).pipe(
          Effect.flatMap(semaphore => semaphore.withPermits(1)(effect)),
        ),
    }
  })
