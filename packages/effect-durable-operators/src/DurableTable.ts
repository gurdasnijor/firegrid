/**
 * DurableTable — ksql-inspired table declaration and action facade over
 * `@durable-streams/state`'s `createStreamDB`.
 *
 * Implements:
 *  - effect-durable-operators.TABLE.1 — facade, no new engine
 *  - effect-durable-operators.TABLE.2 — Effect Schema in, Standard Schema only
 *    at the `@durable-streams/state` boundary
 *  - effect-durable-operators.TABLE.3 — Scope-managed; preload on acquire,
 *    close on finalization; txid coordination through Effect
 *  - effect-durable-operators.TABLE.4 — pull/push helpers, no re-folding
 *  - effect-durable-operators.TABLE.5 — replay rebuilds state through
 *    createStreamDB cold-start
 *  - effect-durable-operators.TABLE.6 — declaration returns an Effect service
 *    tag class with a Layer constructor
 *  - effect-durable-operators.TABLE.7 — primary key is field schema metadata
 *  - effect-durable-operators.TABLE.8 — exactly one primary key per collection
 *  - effect-durable-operators.TABLE.9 — durable type is namespace.collection
 *  - effect-durable-operators.TABLE.10 — per-collection facade methods
 *  - effect-durable-operators.TABLE.11 — insert/upsert/delete writes use
 *    createStreamDB actions
 *  - effect-durable-operators.TABLE.12 — insert/upsert/delete writes attach
 *    txid headers and await createStreamDB awaitTxId
 *  - effect-durable-operators.TABLE.13 — no wire type/action overrides
 *  - effect-durable-operators.TABLE.14 — no package-owned append helper path
 *  - effect-durable-operators.TABLE.15 — change events come from
 *    createStateSchema collection helpers
 *  - effect-durable-operators.TABLE.16 — primaryKey wraps the field schema
 *    with a Schema.transform so its encoded form is a string; the package's
 *    primary-key annotation is preserved for AST discovery
 *  - effect-durable-operators.TABLE.17 — composite primary keys are declared
 *    as Schema.transform schemas; no runtime separator concatenation
 *  - effect-durable-operators.TABLE.18 — primary-key values are encoded
 *    through the field schema (Schema.encodeSync); no string-coercion helper
 *  - effect-durable-operators.TABLE.21 — collection facades expose a
 *    read-only TanStack collection view for query engines and UI bindings
 *  - effect-durable-operators.TABLE.22 — read-only collection views decode
 *    primary-key fields before exposing rows to query and subscription users
 *  - effect-durable-operators.TABLE.23 — synchronous TanStack mutation
 *    rejection throws DurableTableError directly (no FiberFailure wrap)
 *  - effect-durable-operators.TABLE.24 — non-string encoded primary-key
 *    values fail loudly with a typed DurableTableError; no String() fallback
 *  - effect-durable-operators.TABLE.25 — get/upsert/delete agree with
 *    query.toArray for Schema.transformOrFail JSON-tuple composite keys
 *  - effect-durable-operators.TABLE.26 — insertOrGet inserts absent rows and
 *    observes existing rows without silent replacement
 */

