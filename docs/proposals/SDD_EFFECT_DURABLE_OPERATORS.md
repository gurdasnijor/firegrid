# SDD: Effect Durable Operators

**Status:** accepted for DurableTable v0; historical DurableConsumer and DurableProjection sections below are superseded
**Scope:** higher-level DurableTable package surface
**Primary consumers:** Firegrid runtime today; reusable durable Effect programs
later
**Depends on:** `@durable-streams/client`, `@durable-streams/state`, `@tanstack/db`, Effect

## Problem

`DurableTable` gives Firegrid an Effect service-tag table facade over
`@durable-streams/state`. Raw durable append/read programs use
`effect-durable-streams` directly at the few boundaries that need retained-log
IO. State Protocol table semantics stay with `DurableTable`; runtime, client,
protocol, app, and scenario source should not construct `createStateSchema` or
`createStreamDB` surfaces directly for ordinary table/state behavior.

DurableConsumer and DurableProjection were investigated as possible next layers.
They are not part of the current package surface. The recurring application
pattern remains useful as design context:

```txt
durable facts
  -> derive keyed state
  -> query pending work
  -> claim or record checkpoint state durably
  -> run an Effect side effect
  -> optionally write derived facts/state
```

Firegrid currently expresses this pattern with local folds such as runtime
input requested-minus-accepted state. That keeps leaking durable bookkeeping
into domain modules. The next abstraction should not be another Firegrid
service wrapper. It should be a small higher-level operator package that
composes streams and state while remaining Effect-native.

## Prior Art

Kafka Streams models stream/table duality explicitly. Confluent describes a
`KStream` as an append-only record stream where records are interpreted as
inserts, while a `KTable` is a changelog stream where records are interpreted
as updates by key. KTables also support lookup by key through joins or
interactive queries.

ksqlDB materialized views apply only new changes to current state rather than
fully recomputing a query each time a new event arrives. That is the key
lesson for Firegrid: application code should not repeatedly read a retained
stream from the beginning and rebuild state ad hoc at every boundary.

The linked Kafka car-data examples show the lower-level split that we also
want to preserve:

- domain records are plain typed values (`CarId`, `CarSpeed`, `CarEngine`,
  `CarLocation`, `LocationData`, `DriverNotification`);
- producers emit keyed domain facts to named streams/topics;
- consumers subscribe independently and decode typed domain facts;
- processing applications can sit between producer and consumer without
  changing domain record ownership.

Firegrid should not copy Kafka's API surface directly. Durable Streams has
different protocol semantics, and Effect already has first-class `Effect`,
`Stream`, `Sink`, `Layer`, `Scope`, and `Schedule`. The useful idea is the
separation:

```txt
record stream
materialized keyed table
stateful operator
consumer checkpoint
```

## Design Goal

Create a package that makes durable stream/table programs feel like ordinary
Effect programs:

```txt
packages/effect-durable-operators/
  src/
    DurableTable.ts
    index.ts
```

This package composes:

- `@durable-streams/state` for `createStreamDB` and TanStack DB collections;
- Effect `Schema`, `Layer`, `Scope`, and `Stream` primitives.

It must not import Firegrid runtime, protocol, client, provider, workflow, or
scenario modules.

## Schema Strategy

All user-facing schemas in this package are Effect Schema. Translation to
Standard Schema happens inside the operators package at the
`@durable-streams/state` boundary with `Schema.standardSchemaV1`.

Callers should not have to build raw `createStateSchema(...)` definitions or
repeat primary-key names in a parallel options object. They should define a
durable table as an Effect service tag whose collections are plain Effect row
schemas:

```ts
class WebhookTable extends DurableTable("example", {
  webhooks: Schema.Struct({
    providerEventId: Schema.String.pipe(DurableTable.primaryKey),
    receivedAt: Schema.DateFromString,
    status: Schema.Literal("received", "processed", "failed"),
  }),
}) {}
```

`DurableTable.primaryKey` is a schema modifier. It stores package-owned schema
metadata on the field schema; callers do not use symbols directly. Each
collection must have exactly one primary-key field. Zero or multiple primary
keys are declaration errors.

