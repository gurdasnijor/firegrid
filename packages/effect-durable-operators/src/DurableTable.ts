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

interface PrimaryKeyField<Key> {
  readonly [primaryKeyTypeId]: Key
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
    ? Extract<Schema.Schema.Type<FieldsOf<S>[PrimaryKeyNameOf<S>]>, string | number>
    : never

export interface LayerOptions {
  readonly streamOptions: DurableStreamOptions
  readonly txTimeoutMs?: number
}

export interface CollectionFacade<Row extends object, Key extends string | number> {
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

const keyString = (value: string | number): string => String(value)

const primaryKey = <S extends Schema.Schema.Any>(
  schema: S,
): S & PrimaryKeyField<Schema.Schema.Type<S>> =>
  schema.annotations({ [primaryKeyAnnotationId]: true }) as S &
    PrimaryKeyField<Schema.Schema.Type<S>>

const raise = (message: string): never => {
  throw new Error(message)
}

const isPrimaryKeyField = (schema: Schema.Schema.Any): boolean =>
  schema.ast.annotations[primaryKeyAnnotationId] === true

const actionName = (
  collectionKey: string,
  operation: GeneratedOperation,
): string => `${collectionKey}.${operation}`

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

    const primaryKeys = Object.entries(schema.fields)
      .filter(([, fieldSchema]) =>
        isPrimaryKeyField(fieldSchema as Schema.Schema.Any),
      )
      .map(([field]) => field)

    if (primaryKeys.length !== 1) {
      return raise(
        `DurableTable("${namespace}").${collectionKey} must declare exactly one DurableTable.primaryKey field; found ${primaryKeys.length}`,
      )
    }

    const primaryKeyName = primaryKeys[0]
    if (primaryKeyName === undefined) {
      return raise(
        `DurableTable("${namespace}").${collectionKey} did not produce a primary key`,
      )
    }

    return {
      collectionKey,
      durableType: `${namespace}.${collectionKey}`,
      primaryKey: primaryKeyName,
      schema,
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

const collectionKeyValue = <Row extends object>(
  collection: CompiledCollection,
  row: Row,
): string =>
  keyString(
    (row as Record<string, string | number>)[collection.primaryKey] as
      | string
      | number,
  )

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
            coll.insert(params as object)
          },
          mutationFn: async (params: unknown) => {
            const txid = crypto.randomUUID()
            const event = helpers.insert({
              value: params,
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
            const row = params as object
            const key = collectionKeyValue(collection, row)
            if (coll.get(key) === undefined) {
              coll.insert(row)
            } else {
              coll.update(key, (draft) => {
                Object.assign(draft, row)
              })
            }
          },
          mutationFn: async (params: unknown) => {
            const txid = crypto.randomUUID()
            const event = helpers.upsert({
              value: params,
              headers: { txid },
            })
            // effect-durable-operators.TABLE.15
            await stream.append(JSON.stringify(event))
            await db.utils.awaitTxId(txid, txTimeoutMs)
          },
        }

        actions[actionName(collection.collectionKey, "delete")] = {
          onMutate: (params: unknown) => {
            const key = keyString(params as string | number)
            if (coll.get(key) !== undefined) {
              coll.delete(key)
            }
          },
          mutationFn: async (params: unknown) => {
            const key = keyString(params as string | number)
            const txid = crypto.randomUUID()
            const event = helpers.delete({
              key,
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

const makeFacade = <Row extends object, Key extends string | number>(options: {
  readonly tableName: string
  readonly collectionKey: string
  readonly collection: TanStackCollection<Row, string>
  readonly actions: TableActionMap
}): CollectionFacade<Row, Key> => ({
  insert: (row) =>
    runAction(
      options.tableName,
      options.actions,
      actionName(options.collectionKey, "insert"),
      row,
    ),
  upsert: (row) =>
    runAction(
      options.tableName,
      options.actions,
      actionName(options.collectionKey, "upsert"),
      row,
    ),
  delete: (key) =>
    runAction(
      options.tableName,
      options.actions,
      actionName(options.collectionKey, "delete"),
      key,
    ),
  get: (key) =>
    Effect.try({
      try: () => {
        const value = options.collection.get(keyString(key))
        return value === undefined ? Option.none<Row>() : Option.some(value)
      },
      catch: (cause) =>
        new DurableTableError({ table: options.tableName, cause }),
    }),
  query: (build) =>
    Effect.try({
      try: () => build(options.collection),
      catch: (cause) =>
        new DurableTableError({ table: options.tableName, cause }),
    }),
  subscribe: <A>(subscribe: (
    coll: TanStackCollection<Row, string>,
    emit: (value: A) => void,
  ) => () => void) =>
    Stream.async<A, DurableTableError>((emit) => {
      let unsubscribe: (() => void) | undefined
      try {
        unsubscribe = subscribe(options.collection, (value) => {
          void emit.single(value)
        })
      } catch (cause) {
        void emit.fail(new DurableTableError({ table: options.tableName, cause }))
      }
      return Effect.sync(() => {
        if (unsubscribe !== undefined) unsubscribe()
      })
    }),
})

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
              collectionKey: collection.collectionKey,
              collection: coll,
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