import type { DurableStreamOptions } from "@durable-streams/client"
import { FetchHttpClient } from "@effect/platform"
import {
  createStateSchema,
  createStreamDB,
  type ActionDefinition,
  type ActionFactory,
  type CollectionDefinition as StateCollectionDefinition,
  type CreateStreamDBOptions,
  type Operation,
  type StateSchema,
  type StreamDBWithActions,
  type StreamStateDefinition,
} from "@durable-streams/state"
import type {
  ChangeMessage,
  Collection as TanStackCollection,
} from "@tanstack/db"
import { DurableStream } from "effect-durable-streams"
import {
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { DurableTableError } from "./Errors.ts"

const primaryKeyAnnotationId = Symbol.for(
  "effect-durable-operators/DurableTable/primaryKey",
)
declare const primaryKeyTypeId: unique symbol

interface PrimaryKeyField<DecodedKey> {
  readonly [primaryKeyTypeId]: DecodedKey
}

// `Schema.Struct<any>` is the practical top type for Struct schemas here:
// Effect Schema's annotation methods are contravariant in their annotation
// parameter, so a more "precise" index-signature field type rejects ordinary
// concrete structs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StructSchema = Schema.Struct<any>
type TableSchemas<Schemas> = {
  readonly [Key in keyof Schemas]: StructSchema
}
type AnyTableSchemas = Record<string, StructSchema>

export type RowOf<S extends Schema.Schema.All> = Schema.Schema.Type<S>

type FieldsOf<S> = S extends Schema.Struct<infer Fields> ? Fields : never
type PrimaryKeyNameOf<S> = {
  readonly [Key in keyof FieldsOf<S>]: FieldsOf<S>[Key] extends PrimaryKeyField<unknown>
    ? Key
    : never
}[keyof FieldsOf<S>] & string

export type PrimaryKeyOf<S extends StructSchema> =
  PrimaryKeyNameOf<S> extends keyof FieldsOf<S>
    ? Schema.Schema.Type<FieldsOf<S>[PrimaryKeyNameOf<S>]>
    : never

export interface LayerOptions {
  readonly streamOptions: DurableStreamOptions
  readonly txTimeoutMs?: number
}

export type DurableTableHeaders = Readonly<
  Record<string, string | (() => string | Promise<string>)>
>

export type DurableTableCollection<Row extends object> =
  TanStackCollection<Row, string>

export type InsertOrGetResult<Row> =
  | { readonly _tag: "Inserted" }
  | { readonly _tag: "Found"; readonly row: Row }

export interface CollectionFacade<Row extends object, Key> {
  /**
   * Read-only TanStack collection view for query engines and UI bindings.
   *
   * effect-durable-operators.TABLE.21
   * effect-durable-operators.TABLE.22
   *
   * This collection decodes DurableTable primary-key fields on reads and
   * subscriptions. Data mutations through the collection view fail loudly;
   * callers must use the generated DurableTable insert/upsert/delete actions
   * so txid coordination and State Protocol event construction remain intact.
   */
  readonly collection: DurableTableCollection<Row>
  /**
   * Current non-deleted rows plus live non-deleted row changes.
   *
   * effect-durable-operators.TABLE.28
   * effect-durable-operators.TABLE.28-1
   */
  readonly rows: () => Stream.Stream<Row, DurableTableError>
  readonly insert: (row: Row) => Effect.Effect<void, DurableTableError>
  /**
   * Row-level insert-or-read by primary key.
   *
   * effect-durable-operators.TABLE.26
   * effect-durable-operators.TABLE.26-8
   *
   * This is not a lock, claim, mutex, semaphore, lease, or general
   * coordination primitive.
   */
  readonly insertOrGet: (
    row: Row,
  ) => Effect.Effect<InsertOrGetResult<Row>, DurableTableError>
  readonly upsert: (row: Row) => Effect.Effect<void, DurableTableError>
  readonly delete: (key: Key) => Effect.Effect<void, DurableTableError>
  readonly get: (key: Key) => Effect.Effect<Option.Option<Row>, DurableTableError>
  readonly query: <A>(
    build: (coll: TanStackCollection<Row, string>) => A,
  ) => Effect.Effect<A, DurableTableError>
  readonly subscribe: <A>(
    subscribe: (
      coll: TanStackCollection<Row, string>,
      emit: (value: A) => void,
    ) => () => void,
  ) => Stream.Stream<A, DurableTableError>
}

export type DurableTableService<Schemas extends TableSchemas<Schemas>> = {
  readonly [Name in keyof Schemas & string]: CollectionFacade<
    RowOf<Schemas[Name]> & object,
    PrimaryKeyOf<Schemas[Name]>
  >
} & {
  readonly awaitTxId: (
    txid: string,
    timeoutMs?: number,
  ) => Effect.Effect<void, DurableTableError>
}

// `Self` is bound to the resulting tag class so consumers' Effects that
// `yield* MyTable` get a precise requirements channel instead of `unknown`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DurableTableTagClass<Schemas extends TableSchemas<Schemas>, Self = any> =
  Context.TagClass<
    Self,
    string,
    DurableTableService<Schemas>
  > & {
    readonly namespace: string
    readonly layer: (
      options: LayerOptions,
    ) => Layer.Layer<Self, DurableTableError>
  }

type CompiledCollection = {
  readonly collectionKey: string
  readonly durableType: string
  readonly primaryKey: string
  readonly schema: StructSchema
  // Returns the schema-encoded primary-key value as-is. Callers that need
  // the durable-wire string form route through `requireString`, which
  // raises a typed DurableTableError on non-string values.
  readonly encodePrimaryKey: (decoded: unknown) => unknown
  readonly decodePrimaryKey: (encoded: string) => unknown
}

type CompiledTable<Schemas extends TableSchemas<Schemas>> = {
  readonly namespace: string
  readonly schemas: Schemas
  readonly collections: ReadonlyArray<CompiledCollection>
}

type StateSchemaWithHelpers = StateSchema<StreamStateDefinition>
type GeneratedOperation = Extract<Operation, "insert" | "upsert" | "delete">
type TableActionDefinitions = Record<string, ActionDefinition<unknown>>
type TableActionFactory = ActionFactory<
  StateSchemaWithHelpers,
  TableActionDefinitions
>
type TableStreamDB = StreamDBWithActions<
  StateSchemaWithHelpers,
  TableActionDefinitions
>
type TableActionMap = TableStreamDB["actions"]

const reservedFacadeProperties = new Set(["awaitTxId"])

/**
 * effect-durable-operators.TABLE.16
 *
 * `primaryKey` wraps the underlying field schema with a `Schema.transform`
 * whose encoded form is a string, then attaches the package-owned annotation
 * used for AST-level primary-key discovery.
 *
 * - The pipeable form is the primary path: `Schema.String.pipe(primaryKey)`.
 * - For non-string-decoded primary keys, the user composes a Schema.transform
 *   themselves (e.g., for composite keys) and pipes it through `primaryKey`.
 *   The package never concatenates key parts at runtime.
 */
const primaryKey = <S extends Schema.Schema.Any>(
  schema: S,
): Schema.transform<typeof Schema.String, S> &
  PrimaryKeyField<Schema.Schema.Type<S>> => {
  // The transform threads the inner schema's encoded representation through
  // a `Schema.String` outer schema. For inner schemas whose encoded form is
  // already string (Schema.String, branded strings, or user-supplied
  // composite-key Schema.transform / Schema.transformOrFail), the threading
  // is identity. Non-string encoded forms fall through to `requireString` at
  // the action boundary, which raises a typed DurableTableError with the
  // durable type + field name.
  const transformed = Schema.transform(Schema.String, schema, {
    strict: false,
    decode: (_fromA: string, fromI: string): unknown => fromI,
    encode: (toI: unknown, _toA: unknown): string => toI as string,
  })
  return transformed.annotations({
    [primaryKeyAnnotationId]: true,
  }) as Schema.transform<typeof Schema.String, S> &
    PrimaryKeyField<Schema.Schema.Type<S>>
}

const raise = (message: string): never => {
  throw new Error(message)
}

const isPrimaryKeyField = (schema: Schema.Schema.Any): boolean =>
  schema.ast.annotations[primaryKeyAnnotationId] === true

const actionName = (
  collectionKey: string,
  operation: GeneratedOperation,
): string => `${collectionKey}.${operation}`

// effect-durable-operators.TABLE.24
const requireString = (
  collection: CompiledCollection,
  value: unknown,
): string => {
  if (typeof value !== "string") {
    return raise(
      `DurableTable("${collection.durableType}") primary-key field "${collection.primaryKey}" must encode to a string; got ${typeof value}`,
    )
  }
  return value
}

const compileTable = <const Schemas extends TableSchemas<Schemas>>(
  namespace: string,
  schemas: Schemas,
): CompiledTable<Schemas> => {
  const collections = Object.entries(schemas).map(([collectionKey, schemaValue]) => {
    const schema = schemaValue as StructSchema
    if (reservedFacadeProperties.has(collectionKey)) {
      return raise(
        `DurableTable("${namespace}") collection "${collectionKey}" collides with a table service property`,
      )
    }

    const fieldEntries = Object.entries(schema.fields) as Array<
      readonly [string, Schema.Schema.Any]
    >
    const primaryKeyEntries = fieldEntries.filter(([, fieldSchema]) =>
      isPrimaryKeyField(fieldSchema))

    if (primaryKeyEntries.length !== 1) {
      return raise(
        `DurableTable("${namespace}").${collectionKey} must declare exactly one DurableTable.primaryKey field; found ${primaryKeyEntries.length}`,
      )
    }

    const [primaryKeyName, primaryKeyFieldSchema] = primaryKeyEntries[0]!
    const fieldSchema = primaryKeyFieldSchema as Schema.Schema<unknown, unknown, never>
    // effect-durable-operators.TABLE.18
    // Capture encode/decode closures so action paths can run them in plain
    // promise contexts without needing Effect or per-call schema resolution.
    const encodeFn = Schema.encodeSync(fieldSchema)
    const decodeFn = Schema.decodeSync(fieldSchema)

    return {
      collectionKey,
      durableType: `${namespace}.${collectionKey}`,
      primaryKey: primaryKeyName,
      schema,
      // effect-durable-operators.TABLE.18 — primary-key values are encoded
      // through the field schema as-is. Non-string encoded values are
      // rejected by `requireString` at the action boundary; the package
      // contains no String(...) coercion fallback.
      encodePrimaryKey: (value: unknown) => encodeFn(value),
      decodePrimaryKey: (encoded: string) => decodeFn(encoded),
    } satisfies CompiledCollection
  })

  return { namespace, schemas, collections }
}

const makeStateDefinition = (
  table: CompiledTable<AnyTableSchemas>,
): StreamStateDefinition =>
  Object.fromEntries(
    table.collections.map(
      (collection): [string, StateCollectionDefinition] => [
        collection.collectionKey,
        {
          // effect-durable-operators.TABLE.9
          type: collection.durableType,
          primaryKey: collection.primaryKey,
          // effect-durable-operators.TABLE.2
          schema: Schema.standardSchemaV1(
            collection.schema as unknown as Schema.Schema<object, unknown, never>,
          ),
        },
      ],
    ),
  )

const makeStateSchema = (
  table: CompiledTable<AnyTableSchemas>,
): StateSchemaWithHelpers => createStateSchema(makeStateDefinition(table))

/**
 * effect-durable-operators.TABLE.18
 *
 * Returns a row whose primary-key field has been pre-encoded to its string
 * wire form. @durable-streams/state's TanStack DB wiring uses
 * `String(row[primaryKey])` to derive the collection index key; replacing the
 * field's decoded value with the schema-encoded string keeps composite-key
 * lookups consistent with the durable wire format.
 */
const encodeRowForStore = (
  collection: CompiledCollection,
  row: object,
): { encoded: object; encodedKey: string } => {
  const decoded = (row as Record<string, unknown>)[collection.primaryKey]
  const encodedKey = requireString(
    collection,
    collection.encodePrimaryKey(decoded),
  )
  const encoded = { ...row, [collection.primaryKey]: encodedKey }
  return { encoded, encodedKey }
}

const makeActionDefinitions = (
  table: CompiledTable<AnyTableSchemas>,
  stateSchema: StateSchemaWithHelpers,
  txTimeoutMs: number,
): TableActionFactory =>
  ({ db, stream }) =>
    table.collections.reduce<TableActionDefinitions>(
      (actions, collection) => {
        const coll = db.collections[collection.collectionKey]!
        const helpers = stateSchema[collection.collectionKey]!

        actions[actionName(collection.collectionKey, "insert")] = {
          onMutate: (params: unknown) => {
            const { encoded } = encodeRowForStore(collection, params as object)
            coll.insert(encoded)
          },
          mutationFn: async (params: unknown) => {
            const { encoded } = encodeRowForStore(collection, params as object)
            const txid = crypto.randomUUID()
            const event = helpers.insert({
              value: encoded,
              headers: { txid },
            })
            // effect-durable-operators.TABLE.11
            // effect-durable-operators.TABLE.12
            // effect-durable-operators.TABLE.15
            await stream.append(JSON.stringify(event))
            await db.utils.awaitTxId(txid, txTimeoutMs)
          },
        }

        actions[actionName(collection.collectionKey, "upsert")] = {
          onMutate: (params: unknown) => {
            const { encoded, encodedKey } = encodeRowForStore(
              collection,
              params as object,
            )
            if (coll.get(encodedKey) === undefined) {
              coll.insert(encoded)
            } else {
              coll.update(encodedKey, (draft) => {
                Object.assign(draft, encoded)
              })
            }
          },
          mutationFn: async (params: unknown) => {
            const { encoded } = encodeRowForStore(collection, params as object)
            const txid = crypto.randomUUID()
            const event = helpers.upsert({
              value: encoded,
              headers: { txid },
            })
            // effect-durable-operators.TABLE.15
            await stream.append(JSON.stringify(event))
            await db.utils.awaitTxId(txid, txTimeoutMs)
          },
        }

        actions[actionName(collection.collectionKey, "delete")] = {
          onMutate: (params: unknown) => {
            const encodedKey = requireString(
              collection,
              collection.encodePrimaryKey(params),
            )
            if (coll.get(encodedKey) !== undefined) {
              coll.delete(encodedKey)
            }
          },
          mutationFn: async (params: unknown) => {
            const encodedKey = requireString(
              collection,
              collection.encodePrimaryKey(params),
            )
            const txid = crypto.randomUUID()
            const event = helpers.delete({
              key: encodedKey,
              headers: { txid },
            })
            // effect-durable-operators.TABLE.15
            await stream.append(JSON.stringify(event))
            await db.utils.awaitTxId(txid, txTimeoutMs)
          },
        }
        return actions
      },
      {},
    )

const runAction = (
  tableName: string,
  collection: CompiledCollection,
  actions: TableActionMap,
  operation: GeneratedOperation,
  params: unknown,
): Effect.Effect<void, DurableTableError> =>
  Effect.tryPromise({
    try: async () => {
      const name = actionName(collection.collectionKey, operation)
      const action = actions[name]
      if (action === undefined) {
        await Promise.reject(new Error(`unknown DurableTable action: ${name}`))
        return
      }
      await action(params).isPersisted.promise
    },
    catch: (cause) => new DurableTableError({ table: tableName, cause }),
  }).pipe(
    Effect.asVoid,
    Effect.withSpan("firegrid.durable_table.action", {
      kind: "internal",
      attributes: {
        "firegrid.durable_table.name": tableName,
        "firegrid.durable_table.collection": collection.collectionKey,
        "firegrid.durable_table.durable_type": collection.durableType,
        "firegrid.durable_table.primary_key": collection.primaryKey,
        "firegrid.durable_table.operation": operation,
      },
    }),
  )

/**
 * effect-durable-operators.TABLE.18
 *
 * On read, the stored row carries the encoded-string primary-key value. To
 * preserve the user-facing row type (whose primary-key field is the decoded
 * form), decode the field back before returning to callers.
 */
const decodeRowForRead = <Row extends object>(
  collection: CompiledCollection,
  stored: Row,
): Row => {
  const encoded = (stored as Record<string, unknown>)[collection.primaryKey]
  if (typeof encoded !== "string") return stored
  const decoded = collection.decodePrimaryKey(encoded)
  return { ...stored, [collection.primaryKey]: decoded }
}

const decodeChangeForRead = <Row extends object>(
  collection: CompiledCollection,
  change: ChangeMessage<Row>,
): ChangeMessage<Row> => ({
  ...change,
  value: decodeRowForRead(collection, change.value),
  ...(change.previousValue === undefined
    ? {}
    : { previousValue: decodeRowForRead(collection, change.previousValue) }),
})

const encodeHeaderFragment = (value: string): string =>
  Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0")).join("")

const streamEndpoint = (
  streamOptions: DurableStreamOptions,
): DurableStream.Endpoint => ({
  url: streamOptions.url,
  ...(streamOptions.headers !== undefined ? { headers: streamOptions.headers } : {}),
  ...(streamOptions.params !== undefined ? { params: streamOptions.params } : {}),
})

const appendInsertWithPrimaryKeyFence = (options: {
  readonly streamOptions: DurableStreamOptions
  readonly collection: CompiledCollection
  readonly encodedKey: string
  readonly event: unknown
}) => {
  const { collection, encodedKey, event, streamOptions } = options
  const producerId = [
    "durable-table",
    collection.durableType,
    encodeHeaderFragment(encodedKey),
  ].join(":")
  const append = DurableStream.appendWithProducer({
    endpoint: streamEndpoint(streamOptions),
    schema: Schema.Unknown,
    event,
    producerId,
    producerEpoch: 0,
    producerSeq: 0,
  }).pipe(
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({
        "firegrid.durable_table.producer_append.result": result._tag,
      })),
    Effect.withSpan("firegrid.durable_table.producer_append", {
      kind: "internal",
      attributes: {
        "firegrid.durable_table.collection": collection.collectionKey,
        "firegrid.durable_table.durable_type": collection.durableType,
        "firegrid.durable_table.primary_key": collection.primaryKey,
      },
    }),
    Effect.provide(FetchHttpClient.layer),
  )
  return streamOptions.fetch === undefined
    ? append
    : append.pipe(
        Effect.provide(Layer.succeed(FetchHttpClient.Fetch, streamOptions.fetch)),
      )
}