The wrapper derives the durable State Protocol type for each collection as
`<tableNamespace>.<collectionKey>`. Renaming either the namespace or the
collection key is a replay-breaking migration in v0. There are no
`persistentType`, `Type`, or per-collection wire-type overrides.

Internally, the table layer converts row schemas to the `@durable-streams/state`
shape, calls `createStateSchema` / `createStreamDB`, and generates standard
`insert`, `upsert`, and `delete` actions for every collection.

Use `Schema.brand` for semantically meaningful primary keys, such as
`AccountId` or `ProviderEventId`. Use `Schema.Class` or `Schema.TaggedClass`
for definition and error types when serialization, equality, or pattern
matching matters.

```ts
const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
type AccountId = Schema.Schema.Type<typeof AccountId>

class CheckpointError extends Schema.TaggedError<CheckpointError>()(
  "CheckpointError",
  {
    subscriberId: Schema.String,
    key: Schema.String,
  },
) {}

class WebhookReceived extends Schema.TaggedClass<WebhookReceived>()(
  "WebhookReceived",
  {
    providerEventId: Schema.String,
    receivedAt: Schema.DateFromString,
  },
) {}
```

## Non-Goals

- Do not create a new `DurableLog` wrapper around `DurableStream`.
- Do not hide `Effect.Stream` behind a custom stream abstraction.
- Do not implement a workflow engine.
- Do not implement Firegrid runtime ingress, prompts, required actions, tools,
  or sessions.
- Do not require all projections to use State Protocol.
- Do not expose pluggable consumer checkpoint backends in v0. Use State
  Protocol-backed checkpoints internally; append-only checkpoint facts can be
  added after a concrete second backend use case appears.
- Do not add SQL/KSQL parsing.
- Do not reimplement TanStack DB Collections or db-ivm query semantics.
  `DurableTable` is a typed Effect facade over `@durable-streams/state`'s
  `createStreamDB`.
- Do not invent a custom reducer execution model for tables in v0. Use the
  change-event model that `stream-db.ts` already implements.
- Do not expose Standard Schema as the user-facing table schema API. Effect
  Schema is the public schema surface; Standard Schema is an implementation
  boundary.
- Do not implement workflow wait/suspend semantics. Use `@effect/workflow`
  primitives such as `DurableDeferred` and durable clocks, and let operators
  complete or append facts that workflows await.
- Do not implement windowing or a `GlobalKTable` equivalent in v0.

## Invariants

### Stream/Table Duality

A durable fact stream is the append-only source of truth. A durable table is an
Effect facade over `@durable-streams/state` materialization backed by TanStack
DB collections.

Every `DurableTable` must be reconstructible by replaying its source change
events through `createStreamDB`:

```txt
source durable state change stream
  -> createStreamDB
  -> TanStack DB collections
  -> latest table state by key
```

This mirrors the KStream/KTable distinction: raw facts are interpreted as
inserts into history, while State Protocol change events are interpreted as
latest state updates and removals by key.

Projections that feed tables must be deterministic functions of their input
fact stream. Otherwise replay can diverge.

### Incremental Materialization

Incremental materialization is delegated to `@durable-streams/state` and
TanStack DB's differential dataflow engine. `DurableTable` must not mutate
collection state outside the sync protocol, and it must not rebuild local table
state by folding retained history at every query boundary.

`stream-db.ts` handles:

- change operations: insert, update, delete, upsert;
- transaction batch boundaries through its `EventDispatcher`;
- cold-start replay through the durable stream up-to-date signal;
- snapshot reset handling through control `reset` events;
- txid-based read-after-write coordination through `awaitTxId`.

Application code should not repeatedly read an entire retained stream and
rebuild local state at every boundary.

### Pull And Push Queries

Tables expose two query modes mapped from TanStack DB collections:

- pull queries: collection `get` and query builder reads;
- push queries: collection subscriptions/live queries.

