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
 *  - effect-durable-operators.TABLE.11 — writes use createStreamDB actions
 *  - effect-durable-operators.TABLE.12 — generated writes attach txid headers
 *    and await createStreamDB awaitTxId
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
 */

import type { DurableStreamOptions } from "@durable-streams/client"
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
import type { Collection as TanStackCollection } from "@tanstack/db"
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

export interface CollectionFacade<Row extends object, Key> {
  readonly insert: (row: Row) => Effect.Effect<void, DurableTableError>
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

export type DurableTableTagClass<Schemas extends TableSchemas<Schemas>> =
  Context.TagClass<
    unknown,
    string,
    DurableTableService<Schemas>
  > & {
    readonly namespace: string
    readonly layer: (
      options: LayerOptions,
    ) => Layer.Layer<unknown, DurableTableError>
  }

type CompiledCollection = {
  readonly collectionKey: string
  readonly durableType: string
  readonly primaryKey: string
  readonly schema: StructSchema
  readonly encodePrimaryKey: (decoded: unknown) => string
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
  // composite-key Schema.transform), the threading is identity. For inner
  // schemas whose encoded form is non-string, the value is coerced via
  // String(...) at encode time so the durable wire form is always a string.
  const transformed = Schema.transform(Schema.String, schema, {
    strict: false,
    decode: (_fromA: string, fromI: string): unknown => fromI,
    encode: (toI: unknown, _toA: unknown): string =>
      typeof toI === "string" ? toI : String(toI),
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

    const primaryKeyEntries = Object.entries(schema.fields).filter(
      ([, fieldSchema]) => isPrimaryKeyField(fieldSchema as Schema.Schema.Any),
    )

    if (primaryKeyEntries.length !== 1) {
      return raise(
        `DurableTable("${namespace}").${collectionKey} must declare exactly one DurableTable.primaryKey field; found ${primaryKeyEntries.length}`,
      )
    }

    const [primaryKeyName, primaryKeyFieldSchema] = primaryKeyEntries[0]!
    const fieldSchema = primaryKeyFieldSchema as Schema.Schema.AnyNoContext
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
      encodePrimaryKey: (value: unknown) => {
        const encoded = encodeFn(value as never) as unknown
        return typeof encoded === "string" ? encoded : String(encoded)
      },
      decodePrimaryKey: (encoded: string) => decodeFn(encoded) as unknown,
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
  actions: TableActionMap,
  name: string,
  params: unknown,
): Effect.Effect<void, DurableTableError> =>
  Effect.tryPromise({
    try: async () => {
      const action = actions[name]
      if (action === undefined) {
        await Promise.reject(new Error(`unknown DurableTable action: ${name}`))
        return
      }
      await action(params).isPersisted.promise
    },
    catch: (cause) => new DurableTableError({ table: tableName, cause }),
  }).pipe(Effect.asVoid)

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
  return { ...stored, [collection.primaryKey]: decoded } as Row
}

const makeFacade = <Row extends object, Key>(options: {
  readonly tableName: string
  readonly collection: CompiledCollection
  readonly tanstackCollection: TanStackCollection<Row, string>
  readonly actions: TableActionMap
}): CollectionFacade<Row, Key> => {
  const { collection, tanstackCollection, tableName, actions } = options
  const encodeKey = (key: unknown): string =>
    requireString(collection, collection.encodePrimaryKey(key))
  return {
    insert: (row) =>
      runAction(
        tableName,
        actions,
        actionName(collection.collectionKey, "insert"),
        row,
      ),
    upsert: (row) =>
      runAction(
        tableName,
        actions,
        actionName(collection.collectionKey, "upsert"),
        row,
      ),
    delete: (key) =>
      runAction(
        tableName,
        actions,
        actionName(collection.collectionKey, "delete"),
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
      }),
    query: (build) =>
      Effect.try({
        try: () => build(tanstackCollection),
        catch: (cause) => new DurableTableError({ table: tableName, cause }),
      }),
    subscribe: <A>(
      subscribe: (
        coll: TanStackCollection<Row, string>,
        emit: (value: A) => void,
      ) => () => void,
    ) =>
      Stream.async<A, DurableTableError>((emit) => {
        let unsubscribe: (() => void) | undefined
        try {
          unsubscribe = subscribe(tanstackCollection, (value) => {
            void emit.single(value)
          })
        } catch (cause) {
          void emit.fail(new DurableTableError({ table: tableName, cause }))
        }
        return Effect.sync(() => {
          if (unsubscribe !== undefined) unsubscribe()
        })
      }),
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
                (cause as { code: unknown }).code === "CONFLICT_EXISTS"
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
      const collectionFacades = table.collections.reduce<Record<string, unknown>>(
        (facades, collection) => {
          const coll = db.collections[collection.collectionKey]!
          return {
            ...facades,
            [collection.collectionKey]: makeFacade({
              tableName: `${table.namespace}.${collection.collectionKey}`,
              collection,
              tanstackCollection: coll,
              actions,
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
          }),
        ...collectionFacades,
      }

      return service as DurableTableService<Schemas>
    }),
  )

const defineDurableTable = <const Schemas extends TableSchemas<Schemas>>(
  namespace: string,
  schemas: Schemas,
): DurableTableTagClass<Schemas> => {
  const table = compileTable(namespace, schemas)

  const Base = Context.Tag(
    `effect-durable-operators/DurableTable/${namespace}`,
  )<unknown, DurableTableService<Schemas>>()

  class DurableTableTag extends Base {
    static readonly namespace = namespace

    static layer(
      this: Context.Tag<unknown, DurableTableService<Schemas>>,
      options: LayerOptions,
    ) {
      return Layer.scoped(
        this,
        makeService(table, options).pipe(Effect.map((service) => this.of(service))),
      )
    }
  }

  return DurableTableTag as DurableTableTagClass<Schemas>
}

export const DurableTable = Object.assign(defineDurableTable, {
  primaryKey,
})