const waitForStoredRow = <Row extends object>(
  collection: CompiledCollection,
  tanstackCollection: TanStackCollection<Row, string>,
  encodedKey: string,
  timeoutMs: number,
): Promise<Row> =>
  new Promise((resolve, reject) => {
    const current = tanstackCollection.get(encodedKey)
    if (current !== undefined) {
      resolve(decodeRowForRead(collection, current))
      return
    }

    let unsubscribe: (() => void) | undefined
    const finish = (row: Row): void => {
      clearTimeout(timeout)
      if (unsubscribe !== undefined) unsubscribe()
      resolve(decodeRowForRead(collection, row))
    }
    const timeout = setTimeout(() => {
      if (unsubscribe !== undefined) unsubscribe()
      reject(
        new Error(
          `Timed out waiting for DurableTable row ${collection.durableType}:${encodedKey}`,
        ),
      )
    }, timeoutMs)

    try {
      const subscription = tanstackCollection.subscribeChanges(
        () => {
          const row = tanstackCollection.get(encodedKey)
          if (row !== undefined) finish(row)
        },
        { includeInitialState: true },
      )
      unsubscribe = () => subscription.unsubscribe()
    } catch (cause) {
      clearTimeout(timeout)
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })

const makeReadableCollection = <Row extends object>(
  tableName: string,
  collection: CompiledCollection,
  tanstackCollection: TanStackCollection<Row, string>,
): TanStackCollection<Row, string> => {
  const rejectMutation = (): never => {
    // effect-durable-operators.TABLE.23
    // Synchronous TanStack mutation boundary: throw the typed error directly
    // so callers can `instanceof DurableTableError` it. Wrapping in
    // Effect.runSync(Effect.fail(...)) would re-package this as a FiberFailure.
    throw new DurableTableError({
      table: tableName,
      cause: new Error(
        "DurableTable collection views are read-only; use the generated insert/upsert/delete facade methods",
      ),
    })
  }

  const overrides = {
    insert: rejectMutation,
    update: rejectMutation,
    delete: rejectMutation,
    get: (key: string) => {
      const row = tanstackCollection.get(key)
      return row === undefined ? undefined : decodeRowForRead(collection, row)
    },
    values: () =>
      Array.from(
        tanstackCollection.values(),
        row => decodeRowForRead(collection, row),
      ).values(),
    entries: () =>
      Array.from(
        tanstackCollection.entries(),
        ([key, row]): [string, Row] => [
          key,
          decodeRowForRead(collection, row),
        ],
      ).values(),
    [Symbol.iterator]: () => overrides.entries(),
    forEach: (
      callbackfn: (value: Row, key: string, index: number) => void,
    ) => {
      tanstackCollection.forEach((row, key, index) => {
        callbackfn(decodeRowForRead(collection, row), key, index)
      })
    },
    map: <A>(
      callbackfn: (value: Row, key: string, index: number) => A,
    ) =>
      tanstackCollection.map((row, key, index) =>
        callbackfn(decodeRowForRead(collection, row), key, index)),
    toArrayWhenReady: () =>
      tanstackCollection.toArrayWhenReady().then(rows =>
        rows.map(row => decodeRowForRead(collection, row))),
    stateWhenReady: () =>
      tanstackCollection.stateWhenReady().then(state =>
        new Map(Array.from(
          state,
          ([key, row]): [string, Row] => [
            key,
            decodeRowForRead(collection, row),
          ],
        ))),
    currentStateAsChanges: (
      ...args: Parameters<TanStackCollection<Row, string>["currentStateAsChanges"]>
    ) => {
      const changes = tanstackCollection.currentStateAsChanges(...args)
      return changes?.map(change => decodeChangeForRead(collection, change))
    },
    subscribeChanges: (
      callback: Parameters<TanStackCollection<Row, string>["subscribeChanges"]>[0],
      options?: Parameters<TanStackCollection<Row, string>["subscribeChanges"]>[1],
    ) =>
      tanstackCollection.subscribeChanges(
        changes => callback(changes.map(change =>
          decodeChangeForRead(collection, change))),
        options,
      ),
  }

  return new Proxy(tanstackCollection, {
    get(target, property, receiver) {
      if (property === "toArray") {
        return target.toArray.map(row => decodeRowForRead(collection, row))
      }
      if (property === "state") {
        return new Map(Array.from(
          target.state,
          ([key, row]): [string, Row] => [
            key,
            decodeRowForRead(collection, row),
          ],
        ))
      }
      if (property in overrides) {
        return overrides[property as keyof typeof overrides]
      }
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== "function") return value
      const bound: unknown = value.bind(target)
      return bound
    },
  })
}