Pull queries are snapshot reads of the table backend. They should not imply
linearizable coordination with in-flight live updates unless a backend
explicitly documents that guarantee.

### Transport Dedupe Is Not Consumer Progress

Durable stream producer idempotency protects ambiguous writes to the durable
stream. It does not prove whether a consumer has already performed an external
side effect after reading a row.

Consumer checkpoint state is a separate durable coordination record. The operator API
must keep that distinction visible.

## Core Concepts

### DurableTable

`DurableTable` is a thin Effect-flavoured facade over
`@durable-streams/state`'s `createStreamDB`. It is not a new materialization
engine.

The durable stream remains the source of truth. `@durable-streams/state`
provides the queryable materialization layer: TanStack DB collections backed by
the db-ivm engine.

### Table Declarations And Actions

`DurableTable(...)` returns an Effect service-tag class with a static
`.layer(...)` constructor. User programs consume a materialized table with
`yield* Table`, and Layers bind the declaration to a Durable Streams URL:

```ts
class WorkflowTable extends DurableTable("workflow", {
  executions: Schema.Struct({
    executionId: Schema.String.pipe(DurableTable.primaryKey),
    workflowName: Schema.String,
    payload: Schema.Unknown,
  }),
}) {}

const program = Effect.gen(function* () {
  const table = yield* WorkflowTable

  yield* table.executions.upsert({
    executionId: "exec-1",
    workflowName: "demo",
    payload: {},
  })

  yield* table.executions.get("exec-1")
  yield* table.executions.query((coll) => coll.toArray)
  table.executions.subscribe((coll, emit) => {
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
})

const Live = WorkflowTable.layer({
  streamOptions: { url: workflowStreamUrl, contentType: "application/json" },
})
```

`DurableTable` is still a `Scope`-managed resource:

- accept typed durable stream options/source;
- accept Effect Schema-native table declarations built from row schemas;
- call `createStreamDB`;
- run `preload` on acquire;
- call `close` on scope finalization;
- expose `awaitTxId` through Effect.

Every declared collection gets `insert`, `upsert`, and `delete` write actions.
Callers do not pass an `actions:` object for these standard writes.
Generated actions use upstream `createStreamDB({ actions })` optimistic action
semantics, write State Protocol events through the action `mutationFn`, attach
txid headers, and call `db.utils.awaitTxId(txid)` before the returned Effect
completes. Generated table writes do not route through separate package-owned
manual append helpers.

This gives the package:

- incremental view maintenance via TanStack DB/db-ivm;
- live query support through TanStack DB query builder semantics;
- transaction batch semantics through `EventDispatcher` begin/write/commit;
- cold-start replay via the durable stream `upToDate` signal;
- snapshot reset handling via control `reset` events;
- txid-based read-after-write coordination via `awaitTxId`.

The v0 table model supports State Protocol change events directly:

```txt
insert | update | delete | upsert
```

This is last-write-wins per key. Arbitrary reducers such as sum, count, and
running aggregate are not table reducers in v0. They are expressed by:

1. computing the new row before appending the change event; or
2. routing raw facts through `DurableProjection`, which emits State Protocol
   change events consumed by `DurableTable`.

### DurableConsumer

`DurableConsumer` is the stateful "process each logical item once per
subscriber" operator. This is the generic version of Firegrid's
requested-minus-accepted fold.

```ts
export interface DurableConsumerDefinition<Fact, Key, Input> {
  readonly name: string
  readonly select: (fact: Fact) => Option.Option<Input>
  readonly key: (input: Input) => Key
}
```

`DurableConsumer.run` takes a checkpoint location:

```ts
checkpoint: {
  readonly subscriberId: string
}
```

The checkpoint is the durable record of which logical items a subscriber has
claimed or completed. It is required for AtMostOnce and AtLeastOnce semantics.
In v0, checkpoints are State Protocol-backed and implemented inside
`DurableConsumer`. Checkpoint storage is provided as a service:

```ts
class ConsumerCheckpointStore extends Context.Tag("ConsumerCheckpointStore")<
  ConsumerCheckpointStore,
  {
    readonly read: (
      subscriberId: string,
      key: string,
    ) => Effect.Effect<Option.Option<CheckpointRecord>, CheckpointError>
    readonly writeClaim: (
      subscriberId: string,
      key: string,
    ) => Effect.Effect<void, CheckpointError>
    readonly writeCompletion: (
      subscriberId: string,
      key: string,
    ) => Effect.Effect<void, CheckpointError>
  }
>() {}
```

The v0 package ships a State Protocol-backed `ConsumerCheckpointStore` Layer.
Future checkpoint backends are different Layers satisfying the same service,
not different `DurableConsumer.run` parameters.

The operator needs explicit side-effect semantics:

```ts
type ClaimPolicy =
  Data.TaggedEnum<{
    AtMostOnce: {}
    AtLeastOnce: {}
    AtLeastOnceWithClaim: {}
  }>

const ClaimPolicy = Data.taggedEnum<ClaimPolicy>()
```

`AtMostOnce` records a durable claim before running the side effect. It fits
non-idempotent external effects such as writing to a process stdin where the
platform cannot acknowledge individual chunks.

`AtLeastOnce` records completion after the side effect. It fits idempotent
effects where retrying the side effect is safe or where the side effect has its
own idempotency key.

`AtLeastOnceWithClaim` records claim and completion. It fits richer adapters
that can distinguish "claimed" from "completed."

Exactly-once semantics are deferred. They are only plausible for constrained
stream-to-stream or stream-to-state operators where output writes and consumer
checkpoint can be coordinated by the same durable substrate. They are not
available for arbitrary external side effects.

Potential API:

```ts
const summary = yield* DurableConsumer.run({
  source,
  checkpoint: {
    subscriberId: "email.receipt.v1",
  },
  definition,
  policy: ClaimPolicy.AtMostOnce(),
  process: input =>
    Effect.gen(function* () {
      yield* sendToExternalSystem(input)
    }),
})
```

The consumer should expose both sink and stream forms:

```ts
const definition = SendReceiptEmails
const checkpoint = { subscriberId: "email.receipt.v1" }

const summary = yield* source.read({ live: true }).pipe(
  Stream.run(DurableConsumer.sink({ definition, checkpoint, process })),
)

const outputs = DurableConsumer.stream({
  source,
  definition,
  checkpoint,
  process: input => Effect.succeed(project(input)),
})
```

The sink form is the natural shape for consuming source facts and returning a
summary. The stream form is the natural shape for emitting derived outputs into
another Effect stream pipeline.

The caller should not need to implement checkpoint read/write semantics. The
policy determines whether the checkpoint is written before processing, after
processing, or both.

### DurableProjection

`DurableProjection` is the bridge between raw fact streams and queryable
tables. Raw domain facts are append-only history. `DurableTable` consumes
State Protocol change events. The projection is the place where raw facts
become insert/update/delete/upsert changes.

In v0, projections emit State Protocol change events directly. This is simpler
and keeps the table boundary aligned with `createStreamDB`. If composability
pressure appears later, a future operator can split "domain projection" from
"domain-to-change-event translation."

```ts
export interface DurableProjectionDefinition<Source, State, Target> {
  readonly name: string
  readonly initialState: Effect.Effect<State>
  readonly project: (
    state: State,
    source: Source,
  ) => Stream.Stream<Target, DurableProjectionError>
}
```

This should remain separate from `DurableConsumer`. A projection derives data.
A consumer performs side effects with durable checkpoints.

Projection state is intentionally owned by the projection and allocated inside
Effect, typically through `Ref.make` or `SynchronizedRef.make`. Mutable values
escaping the Effect boundary are not supported. Source streams that feed
projections must be fully retained for cold-start replay in v0. Bounded replay
and checkpointed projection state are future work.

The projection target is a typed durable stream for State Protocol change
events. For table-backed streams, event `type` values follow the
`<tableNamespace>.<collectionKey>` DurableTable convention.

Example:

```txt
debit/credit facts
  -> DurableProjection computes account balance row
  -> example.accountBalances upsert event
  -> DurableTable query
```

