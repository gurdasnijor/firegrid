import type {
  DurableTableCollection,
  DurableTableCollectionFacade,
  DurableTableInsertOrGetResult,
} from "effect-durable-operators"
import { Effect, Option, PubSub, Ref, Stream } from "effect"

const collectionFromRows = <Row extends object>(
  rows: ReadonlyArray<Row>,
): DurableTableCollection<Row> =>
  ({ toArray: rows }) as unknown as DurableTableCollection<Row>

// LENS: durable-table:self-curry — table factory preserves per-table identity through the provider seam (see LENSES.md)
export const makeMemoryDurableCollectionFacade = <Row extends object, Key extends string>(
  keyOf: (row: Row) => Key,
): Effect.Effect<DurableTableCollectionFacade<Row, Key>> =>
  Effect.gen(function*() {
    const rows = yield* Ref.make(new Map<Key, Row>())
    const changes = yield* PubSub.unbounded<Row>()

    const snapshot = Ref.get(rows).pipe(
      Effect.map(map => [...map.values()]),
    )

    return {
      collection: collectionFromRows<Row>([]),
      // `rows()` models durable stream observation: first replay current rows,
      // then keep tailing live insert/upsert publications. Use `query()` when a
      // configuration needs a terminating snapshot read.
      rows: () =>
        Stream.concat(
          Stream.fromIterableEffect(snapshot),
          Stream.fromPubSub(changes),
        ),
      insert: row =>
        Ref.update(rows, map => {
          const next = new Map(map)
          const key = keyOf(row)
          if (next.has(key)) return next
          next.set(key, row)
          return next
        }).pipe(Effect.zipRight(PubSub.publish(changes, row))),
      insertOrGet: row =>
        Ref.modify(rows, (map): readonly [DurableTableInsertOrGetResult<Row>, Map<Key, Row>] => {
          const key = keyOf(row)
          const existing = map.get(key)
          if (existing !== undefined) {
            return [
              { _tag: "Found", row: existing } satisfies DurableTableInsertOrGetResult<Row>,
              map,
            ]
          }
          const next = new Map(map)
          next.set(key, row)
          return [
            { _tag: "Inserted" } satisfies DurableTableInsertOrGetResult<Row>,
            next,
          ]
        }).pipe(
          Effect.tap(result =>
            result._tag === "Inserted"
              ? PubSub.publish(changes, row)
              : Effect.void),
        ),
      upsert: row =>
        Ref.update(rows, map => {
          const next = new Map(map)
          next.set(keyOf(row), row)
          return next
        }).pipe(Effect.zipRight(PubSub.publish(changes, row))),
      delete: key =>
        Ref.update(rows, map => {
          const next = new Map(map)
          next.delete(key)
          return next
        }),
      get: key =>
        Ref.get(rows).pipe(
          Effect.map(map => Option.fromNullable(map.get(key))),
        ),
      query: build =>
        snapshot.pipe(
          Effect.map(current => build(collectionFromRows(current))),
        ),
      subscribe: <A>(
        subscribe: (
          coll: DurableTableCollection<Row>,
          emit: (value: A) => void,
        ) => () => void,
      ): Stream.Stream<A> =>
        Stream.fromIterableEffect(
          snapshot.pipe(
            Effect.map(current => {
              const emitted: Array<A> = []
              const unsubscribe = subscribe(
                collectionFromRows(current),
                value => emitted.push(value),
              )
              unsubscribe()
              return emitted
            }),
          ),
        ),
    }
  })