const makeFacade = <Row extends object, Key>(options: {
  readonly tableName: string
  readonly collection: CompiledCollection
  readonly helper: StateSchemaWithHelpers[string]
  readonly tanstackCollection: TanStackCollection<Row, string>
  readonly actions: TableActionMap
  readonly awaitTxId: (txid: string, timeoutMs?: number) => Promise<void>
  readonly streamOptions: DurableStreamOptions
  readonly txTimeoutMs: number
}): CollectionFacade<Row, Key> => {
  const {
    actions,
    awaitTxId,
    collection,
    helper,
    streamOptions,
    tableName,
    tanstackCollection,
    txTimeoutMs,
  } = options
  const encodeKey = (key: unknown): string =>
    requireString(collection, collection.encodePrimaryKey(key))
  const readableCollection = makeReadableCollection(
    tableName,
    collection,
    tanstackCollection,
  )
  return {
    collection: readableCollection,
    rows: () =>
      Stream.async<Row, DurableTableError>((emit) => {
        let unsubscribe: (() => void) | undefined
        try {
          const sub = readableCollection.subscribeChanges(
            (changes) => {
              changes.forEach((change) => {
                if (change.type === "delete") return
                if (change.value === undefined || change.value === null) return
                void emit.single(change.value)
              })
            },
            { includeInitialState: true },
          )
          unsubscribe = () => sub.unsubscribe()
        } catch (cause) {
          void emit.fail(new DurableTableError({ table: tableName, cause }))
        }
        return Effect.sync(() => {
          if (unsubscribe !== undefined) unsubscribe()
        })
      }).pipe(
        Stream.withSpan("firegrid.durable_table.rows", {
          kind: "internal",
          attributes: {
            "firegrid.durable_table.name": tableName,
            "firegrid.durable_table.collection": collection.collectionKey,
            "firegrid.durable_table.durable_type": collection.durableType,
          },
        }),
      ),
    insert: (row) =>
      runAction(
        tableName,
        collection,
        actions,
        "insert",
        row,
      ),
    insertOrGet: (row) =>
      Effect.gen(function* () {
        // effect-durable-operators.TABLE.26
        const { encoded, encodedKey } = yield* Effect.try({
          try: () => encodeRowForStore(collection, row),
          catch: (cause) => new DurableTableError({ table: tableName, cause }),
        })
        const txid = crypto.randomUUID()
        const event = helper.insert({
          value: encoded,
          headers: { txid },
        })
        const result = yield* appendInsertWithPrimaryKeyFence({
          streamOptions,
          collection,
          encodedKey,
          event,
        }).pipe(
          Effect.mapError((cause) =>
            new DurableTableError({ table: tableName, cause }),
          ),
        )
        if (result._tag === "Appended") {
          yield* Effect.tryPromise({
            try: () => awaitTxId(txid, txTimeoutMs),
            catch: (cause) => new DurableTableError({ table: tableName, cause }),
          })
          return {
            _tag: "Inserted",
          } satisfies InsertOrGetResult<Row>
        }

        // A duplicate producer response means no loser event was appended,
        // so there is no loser txid for awaitTxId. Wait narrowly for the
        // winning row to become visible in this materialized table handle.
        return {
          _tag: "Found",
          row: yield* Effect.tryPromise({
            try: () =>
              waitForStoredRow(
                collection,
                tanstackCollection,
                encodedKey,
                txTimeoutMs,
              ),
            catch: (cause) => new DurableTableError({ table: tableName, cause }),
          }),
        } satisfies InsertOrGetResult<Row>
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof DurableTableError
            ? cause
            : new DurableTableError({ table: tableName, cause }),
        ),
        Effect.tap((result) =>
          Effect.annotateCurrentSpan({
            "firegrid.durable_table.insert_or_get.result": result._tag,
          })),
        Effect.withSpan("firegrid.durable_table.insert_or_get", {
          kind: "internal",
          attributes: {
            "firegrid.durable_table.name": tableName,
            "firegrid.durable_table.collection": collection.collectionKey,
            "firegrid.durable_table.durable_type": collection.durableType,
            "firegrid.durable_table.primary_key": collection.primaryKey,
          },
        }),
      ),
    upsert: (row) =>
      runAction(
        tableName,
        collection,
        actions,
        "upsert",
        row,
      ),
    delete: (key) =>
      runAction(
        tableName,
        collection,
        actions,
        "delete",
        key,
      ),
    get: (key) =>
      Effect.try({
        try: () => {
          const encoded = encodeKey(key)
          const value = tanstackCollection.get(encoded)
          return value === undefined
            ? Option.none<Row>()
            : Option.some(decodeRowForRead(collection, value))
        },
        catch: (cause) => new DurableTableError({ table: tableName, cause }),
      }).pipe(
        Effect.tap((row) =>
          Effect.annotateCurrentSpan({
            "firegrid.durable_table.row_found": Option.isSome(row),
          })),
        Effect.withSpan("firegrid.durable_table.get", {
          kind: "internal",
          attributes: {
            "firegrid.durable_table.name": tableName,
            "firegrid.durable_table.collection": collection.collectionKey,
            "firegrid.durable_table.durable_type": collection.durableType,
            "firegrid.durable_table.primary_key": collection.primaryKey,
          },
        }),
      ),
    query: (build) =>
      Effect.try({
        try: () => build(readableCollection),
        catch: (cause) => new DurableTableError({ table: tableName, cause }),
      }).pipe(
        Effect.withSpan("firegrid.durable_table.query", {
          kind: "internal",
          attributes: {
            "firegrid.durable_table.name": tableName,
            "firegrid.durable_table.collection": collection.collectionKey,
            "firegrid.durable_table.durable_type": collection.durableType,
          },
        }),
      ),
    subscribe: <A>(
      subscribe: (
        coll: TanStackCollection<Row, string>,
        emit: (value: A) => void,
      ) => () => void,
    ) =>
      Stream.async<A, DurableTableError>((emit) => {
        let unsubscribe: (() => void) | undefined
        try {
          unsubscribe = subscribe(readableCollection, (value) => {
            void emit.single(value)
          })
        } catch (cause) {
          void emit.fail(new DurableTableError({ table: tableName, cause }))
        }
        return Effect.sync(() => {
          if (unsubscribe !== undefined) unsubscribe()
        })
      }).pipe(
        Stream.withSpan("firegrid.durable_table.subscribe", {
          kind: "internal",
          attributes: {
            "firegrid.durable_table.name": tableName,
            "firegrid.durable_table.collection": collection.collectionKey,
            "firegrid.durable_table.durable_type": collection.durableType,
          },
        }),
      ),
  }
}