## Examples The API Must Fit

### Example A: Order Email Consumer

Process each order-created fact once per email subscriber.

```ts
const SendReceiptEmails = DurableConsumer.define({
  name: "send-receipt-emails",
  select: fact => fact.type === "order.created" ? Option.some(fact) : Option.none(),
  key: order => order.orderId,
})

const EmailConsumerLive = Layer.mergeAll(
  ConsumerCheckpointStoreLive({
    streamOptions: emailCheckpointStreamOptions,
  }),
  EmailServiceLive,
)

yield* DurableConsumer.run({
  source: OrderFacts,
  checkpoint: {
    subscriberId: "email.receipt.v1",
  },
  definition: SendReceiptEmails,
  policy: ClaimPolicy.AtLeastOnce(),
  process: order =>
    Effect.flatMap(EmailService, service => service.sendReceipt(order)),
}).pipe(
  Effect.provide(EmailConsumerLive),
)
```

The consumer program depends on services through `R`; Layers wire concrete
checkpoint and side-effect implementations at the application edge.

### Example B: Webhook Deduplication

Record webhook payloads as facts, then materialize latest processing state by
provider event id.

```ts
class WebhookTable extends DurableTable("example", {
  webhooks: Schema.Struct({
    providerEventId: Schema.String.pipe(DurableTable.primaryKey),
    receivedAt: Schema.DateFromString,
    status: Schema.Literal("received", "processed", "failed"),
  }),
}) {}

const row = {
  providerEventId: fact.providerEventId,
  receivedAt: fact.receivedAt,
  status: "received",
}

const table = yield* WebhookTable
yield* table.webhooks.upsert(row)
const webhook = yield* table.webhooks.get(fact.providerEventId)

const Live = WebhookTable.layer({ streamOptions })
```

### Example C: Account Balance Table

Project debit/credit facts into account balance upsert events, then materialize
the upserts. The running aggregate belongs in `DurableProjection`, not in a v0
table reducer.

```ts
const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
type AccountId = Schema.Schema.Type<typeof AccountId>

const AccountBalanceSchema = Schema.Struct({
  accountId: AccountId.pipe(DurableTable.primaryKey),
  balance: Schema.Number,
})

class AccountBalanceTable extends DurableTable("example", {
  accountBalances: AccountBalanceSchema,
}) {}

const accountBalanceUpsert = (row: typeof AccountBalanceSchema.Type) => ({
  type: "example.accountBalances",
  key: row.accountId,
  value: row,
  headers: { operation: "upsert" as const },
})

const AccountBalanceProjection = DurableProjection.define({
  name: "account-balance",
  initialState: Ref.make(HashMap.empty<AccountId, number>()),
  project: (stateRef, fact) =>
    Stream.fromEffect(Ref.modify(stateRef, state => {
      const previous = HashMap.get(state, fact.accountId).pipe(
        Option.getOrElse(() => 0),
      )
      const balance = previous + fact.delta
      const nextState = HashMap.set(state, fact.accountId, balance)
      return [
        accountBalanceUpsert({
          accountId: fact.accountId,
          balance,
        }),
        nextState,
      ]
    }),
    )),
})

yield* DurableProjection.run({
  source: DebitCreditFacts,
  target: DurableStream.define({
    endpoint,
    schema: StateEventSchema,
  }),
  definition: AccountBalanceProjection,
})

const Live = AccountBalanceTable.layer({ streamOptions })
```

The projection target stream and `DurableTable` `streamOptions` must reference
the same underlying durable stream. The projection writes change events; the
table consumes them.

The projection does not read from the table it produces. Projection state is
owned by the projection and derived deterministically from the source fact
stream. Read-model feedback is deferred to a future version.

### Example D: Firegrid Session Input

Firegrid should be only one validation case.

