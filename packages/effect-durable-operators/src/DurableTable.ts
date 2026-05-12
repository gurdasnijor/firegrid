/**
 * DurableTable — typed Effect facade over `@durable-streams/state`'s
 * `createStreamDB`. Not a new materialization engine.
 *
 * Implements:
 *  - effect-durable-operators.TABLE.1 — facade, no new engine
 *  - effect-durable-operators.TABLE.2 — Effect Schema in, Standard Schema only
 *    at the `@durable-streams/state` boundary
 *  - effect-durable-operators.TABLE.3 — Scope-managed; preload on acquire,
 *    close on finalization; awaitTxId surfaced as Effect
 *  - effect-durable-operators.TABLE.4 — multi-collection pull/push helpers,
 *    no re-folding of retained history
 *  - effect-durable-operators.TABLE.5 — replay rebuilds state through
 *    createStreamDB cold-start; verified in test.
 */

import type { ChangeEvent } from "@durable-streams/state"
import { createStreamDB } from "@durable-streams/state"
import type { Collection as TanStackCollection } from "@tanstack/db"
import {
  Effect,
  Option,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { DurableTableError } from "./Errors.ts"

// ---------------------------------------------------------------------------
// Definitions are plain values (SDD §API Sketch — Definitions Are Values).
// `collection(...)` and `collections(...)` produce typed metadata that
// `materialize(...)` later converts to a Standard-Schema-shaped
// CollectionDefinition for createStreamDB.
// ---------------------------------------------------------------------------

export interface CollectionDefinition<
  Row extends object,
  Key extends keyof Row & string,
> {
  readonly type: string
  readonly schema: Schema.Schema<Row, unknown>
  readonly primaryKey: Key
  /** Construct a State Protocol `insert` change event for this collection. */
  readonly insert: (row: Row) => ChangeEvent<Row>
  /** Construct a State Protocol `update` change event. */
  readonly update: (row: Row, oldValue?: Row) => ChangeEvent<Row>
  /** Construct a State Protocol `delete` change event. */
  readonly delete: (key: Row[Key] & (string | number), oldValue?: Row) => ChangeEvent<Row>
  /** Construct a State Protocol `upsert` change event. */
  readonly upsert: (row: Row) => ChangeEvent<Row>
}

export interface CollectionOptions<
  Row extends object,
  Key extends keyof Row & string,
  I,
> {
  readonly type: string
  readonly schema: Schema.Schema<Row, I>
  readonly primaryKey: Key
}

const keyString = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : JSON.stringify(value)

/**
 * Define a typed collection. Schema is Effect Schema; primaryKey is
 * compile-time-validated against the row type.
 */
export const collection = <
  Row extends object,
  Key extends keyof Row & string,
  I,
>(opts: CollectionOptions<Row, Key, I>): CollectionDefinition<Row, Key> => {
  const { type, schema, primaryKey } = opts
  // The change-event helpers are *plain* constructors. They do not perform
  // schema validation at construction time — encoding happens at the
  // append boundary, mirroring `@durable-streams/state`'s helper shape.
  return {
    type,
    schema: schema as Schema.Schema<Row, unknown>,
    primaryKey,
    insert: (row) => ({
      type,
      key: keyString(row[primaryKey]),
      value: row,
      headers: { operation: "insert" },
    }),
    update: (row, oldValue) => ({
      type,
      key: keyString(row[primaryKey]),
      value: row,
      ...(oldValue !== undefined ? { old_value: oldValue } : {}),
      headers: { operation: "update" },
    }),
    delete: (key, oldValue) => ({
      type,
      key: keyString(key),
      ...(oldValue !== undefined ? { old_value: oldValue } : {}),
      headers: { operation: "delete" },
    }),
    upsert: (row) => ({
      type,
      key: keyString(row[primaryKey]),
      value: row,
      headers: { operation: "upsert" },
    }),
  }
}

// CollectionMap holds heterogeneous per-collection types. `any` here is the
// type-level "wildcard"; precise per-collection inference is restored by the
// `keyof C` lookups in DurableTable's method signatures (Row/Key are
// recovered through `RowOf`/`KeyOf`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CollectionMap = Record<string, CollectionDefinition<any, any>>

export interface Collections<C extends CollectionMap> {
  readonly collections: C
}

export const collections = <C extends CollectionMap>(map: C): Collections<C> => ({
  collections: map,
})

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

// `@durable-streams/state`'s `streamOptions` shape comes from
// `@durable-streams/client.DurableStreamOptions`. We accept it opaquely so
// callers can pass exactly what they would pass to `createStreamDB`.
export interface StreamOptions {
  readonly url: string
  readonly contentType?: string
  // Allow upstream additions without rev-locking this package.
  readonly [extra: string]: unknown
}

export interface MaterializeOptions<C extends CollectionMap> {
  readonly streamOptions: StreamOptions
  readonly collections: Collections<C>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RowOf<D> = D extends CollectionDefinition<infer R, any> ? R : never
type KeyOf<D> =
  D extends CollectionDefinition<infer R, infer K> ? R[K] : never

export interface DurableTable<C extends CollectionMap> {
  /** Snapshot get by primary key. */
  readonly get: <Name extends keyof C & string>(
    name: Name,
    key: KeyOf<C[Name]>,
  ) => Effect.Effect<Option.Option<RowOf<C[Name]>>, DurableTableError>
  /** Run a synchronous query over the live TanStack DB collection. */
  readonly query: <Name extends keyof C & string, A>(
    name: Name,
    build: (coll: TanStackCollection<RowOf<C[Name]> & object, string>) => A,
  ) => Effect.Effect<A, DurableTableError>
  /**
   * Subscribe to a collection's change events as an Effect Stream.
   * The `subscribe` callback wires a TanStack subscription that pushes
   * derived values into the stream.
   */
  readonly changes: <Name extends keyof C & string, A>(
    name: Name,
    subscribe: (
      coll: TanStackCollection<RowOf<C[Name]> & object, string>,
      emit: (value: A) => void,
    ) => () => void,
  ) => Stream.Stream<A, DurableTableError>
  /** Wait until a given txid has been synced through the underlying stream. */
  readonly awaitTxId: (txid: string, timeoutMs?: number) => Effect.Effect<void, DurableTableError>
}

const toStandardSchemaCollection = <Row extends object, Key extends keyof Row & string>(
  def: CollectionDefinition<Row, Key>,
) => ({
  type: def.type,
  primaryKey: def.primaryKey,
  // Translation point: Effect Schema → Standard Schema lives here, at the
  // createStreamDB boundary, per SDD §Schema Strategy + TABLE.2.
  schema: Schema.standardSchemaV1(def.schema),
})

/**
 * Materialize a durable table. Returns a Scope-managed DurableTable.
 *
 * `preload` runs on acquire so the returned table is queryable without
 * application code repeatedly reading retained history. `close` runs on
 * scope finalization.
 */
export const materialize = <C extends CollectionMap>(
  opts: MaterializeOptions<C>,
): Effect.Effect<DurableTable<C>, DurableTableError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const state = Object.fromEntries(
          Object.entries(opts.collections.collections).map(([name, def]) => [
            name,
            toStandardSchemaCollection(def),
          ]),
        )
        return createStreamDB({
          streamOptions: opts.streamOptions,
          state,
        })
      },
      catch: (cause) =>
        new DurableTableError({ table: "(materialize)", cause }),
    }).pipe(
      Effect.tap((db) =>
        Effect.tryPromise({
          try: () => db.preload(),
          catch: (cause) =>
            new DurableTableError({ table: "(preload)", cause }),
        }),
      ),
    ),
    (db) =>
      Effect.sync(() => {
        db.close()
      }),
  ).pipe(
    Effect.map((db) => {
      const getColl = <Name extends keyof C & string>(name: Name) => {
        const c = (db.collections as Record<string, unknown>)[name]
        return c === undefined
          ? Effect.fail(
              new DurableTableError({
                table: String(name),
                cause: `unknown collection: ${String(name)}`,
              }),
            )
          : Effect.succeed(
              c as unknown as TanStackCollection<RowOf<C[Name]> & object, string>,
            )
      }

      return {
        get: <Name extends keyof C & string>(name: Name, key: KeyOf<C[Name]>) =>
          Effect.flatMap(getColl(name), (coll) =>
            Effect.try({
              try: () => {
                const value = coll.get(keyString(key))
                return value === undefined
                  ? Option.none<RowOf<C[Name]>>()
                  : Option.some(value)
              },
              catch: (cause) =>
                new DurableTableError({ table: String(name), cause }),
            }),
          ),

        query: <Name extends keyof C & string, A>(
          name: Name,
          build: (coll: TanStackCollection<RowOf<C[Name]> & object, string>) => A,
        ) =>
          Effect.flatMap(getColl(name), (coll) =>
            Effect.try({
              try: () => build(coll),
              catch: (cause) =>
                new DurableTableError({ table: String(name), cause }),
            }),
          ),

        changes: <Name extends keyof C & string, A>(
          name: Name,
          subscribe: (
            coll: TanStackCollection<RowOf<C[Name]> & object, string>,
            emit: (value: A) => void,
          ) => () => void,
        ) =>
          Stream.unwrap(
            Effect.map(getColl(name), (coll) =>
              Stream.async<A, DurableTableError>((emit) => {
                let unsubscribe: (() => void) | undefined
                try {
                  unsubscribe = subscribe(coll, (value) => {
                    void emit.single(value)
                  })
                } catch (cause) {
                  void emit.fail(
                    new DurableTableError({ table: String(name), cause }),
                  )
                  return
                }
                return Effect.sync(() => {
                  if (unsubscribe !== undefined) unsubscribe()
                })
              }),
            ),
          ),

        awaitTxId: (txid: string, timeoutMs?: number) =>
          Effect.tryPromise({
            try: () => db.utils.awaitTxId(txid, timeoutMs),
            catch: (cause) =>
              new DurableTableError({ table: "(awaitTxId)", cause }),
          }),
      } satisfies DurableTable<C>
    }),
  )