const makeService = <Schemas extends TableSchemas<Schemas>>(
  table: CompiledTable<Schemas>,
  options: LayerOptions,
): Effect.Effect<DurableTableService<Schemas>, DurableTableError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        const stateSchema = makeStateSchema(table)
        const dbOptions: CreateStreamDBOptions<
          StateSchemaWithHelpers,
          TableActionDefinitions
        > = {
          streamOptions: options.streamOptions,
          state: stateSchema,
          // effect-durable-operators.TABLE.11
          actions: makeActionDefinitions(
            table,
            stateSchema,
            options.txTimeoutMs ?? 5_000,
          ),
        }
        return createStreamDB<
          StateSchemaWithHelpers,
          TableActionDefinitions
        >(dbOptions)
      },
      catch: (cause) =>
        new DurableTableError({ table: table.namespace, cause }),
    }).pipe(
      Effect.tap((db) =>
        // Ensure the backing durable stream exists before preload. Calling
        // .create() against an already-existing stream returns a typed
        // CONFLICT_EXISTS error from @durable-streams/client; we tolerate
        // that path so DurableTable.layer is idempotent across acquisitions
        // against the same URL.
        Effect.tryPromise({
          try: async () => {
            try {
              const createOpts: { contentType?: string } = {}
              if (options.streamOptions.contentType !== undefined) {
                createOpts.contentType = options.streamOptions.contentType
              }
              await db.stream.create(createOpts)
            } catch (cause) {
              if (
                typeof cause === "object" &&
                cause !== null &&
                "code" in cause &&
                (cause).code === "CONFLICT_EXISTS"
              ) {
                // Stream already exists with compatible configuration; the
                // server returns CONFLICT_EXISTS and we proceed to preload.
                return
              }
              throw cause
            }
          },
          catch: (cause) =>
            new DurableTableError({ table: table.namespace, cause }),
        }),
      ),
      Effect.tap((db) =>
        Effect.tryPromise({
          try: () => db.preload(),
          catch: (cause) =>
            new DurableTableError({ table: table.namespace, cause }),
        }),
      ),
    ),
    (db) => Effect.sync(() => db.close()),
  ).pipe(
    Effect.map((db) => {
      const actions = db.actions
      const stateSchema = makeStateSchema(table)
      const txTimeoutMs = options.txTimeoutMs ?? 5_000
      const collectionFacades = table.collections.reduce<Record<string, unknown>>(
        (facades, collection) => {
          const coll = db.collections[collection.collectionKey]!
          return {
            ...facades,
            [collection.collectionKey]: makeFacade({
              tableName: `${table.namespace}.${collection.collectionKey}`,
              collection,
              helper: stateSchema[collection.collectionKey]!,
              tanstackCollection: coll,
              actions,
              awaitTxId: db.utils.awaitTxId,
              streamOptions: options.streamOptions,
              txTimeoutMs,
            }),
          }
        },
        {},
      )

      const service: Record<string, unknown> = {
        awaitTxId: (txid: string, timeoutMs?: number) =>
          Effect.tryPromise({
            try: () => db.utils.awaitTxId(txid, timeoutMs),
            catch: (cause) =>
              new DurableTableError({ table: table.namespace, cause }),
          }).pipe(
            Effect.withSpan("firegrid.durable_table.await_tx_id", {
              kind: "internal",
              attributes: {
                "firegrid.durable_table.namespace": table.namespace,
              },
            }),
          ),
        ...collectionFacades,
      }

      return service as DurableTableService<Schemas>
    }),
    Effect.withSpan("firegrid.durable_table.layer.acquire", {
      kind: "internal",
      attributes: {
        "firegrid.durable_table.namespace": table.namespace,
        "firegrid.durable_table.collection_count": table.collections.length,
      },
    }),
  )

const defineDurableTable = <const Schemas extends TableSchemas<Schemas>>(
  namespace: string,
  schemas: Schemas,
): DurableTableTagClass<Schemas> => {
  const table = compileTable(namespace, schemas)
  const tagKey = `effect-durable-operators/DurableTable/${namespace}`

  // Self-reference: the class is its own Identifier so `yield* MyTable`
  // produces R = MyTable rather than R = unknown. The forward reference
  // to `DurableTableTag` inside the Context.Tag generics is the canonical
  // Effect pattern and works because class declarations are hoisted.
  class DurableTableTag extends Context.Tag(tagKey)<
    DurableTableTag,
    DurableTableService<Schemas>
  >() {
    static readonly namespace = namespace

    static layer(
      this: Context.Tag<DurableTableTag, DurableTableService<Schemas>>,
      options: LayerOptions,
    ) {
      return Layer.scoped(
        this,
        makeService(table, options).pipe(
          Effect.map((service) => this.of(service)),
        ),
      )
    }
  }

  return DurableTableTag as unknown as DurableTableTagClass<Schemas>
}

export const DurableTable = Object.assign(defineDurableTable, {
  primaryKey,
})