```ts
const LocalProcessInputConsumer = DurableConsumer.define({
  name: "local-process-session-input",
  select: row =>
    row.type === "firegrid.runtime_ingress.requested" &&
    row.contextId === contextId
      ? Option.some(row)
      : Option.none(),
  key: row => row.ingressId,
})

const stdin = DurableConsumer.stream({
  source: RuntimeIngressRows,
  checkpoint: {
    subscriberId: "runtime-context:local-process:stdin",
  },
  definition: LocalProcessInputConsumer,
  policy: ClaimPolicy.AtMostOnce(),
  process: row =>
    Effect.flatMap(RuntimeInputWriter, writer =>
      writer.encodePromptForStdin(row)),
})
```

The important result: Firegrid code stops maintaining a custom
`PendingRuntimeIngressState` and stops manually folding `requested` minus
`accepted` rows.

### Example E: Durable Wait Predicate

Future workflow-backed tools need "wait until a stream event matches a
predicate." This should become a consumer/table composition, not a bespoke
required-action plane.

```ts
const WaitForPermissionRequest = DurableConsumer.define({
  name: "wait-for-permission-request",
  select: event => permissionPredicate(event) ? Option.some(event) : Option.none(),
  key: event => event.eventId,
})
```

The workflow can suspend on the consumer result through Effect workflow
primitives, while the operator remains a durable stream/table program.

The operator package should not implement workflow suspension itself. A matcher
operator can complete a workflow-owned `DurableDeferred`; the workflow engine
remains responsible for durable suspension/resume semantics. Time-based
suspension should similarly use workflow durable-clock primitives rather than a
custom scheduler in this package.

## API Sketch

### Definitions Are Values

Definitions should be plain values, not services:

```ts
const definition = DurableConsumer.define({...})
```

Running requires effects:

```ts
yield* DurableConsumer.run({ source, checkpoint, definition, process })
```

This keeps the API close to Effect style. Layers should provide infrastructure
clients only when needed, not hide domain wiring.

### Services And Layers

Long-running operator programs should expose dependencies through Effect's `R`
channel. Side-effect dependencies, checkpoint stores, durable stream endpoints,
and table resources should be provided by `Layer` at the application edge.

`DurableConsumer` should not accept concrete backend objects for dependencies
that are naturally services. It should require services such as
`ConsumerCheckpointStore`, while the package provides a State Protocol-backed
Layer for v0.

```ts
const ProgramLive = Layer.mergeAll(
  ConsumerCheckpointStoreLive({
    streamOptions: emailCheckpointStreamOptions,
  }),
  EmailServiceLive,
)

const program = DurableConsumer.run({
  source: OrderFacts,
  checkpoint: { subscriberId: "email.receipt.v1" },
  definition: SendReceiptEmails,
  policy: ClaimPolicy.AtLeastOnce(),
  process: order =>
    Effect.flatMap(EmailService, service => service.sendReceipt(order)),
})

yield* program.pipe(Effect.provide(ProgramLive))
```

### Streams Stay Visible

The API should accept `DurableStream.Bound<A, I>` or an equivalent typed
source. It should not introduce a parallel stream type.

```ts
const source = DurableStream.define({
  endpoint,
  schema: FactSchema,
})

yield* DurableConsumer.run({ source, ... })
```

### Tables Are Queryable

Tables should expose at least:

```ts
interface DurableTableService<Schemas extends Record<string, Schema.Struct<any>>, E, R> {
  readonly [Name in keyof Schemas]: {
    readonly insert: (row: DurableTable.Row<Schemas[Name]>) => Effect.Effect<void, E, R>
    readonly upsert: (row: DurableTable.Row<Schemas[Name]>) => Effect.Effect<void, E, R>
    readonly delete: (key: DurableTable.PrimaryKey<Schemas[Name]>) => Effect.Effect<void, E, R>
    readonly get: (key: DurableTable.PrimaryKey<Schemas[Name]>) =>
      Effect.Effect<Option.Option<DurableTable.Row<Schemas[Name]>>, E, R>
    readonly query: <A>(
      build: (coll: Collection<DurableTable.Row<Schemas[Name]> & object, string>) => A,
    ) => Effect.Effect<A, E, R>
    readonly subscribe: <A>(
      subscribe: (
        coll: Collection<DurableTable.Row<Schemas[Name]> & object, string>,
        emit: (value: A) => void,
      ) => () => void,
    ) => Stream.Stream<A, E, R>
  }
}
```

