/**
 * Source-collection registry. Maps a `sourceName` (the value persisted on a
 * wait row) to the corresponding source DurableTable collection facade row
 * observation stream.
 *
 * Implements:
 *  - firegrid-durable-tools.RUNTIME_BOUNDARY.3 — typed facade reference only;
 *    the registry does not accept raw Durable Streams URLs or
 *    `@durable-streams/*` client objects.
 *  - firegrid-durable-tools.SUBSCRIPTION.1 — each subscription is created via
 *    `DurableTableCollectionFacade.rows()` so initial state and live changes
 *    flow through one code path.
 *  - firegrid-durable-tools.SUBSCRIPTION.2 — no snapshot-then-subscribe.
 *  - firegrid-durable-tools.SOURCE_COLLECTIONS.1
 *  - firegrid-durable-tools.SOURCE_COLLECTIONS.2
 */

import {
  type DurableTableCollectionFacade,
  type DurableTableError,
} from "effect-durable-operators"
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Ref,
  type Stream,
} from "effect"

/**
 * A registered source-collection handle. The handle owns its own
 * row observation plumbing; the router consumes the `subscribe()` stream
 * without learning about the underlying TanStack collection.
 */
export interface SourceCollectionHandle {
  readonly name: string
  readonly subscribe: () => Stream.Stream<unknown, DurableTableError>
}

/**
 * firegrid-durable-tools.SUBSCRIPTION.1
 * firegrid-durable-tools.SUBSCRIPTION.2
 *
 * Build a SourceCollectionHandle from a DurableTable collection facade.
 */
export const sourceCollectionHandle = <Row extends object, Key>(
  name: string,
  facade: DurableTableCollectionFacade<Row, Key>,
): SourceCollectionHandle => ({
  name,
  subscribe: () => facade.rows(),
})

export interface SourceCollectionsService {
  /**
   * Register a source-collection handle. Resolves any pending `await`
   * callers for the same name. firegrid-durable-tools.RUNTIME_BOUNDARY.3
   */
  readonly register: (
    handle: SourceCollectionHandle,
  ) => Effect.Effect<void>
  /**
   * Wait for a source-collection handle to be registered. If the handle is
   * already registered, returns immediately. Otherwise, suspends until
   * `register` is called for the given name. This is the canonical lookup
   * path used by the router so a wait that arrives before its source is
   * registered does not get permanently dropped (startup ordering).
   */
  readonly awaitHandle: (
    name: string,
  ) => Effect.Effect<SourceCollectionHandle>
}

export class SourceCollections extends Context.Tag(
  "@firegrid/runtime/durable-tools/SourceCollections",
)<SourceCollections, SourceCollectionsService>() {}

interface SourceEntry {
  readonly deferred: Deferred.Deferred<SourceCollectionHandle>
  handle: SourceCollectionHandle | undefined
}

const makeSourceCollections = Effect.gen(function*() {
  // One entry per source name. The entry's Deferred is the rendezvous: it
  // resolves with the handle the first time `register` is called, and any
  // `awaitHandle` caller that arrives before registration blocks on it. We
  // keep the resolved handle on the entry so further `awaitHandle` calls
  // (after registration) can skip the Deferred and return immediately.
  const ref = yield* Ref.make(new Map<string, SourceEntry>())

  const entryFor = (name: string) =>
    Effect.gen(function*() {
      const map = yield* Ref.get(ref)
      const existing = map.get(name)
      if (existing !== undefined) return existing
      const deferred = yield* Deferred.make<SourceCollectionHandle>()
      const next: SourceEntry = { deferred, handle: undefined }
      yield* Ref.update(ref, (m) => {
        if (m.has(name)) return m
        const updated = new Map(m)
        updated.set(name, next)
        return updated
      })
      // After the update, another caller may have raced ahead; re-read to
      // ensure we surface the canonical entry.
      const reread = (yield* Ref.get(ref)).get(name)
      return reread ?? next
    })

  return SourceCollections.of({
    register: (handle) =>
      Effect.gen(function*() {
        const entry = yield* entryFor(handle.name)
        if (entry.handle !== undefined) return
        entry.handle = handle
        yield* Deferred.succeed(entry.deferred, handle)
      }),
    awaitHandle: (name) =>
      Effect.gen(function*() {
        const entry = yield* entryFor(name)
        if (entry.handle !== undefined) return entry.handle
        return yield* Deferred.await(entry.deferred)
      }),
  })
})

/**
 * firegrid-durable-tools.RUNTIME_BOUNDARY.4
 *
 * Layer-scoped: provided once per runtime host.
 */
export const SourceCollectionsLive = Layer.effect(
  SourceCollections,
  makeSourceCollections,
)
