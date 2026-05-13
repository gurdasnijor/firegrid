/**
 * Source-collection registry. Maps a `sourceName` (the value persisted on a
 * wait row) to the corresponding source DurableTable collection facade and
 * its `subscribeChanges` lifecycle.
 *
 * Implements:
 *  - firegrid-durable-tools.RUNTIME_BOUNDARY.3 — typed facade reference only;
 *    the registry does not accept raw Durable Streams URLs or
 *    `@durable-streams/*` client objects.
 *  - firegrid-durable-tools.SUBSCRIPTION.1 — each subscription is created via
 *    `subscribeChanges(..., { includeInitialState: true })` so initial state
 *    and live changes flow through one code path.
 *  - firegrid-durable-tools.SUBSCRIPTION.2 — no snapshot-then-subscribe.
 */

import {
  type DurableTableCollectionFacade,
  type DurableTableError,
} from "effect-durable-operators"
import { Context, Effect, Layer, Option, Ref, type Stream } from "effect"

/**
 * A registered source-collection handle. The handle owns its own
 * subscribeChanges plumbing; the router consumes the `subscribe()` stream
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
 * Build a SourceCollectionHandle from a DurableTable collection facade. The
 * resulting Stream emits each non-deleted row value once when the collection
 * is first observed (includeInitialState) and again whenever it changes.
 */
export const sourceCollectionHandle = <Row extends object, Key>(
  name: string,
  facade: DurableTableCollectionFacade<Row, Key>,
): SourceCollectionHandle => ({
  name,
  subscribe: () =>
    facade.subscribe<Row>((coll, emit) => {
      const sub = coll.subscribeChanges(
        (changes) => {
          changes.forEach((change) => {
            if (change.value === undefined || change.value === null) return
            emit(change.value)
          })
        },
        { includeInitialState: true },
      )
      return () => sub.unsubscribe()
    }),
})

export interface SourceCollectionsService {
  readonly register: (
    handle: SourceCollectionHandle,
  ) => Effect.Effect<void>
  readonly lookup: (
    name: string,
  ) => Effect.Effect<Option.Option<SourceCollectionHandle>>
}

export class SourceCollections extends Context.Tag(
  "@firegrid/runtime/durable-tools/SourceCollections",
)<SourceCollections, SourceCollectionsService>() {}

const makeSourceCollections = Effect.gen(function*() {
  const ref = yield* Ref.make(
    new Map<string, SourceCollectionHandle>(),
  )
  return SourceCollections.of({
    register: (handle) =>
      Ref.update(ref, (map) => {
        const next = new Map(map)
        next.set(handle.name, handle)
        return next
      }),
    lookup: (name) =>
      Effect.map(Ref.get(ref), (map) => Option.fromNullable(map.get(name))),
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