Each table service exposes collection facades as direct properties. Methods do
not take a collection name because the collection has already been selected by
the property access.

```ts
type DurableTable.Row<C> =
  C extends Schema.Schema<infer Row, any, any> ? Row : never

type DurableTable.PrimaryKey<C> =
  // the type of the one top-level field annotated with DurableTable.primaryKey
  string | number
```

This is the main way to stop application code from rebuilding folds in every
call site. The exact `query` and `subscribe` function signatures should follow
TanStack DB collection/query-builder APIs; the important point is that the
facade is multi-collection, matching `createStreamDB`.

TanStack DB subscriptions are callback-oriented, not native `AsyncIterable`s.
The facade should bridge those subscriptions into `Stream` without pretending
the upstream API is already stream-shaped.

### Table Backends

`DurableTable` has one recommended production path in v0:

```txt
@durable-streams/state createStreamDB
```

Keep an in-memory test variant only if it materially simplifies unit tests. Do
not build it first, and do not let it define semantics that differ from
`createStreamDB`. Prefer a real test durable stream when practical.

## Error Model

Operator errors should be `Schema.TaggedError` classes, not opaque aliases:

```ts
class DurableProjectionError extends Schema.TaggedError<DurableProjectionError>()(
  "DurableProjectionError",
  {
    projection: Schema.String,
    cause: Schema.Defect,
  },
) {}

class DurableTableError extends Schema.TaggedError<DurableTableError>()(
  "DurableTableError",
  {
    table: Schema.String,
    cause: Schema.Defect,
  },
) {}

class DurableConsumerError extends Schema.TaggedError<DurableConsumerError>()(
  "DurableConsumerError",
  {
    consumer: Schema.String,
    cause: Schema.Defect,
  },
) {}

class CheckpointError extends Schema.TaggedError<CheckpointError>()(
  "CheckpointError",
  {
    subscriberId: Schema.String,
    key: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
```

Apply the same pattern to table, consumer, and checkpoint errors. This keeps
errors serializable and matchable across durable boundaries.

## Checkpoint Semantics

Checkpoints are not the same as transport idempotency.

`effect-durable-streams` producer idempotency protects ambiguous writes to the
durable stream. It does not prove whether a consumer has already performed an
external side effect after reading a row.

`DurableConsumer` should make this distinction explicit:

```txt
transport dedupe:
  producer retries append safely

consumer checkpoint:
  subscriber records claim/commit for side-effect processing
```

For external side effects, the operator should force the caller to choose a
claim/commit policy rather than hiding the semantics behind a vague
"accepted" row.

Checkpoint rows are written through State Protocol in v0. The caller provides a
subscriber id; `ConsumerCheckpointStore` is provided as a Layer and
`DurableConsumer` owns the checkpoint schema and read/write rules.

`DurableConsumer.run` may accept a retry `Schedule` for the `process` effect.
The default is no retry. Retry semantics compose with the selected delivery
policy: `AtLeastOnce` with retries may process an input multiple times until it
can write completion; `AtMostOnce` records the claim before any retryable
process attempt.

```ts
retry: Schedule.exponential("100 millis").pipe(
  Schedule.intersect(Schedule.recurs(5)),
)
```

## Concurrency Primitives

Implementations should use Effect concurrency primitives directly:

- `Ref` or `SynchronizedRef` for projection state;
- `Queue` for batching events into durable writes;
- `Deferred` or `Latch` for one-shot readiness and up-to-date signals;
- scoped `Fiber` lifecycles for long-running consumers;
- `Semaphore` when single-flight per key is required.

Do not implement Promise-based callback loops when an Effect primitive models
the lifecycle directly.

## Package Boundary

Recommended package:

```txt
packages/effect-durable-operators/
  package.json
  src/
    DurableTable.ts
    DurableConsumer.ts
    DurableProjection.ts
    index.ts
  test/
    durable-table.test.ts
```

