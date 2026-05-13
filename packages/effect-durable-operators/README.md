# effect-durable-operators

Effect-native `DurableTable`: a ksql-inspired service-tag table over
`@durable-streams/state`, Effect Schema, and TanStack DB.

```ts
import {
  DurableTable,
  DurableTableError,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"
```

## Public API

The package intentionally exposes one durable state primitive:

| Export | Purpose |
| --- | --- |
| `DurableTable` | Declares an Effect service-tag class for durable table state. |
| `DurableTable.primaryKey` | Pipe-able Effect Schema field modifier for the collection key. |
| `DurableTableError` | Typed error for table acquisition, reads, writes, and subscriptions. |
| `DurableTableService` and related types | Type helpers for table services, rows, keys, and layer options. |

The old generic consumer, projection, source adapter, checkpoint-store, and
Electric adapter surfaces were removed. Callers now express those workflows as
ordinary Effect Stream code and write table-shaped state through `DurableTable`
collections at the owning package boundary.

## First Table

`DurableTable(...)` returns an Effect service-tag class. Callers consume the
service with `yield* Table`, and provide the backing stream once with
`Table.layer(...)`.

```ts
import { DurableTable } from "effect-durable-operators"
import { Effect, Option, Schema } from "effect"

class WorkflowTable extends DurableTable("workflow", {
  executions: Schema.Struct({
    executionId: Schema.String.pipe(DurableTable.primaryKey),
    workflowName: Schema.String,
    payload: Schema.Unknown,
  }),
}) {}

const program = Effect.gen(function* () {
  const table = yield* WorkflowTable

  yield* table.executions.insert({
    executionId: "exec-1",
    workflowName: "demo",
    payload: { input: "hello" },
  })

  yield* table.executions.upsert({
    executionId: "exec-1",
    workflowName: "demo",
    payload: { input: "updated" },
  })

  const execution = yield* table.executions.get("exec-1")
  const rows = yield* table.executions.query((coll) => coll.toArray)
  const value = Option.getOrUndefined(execution)

  return { value, rows }
})

const Live = WorkflowTable.layer({
  streamOptions: {
    url: "https://durable-streams.example/v1/stream/workflow",
    contentType: "application/json",
  },
})

const runnable = program.pipe(Effect.provide(Live), Effect.scoped)
```

Each collection exposes:

| Method | Behavior |
| --- | --- |
| `insert(row)` | Inserts a new row. Duplicate primary keys follow upstream insert semantics and fail instead of silently replacing the row. |
| `upsert(row)` | Inserts or updates a row by primary key. |
| `delete(key)` | Deletes by primary key. |
| `get(key)` | Reads by primary key and returns `Option<Row>`. |
| `query(fn)` | Runs `fn` against the underlying TanStack collection. |
| `subscribe(fn)` | Builds an Effect Stream from the underlying TanStack collection subscription API. |

## Primary Keys

Mark exactly one field in each collection with `DurableTable.primaryKey`.

```ts
const Users = Schema.Struct({
  userId: Schema.String.pipe(DurableTable.primaryKey),
  email: Schema.String,
})
```

Composite keys are schema-owned. Declare a transform whose encoded form is a
string, then pipe it through `DurableTable.primaryKey`.

```ts
const DeliveryKey = Schema.transform(
  Schema.Struct({
    subscriberId: Schema.String,
    inputId: Schema.String,
  }),
  Schema.String,
  {
    strict: true,
    encode: ({ subscriberId, inputId }) => `${subscriberId}:${inputId}`,
    decode: (encoded) => {
      const [subscriberId = "", inputId = ""] = encoded.split(":")
      return { subscriberId, inputId }
    },
  },
)

const Deliveries = Schema.Struct({
  key: DeliveryKey.pipe(DurableTable.primaryKey),
  completedAt: Schema.optional(Schema.String),
})
```

Construction fails loudly if a collection has zero or multiple primary-key
fields.

## Layers And Lifecycle

`DurableTable.layer(...)` is the ownership boundary for the backing durable
stream:

- it creates the backing stream if needed and tolerates an already-existing
  compatible stream;
- it preloads retained state before the service is available;
- it closes the materializer when the Effect scope ends;
- it exposes `awaitTxId(txid, timeoutMs?)` for explicit read-after-write
  coordination when callers need it.

Provide the layer at application, service, or test scope. Do not acquire a
table layer around every row operation.

```ts
const Live = WorkflowTable.layer({
  streamOptions: {
    url: "https://durable-streams.example/v1/stream/workflow",
    contentType: "application/json",
  },
  txTimeoutMs: 5_000,
})
```

## Durable Type Convention

Collection durable wire types are convention-derived as:

```text
${tableNamespace}.${collectionKey}
```

For example, `DurableTable("workflow", { executions: ... })` writes collection
events with durable type `workflow.executions`.

In v0 there are no per-collection wire-type overrides. Renaming the table
namespace or collection key is a replay-breaking migration unless the retained
stream is migrated as well.

## Query And Subscribe

`query` receives the TanStack collection, so callers can use normal TanStack DB
collection/query APIs.

```ts
const active = yield* table.executions.query((coll) =>
  coll.toArray.filter(row => row.workflowName === "billing"),
)
```

`subscribe` adapts collection subscriptions into an Effect Stream.

```ts
const stream = table.executions.subscribe((coll, emit) => {
  const sub = coll.subscribeChanges(
    (changes) => {
      for (const change of changes) {
        if (change.value !== undefined && change.value !== null) {
          emit(change.value)
        }
      }
    },
    { includeInitialState: false },
  )
  return () => sub.unsubscribe()
})
```

## Writes

Standard `insert`, `upsert`, and `delete` writes are generated by convention.
Callers do not pass an `actions` config for normal table behavior.

Internally, generated writes use upstream `createStreamDB({ actions })`,
construct State Protocol change events through `createStateSchema` collection
helpers, attach txid headers, and wait for `awaitTxId` before completing.

There are no package-owned hidden append helpers for generated table writes.

## Patterns After Removed Surfaces

Use `DurableTable` for ordinary table-shaped durable state: entities,
checkpoints, delivery claims, idempotency rows, read models, and queryable
snapshots.

Use `effect-durable-streams` directly for raw retained fact streams where table
state is not the abstraction, then decode/filter/project with normal Effect
Stream combinators and call collection writes explicitly:

```ts
const projectFacts = facts.pipe(
  Stream.mapEffect((fact) =>
    table.executions.upsert({
      executionId: fact.executionId,
      workflowName: fact.workflowName,
      payload: fact.payload,
    }),
  ),
)
```

Delivery policy and retry behavior belong to the owning runtime/provider/app
module. For example, an at-most-once delivery path should write its claim row
through a caller-owned table collection before performing the externally visible
side effect.

## Boundaries

This package does not import Firegrid runtime, client, protocol, scenario, or
app packages. It also does not implement workflow suspension, durable clocks,
required actions, prompt APIs, runtime hosts, or product session semantics.

Those behaviors live above `DurableTable` in their owning packages.