Dependencies:

- `effect`
- `@durable-streams/client`
- `@durable-streams/state`
- `@tanstack/db`

`@tanstack/db-ivm` is internal to TanStack DB. Do not import it directly.

Forbidden dependencies:

- `@firegrid/runtime`
- `@firegrid/client`
- `@firegrid/protocol`
- `@firegrid/durable-streams`
- scenarios/apps packages

`@firegrid/durable-streams` has been deleted. This operators package uses
upstream `@durable-streams/state` directly for the table facade and must not
depend on Firegrid runtime substrate adapters.

## Tracer Proposal

### 017: Durable Operators API Validation

Goal: prove a generic durable operator package can remove application-level
retained/live checkpoint folds without overfitting to Firegrid.

Acceptance:

1. Add `packages/effect-durable-operators`.
2. Provide `DurableConsumer` and `DurableTable` minimum APIs.
3. `DurableTable` user-facing collections are Effect
   Schema-native and translated to Standard Schema only at the
   `createStreamDB` boundary.

Durable table/projection acceptance:

4. Account balance test: `DurableProjection` converts debit/credit facts into
   upsert events, materialized through `DurableTable`, queried through
   collection get and live query.
5. `DurableTable` chaos test: stop mid-stream, restart, and confirm the
   collection rebuilds correctly through the up-to-date replay protocol.

Durable consumer acceptance:

6. Order email test: `DurableConsumer` processes a raw fact stream, with no
   table.
7. Firegrid-shaped test: `DurableConsumer` handles runtime input with local
   schemas inside the test, not importing Firegrid packages.
8. `DurableConsumer` restart tests:
   - `AtMostOnce` does not duplicate an already claimed side effect after
     restart;
   - `AtLeastOnce` does not lose uncommitted work after restart.

Firegrid integration acceptance:

9. Replace Firegrid runtime input manual pending fold with the generic
   `DurableConsumer` only after the generic tests pass.
10. Firegrid runtime code no longer owns a custom requested-minus-accepted fold.
11. The Firegrid tracer scenario still proves behavior through production
   `Firegrid.launch`, `Firegrid.prompt`, `Firegrid.open(...).snapshot`, and
   host `startRuntime`.
12. The package exports no Firegrid domain names.

The first implementation should be intentionally small. Prefer a correct
consumer/table kernel over an expansive DSL.

## Open Questions

1. Should exactly-once stream-to-stream or stream-to-state operators be a
   separate future primitive, or an extension of `DurableConsumer`?
2. Should `DurableConsumer.stream` emit only processed outputs, or should it
   expose checkpoint/claim events as a side channel for observability?
3. What concrete use case earns an append-only checkpoint backend? State
   Protocol checkpoints are the only v0 backend.
4. Should this package be Firegrid-scoped (`@firegrid/effect-durable-operators`)
   or unscoped (`effect-durable-operators`)? Since Firegrid is the only
   consumer for now, use the workspace package name while keeping the code
   domain-neutral.

## References

- Kafka Streams stream/table concepts:
  https://docs.confluent.io/platform/current/streams/concepts.html
- ksqlDB materialized views:
  https://docs.ksqldb.io/en/latest/concepts/materialized-views/
- Durable Streams `@durable-streams/state` `stream-db.ts`:
  https://github.com/durable-streams/durable-streams/blob/main/packages/state/src/stream-db.ts
- TanStack DB:
  https://tanstack.com/db
- Kafka car-data producer example:
  https://github.com/kubinio123/hands-on-kafka-streams/blob/master/car-data-producer/src/main/scala/car/producer/CarDataProducer.scala
- Kafka car-data consumer example:
  https://github.com/kubinio123/hands-on-kafka-streams/blob/master/car-data-consumer/src/main/scala/car/consumer/CarDataConsumer.scala
- Kafka car domain model example:
  https://github.com/kubinio123/hands-on-kafka-streams/blob/master/domain/src/main/scala/car/domain/domain.scala
