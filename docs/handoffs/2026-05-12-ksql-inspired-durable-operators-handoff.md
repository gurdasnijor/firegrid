# Handoff: Ksql-Inspired Durable Operators API Exploration

Status: Superseded by PR #166, "Collapse durable state surfaces onto DurableTable".

Date: 2026-05-12
Repo: `/Users/gnijor/gurdasnijor/firegrid`

This handoff exists because the current session is overloaded and the next
phase needs a fresh design pass. Stop patching the current wait/workflow
implementation until the central durable-table/action API is rethought.

## Why This Exists

Firegrid is converging on durable facts plus generic operators, but the next
API layer is still too low-level. The current tracer-020 wait proof exposes too
much plumbing in scenario code, and the workflow-engine cleanup started to
recreate state/action substrate that already exists upstream in
`@durable-streams/state`.

The important new direction is to study ksqlDB/KStreams semantics and decide
how much of that shape belongs in `effect-durable-operators`, especially around
streams, tables, changes, actions/mutations, and declarative query/update
programs.

## Current State To Be Careful With

At the time of this handoff, the worktree may be mid-cleanup. Before editing:

```bash
git status --short
rg -n "@firegrid/durable-streams|effect-durable-streams-state|effect-workflow-durable-streams|activityClaims|claimActivity|createStreamDB|createStateSchema" packages apps scenarios docs features
```

Recent local cleanup intent was:

- delete `packages/effect-durable-streams-state/**`;
- delete the broad `packages/durable-streams/**` wrapper;
- move test utilities to `effect-durable-streams/test-utils`;
- introduce a narrow `effect-workflow-durable-streams` package only if it is a
  thin `@effect/workflow` compatibility adapter;
- remove workflow activity-claim rows because durable claim/checkpoint
  semantics belong in `DurableConsumer`, not in workflow state.

Do not preserve legacy code just because it exists in the dirty tree. Also do
not land a new workflow package that directly recreates a private
`createStreamDB` action layer unless that is explicitly chosen as the thin
substrate boundary.

## Design Goal

Design a central, ergonomic durable-operator API that can express:

- append-only fact streams;
- keyed changelog/materialized tables;
- collection-scoped insert/upsert/delete actions;
- snapshot and live query semantics;
- stream-to-table projections;
- consumer checkpoints and side-effect processing;
- higher-level wait/trigger/time/spawn behavior built above those primitives.

The API should feel like ordinary Effect code and should be hard to confuse
with Firegrid-specific service planes.

## Primary References

Local:

- `docs/architecture/managed-agent-runtime-target-durable-facts.md`
- `docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md`
- `docs/proposals/SDD_EFFECT_DURABLE_CONSUMER_SOURCES.md`
- `packages/effect-durable-operators/src/DurableTable.ts`
- `packages/effect-durable-operators/src/DurableConsumer.ts`
- `packages/effect-durable-operators/src/DurableProjection.ts`
- `packages/effect-durable-operators/src/ConsumerSource.ts`
- `packages/effect-durable-operators/README.md`
- `packages/effect-workflow-durable-streams/src/internal/workflow/engine-runtime.ts`
- `packages/effect-workflow-durable-streams/src/internal/workflow/state.ts`

External:

- ksqlDB reference: <https://github.com/confluentinc/ksql/tree/master/docs/developer-guide/ksqldb-reference>
- `INSERT INTO`: <https://github.com/confluentinc/ksql/blob/master/docs/developer-guide/ksqldb-reference/insert-into.md>
- `INSERT VALUES`: <https://github.com/confluentinc/ksql/blob/master/docs/developer-guide/ksqldb-reference/insert-values.md>
- Durable Streams `stream-db`: <https://github.com/durable-streams/durable-streams/blob/main/docs/stream-db.md>
- Durable Streams State Protocol: <https://github.com/durable-streams/durable-streams/blob/main/packages/state/STATE-PROTOCOL.md>

## KsqlDB Semantics Worth Modeling

Do not copy SQL syntax. Extract the semantics.

### Stream vs Table

KsqlDB separates append-only streams from materialized tables. That maps well:

- Firegrid durable fact stream = append-only stream.
- State Protocol collection / `DurableTable` = keyed changelog table.
- Projection = continuous query from stream to table or stream to stream.

The API should make this split explicit. If a caller is appending facts, they
are writing to a stream. If a caller is changing keyed state, they are writing a
change event to a table-backed stream.

### Insert / Upsert / Delete

KsqlDB has insertion into streams/tables as an explicit operation, and table
semantics are keyed. In Firegrid terms:

- `stream.append(fact)` writes immutable history.
- `table.<collection>.insert(row)` writes a keyed insert change.
- `table.<collection>.upsert(row)` writes a keyed latest-state change.
- `table.<collection>.delete(key)` writes a keyed removal.

This should be generic and generated for every collection bound to a
`createStreamDB` instance. It should not be a one-off `DurableTable.upsert`
method that bypasses the upstream `actions({ db, stream })` model.

### Queries

We likely want three query shapes:

- pull query: point-in-time `get` or `query` over materialized state;
- push query: subscribe to live table changes;
- stream query: transform/filter a fact stream through Effect `Stream`.

The names should make consistency boundaries clear. Pull queries read the
currently materialized view. Push queries observe later changes. Stream queries
process ordered facts.

### Derived Tables

KsqlDB derived tables correspond to Firegrid projections:

```txt
raw durable fact stream
  -> deterministic projection
  -> State Protocol change stream
  -> DurableTable materialization
```

The projection must be deterministic over retained input facts. If projection
state is in-memory, it must be derived by replay. If bounded replay is needed,
that is a separate checkpointed projection design.

### Actions Are The Missing API Layer

The central missing shape is generic action generation over collections.
Upstream `createStreamDB` already has:

```ts
interface ActionDefinition<TParams = any, TContext = any> {
  onMutate: (params: TParams) => void
  mutationFn: (params: TParams, context: TContext) => Promise<any>
}
```

The durable operators package should expose this in Effect-native form without
hiding the upstream semantics. The caller should not pass an `actions:` config
for the common case; actions are generated by convention from collection
declarations.

Target API shape:

```ts
class WorkflowTable extends DurableTable("workflow", {
  executions: Schema.Struct({
    executionId: Schema.String.pipe(DurableTable.primaryKey),
    workflowName: Schema.String,
    payload: Schema.Unknown,
  }),

  activities: Schema.Struct({
    activityKey: Schema.String.pipe(DurableTable.primaryKey),
    executionId: Schema.String,
    result: Schema.Unknown,
  }),

  clockWakeups: Schema.Struct({
    clockKey: Schema.String.pipe(DurableTable.primaryKey),
    deadlineMs: Schema.Number,
    status: Schema.Literal("pending", "fired"),
  }),
}) {}

const program = Effect.gen(function* () {
  const table = yield* WorkflowTable

  yield* table.executions.upsert(row)
  const execution = yield* table.executions.get(row.executionId)
  yield* table.clockWakeups.delete(clockKey)

  const rows = yield* table.executions.query(coll => coll.toArray)
  const live = table.executions.subscribe((coll, emit) =>
    coll.subscribe(() => emit(coll.toArray)),
  )
})

const Live = WorkflowTable.layer({
  streamOptions: { url: workflowStreamUrl, contentType: "application/json" },
})
```

The important part is that the row schema is the collection declaration. The
primary key is field-level schema metadata through `DurableTable.primaryKey`, a
pipe-able helper that annotates the field schema. Actions are per-collection,
generated from schema metadata by convention, and implemented through
`createStreamDB({ actions })`, not by manual durable stream append code at each
call site.

## Target Declaration API

Primary declaration surface:

```ts
class ExampleTable extends DurableTable("example", {
  rows: Schema.Struct({
    id: Schema.String.pipe(DurableTable.primaryKey),
    value: Schema.Number,
  }),
}) {}
```

`DurableTable(...)` should return an Effect service-tag class with a `.layer()`
method. The declaration is static table schema. The layer binds that schema to a
specific durable stream and owns preload, scope, and close. User programs should
consume the table through `yield* ExampleTable`, not through an explicit
`define(...).materialize(...)` sequence.

`DurableTable.primaryKey` is a field modifier, aligned with Effect Schema
conventions such as `Schema.String.pipe(Schema.brand(...))`. It should
internally attach a package-owned primary-key annotation to the field schema so
`DurableTable(...)` can inspect the struct AST and find the key field. Users
should not write symbol annotations directly, and they should not repeat the
key name in a parallel `primaryKey: "..."` option.

Support both forms only if cheap:

```ts
id: Schema.String.pipe(DurableTable.primaryKey)
id: DurableTable.primaryKey(Schema.String)
```

The pipe-able form is the primary documentation path because it composes better
with brands, filters, transformations, and other schema modifiers.

This is a better use of Effect Schema than a wrapper/options-bag collection API:
primary-key-ness is a property of a field, not a property of a separate wrapper.
The AST should carry that fact.

### Table Namespace And Durable Types

`DurableTable("workflow", { ... })` declares the persisted table namespace.
That namespace is intentionally top-level because it determines every
collection's durable wire type. If Firegrid owns both producers and consumers,
there is no v0 need for per-collection type overrides.

The State Protocol type is always derived as:

```txt
<tableNamespace>.<collectionKey>
```

Examples:

```txt
workflow.executions
workflow.activities
workflow.clockWakeups
```

Renaming the table namespace or collection key is a replay-breaking migration,
not an API override. The implementation should document this clearly and should
not expose `persistentType`, `Type`, or per-collection wire-type escape hatches
in v0.

### Exactly One Primary Key

Each table collection must have exactly one `DurableTable.primaryKey` field.
Composite keys are out of scope for v0. The implementation should traverse the
struct AST once at table/layer construction and fail loudly when a collection
has zero or multiple primary-key fields.

A runtime construction error is enough for v0; type-level counting can be a
future improvement if it proves worthwhile.

### Pull And Push Queries

Use ksqlDB terms in the docs and readable method names at the call site:

- `get(key)` is a convenience pull query.
- `query(build)` is the general pull query over the materialized collection.
- `subscribe(...)` is the push query over live materialized updates.

Prefer `subscribe` over `changes`; the user intent is to subscribe to live
updates, not to reason about internal change representation.

### Operation-Gated Facade

Do not prioritize operation restrictions in v0. The handoff has no concrete
append-only table consumer that needs operation gating immediately. Default to
`insert`, `upsert`, and `delete` for each collection.

If operation restriction becomes necessary, add it as a schema-level helper that
keeps the row schema as the declaration:

```ts
const EventsOnly = Schema.Struct({
  eventId: Schema.String.pipe(DurableTable.primaryKey),
  payload: Schema.Unknown,
}).pipe(DurableTable.operations(["insert"]))
```

When introduced, `operations` must constrain the generated facade at the type
level, not only at runtime.

### Upsert Semantics

Do not assume TanStack DB exposes a native `upsert` method. Generate optimistic
upsert from `get` plus `insert`/`update`:

```ts
const existing = coll.get(key)
if (existing === undefined) {
  coll.insert(row)
} else {
  coll.update(key, draft => {
    Object.assign(draft, row)
  })
}
```

The durable mutation still appends a State Protocol change event with
`headers.operation = "upsert"` and a txid, then awaits that txid through
`db.utils.awaitTxId`.

### Custom Actions

Do not add custom compound action builders in v0. Generated collection actions
are the central interface. Add custom Effect actions only after a real consumer
requires compound writes.

## Workflow Engine Revisit

The durable workflow engine should be thin enough that its value is obvious:

```txt
@effect/workflow API
  -> workflow engine adapter
  -> DurableTable-backed workflow state rows
```

It should persist only:

- executions;
- completed activity results for replay/memoization;
- deferred exits;
- clock wakeups.

It should not persist:

- activity claims;
- worker leases;
- consumer checkpoints;
- wait descriptors;
- required-action state;
- trigger dispatch state.

Those belong in `effect-durable-operators` or a higher Firegrid runtime layer.

If distributed activity execution becomes necessary, model activity work as
durable facts consumed by `DurableConsumer`, then complete the workflow through
`WorkflowEngine.deferredDone` or a similarly explicit workflow completion
surface. Do not hide that in `activityExecute`.

## What To Change After The Design Lands

1. Update `docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md` with an explicit
   "Table Declarations And Actions" section.
2. Add ACIDs to `features/firegrid/effect-durable-operators.feature.yaml` for:
   - `DurableTable.define(name, schemaRecord)` generating a typed
     collection-bound facade directly from Effect row schemas;
   - `DurableTable.PrimaryKey(fieldSchema)` marking exactly one struct field
     as the primary key through schema metadata;
   - durable table metadata stored as schema annotations under helpers;
   - generated per-collection actions;
   - action writes using upstream `createStreamDB` mutation semantics;
   - txid read-after-write coordination;
   - explicit production warning for convention-derived persisted type names;
   - no manual append-based action helpers in consumers.
3. Add focused tests in `packages/effect-durable-operators/test/durable-table.test.ts`:
   - insert/upsert/delete actions materialize correctly;
   - generated actions are typed by collection row/key;
   - `awaitTxId` makes the written row queryable immediately after action
     completion;
   - cold-start replay rebuilds action-written state.
4. Refactor `effect-workflow-durable-streams/src/internal/workflow/state.ts`:
   - define workflow tables with `DurableTable.define(...)` over plain
     `Schema.Struct` row schemas using `DurableTable.PrimaryKey(...)` fields;
   - materialize with `WorkflowTable.materialize({ streamOptions })`;
   - call generated actions in `putExecution`, `putActivity`, `putDeferred`,
     and `putClockWakeup`;
   - keep sync reads over the materialized table view;
   - keep no activity-claim table.
5. Re-run package and repo gates.

## Guardrails

- Do not add a new Firegrid-specific wait module before this table/action
  design is settled.
- Do not add `DurableWait`, `runTerminalEvaluator`, `defineResolver`, or
  similar lifecycle names.
- Do not add manual `append(JSON.stringify(collection.upsert(...)))` at each
  application call site if the collection is already table-backed.
- Do not require callers to pass `actions:` config for standard
  insert/upsert/delete behavior.
- Do not expose symbol annotations in user-facing collection declarations.
- Do not make users repeat `primaryKey: "..."` beside a schema field that can
  carry primary-key metadata itself.
- Do not use workflow state as a generic dispatcher/checkpoint store.
- Do not make `effect-durable-operators` import Firegrid packages.
- Do not make `@firegrid/protocol` import operators or runtime code.

## Suggested Next Session Prompt

```text
We need a fresh design pass for effect-durable-operators DurableTable actions,
informed by ksqlDB stream/table semantics and upstream @durable-streams/state
createStreamDB actions. Read:

- docs/handoffs/2026-05-12-ksql-inspired-durable-operators-handoff.md
- docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md
- packages/effect-durable-operators/src/DurableTable.ts
- packages/effect-workflow-durable-streams/src/internal/workflow/state.ts
- https://github.com/durable-streams/durable-streams/blob/main/docs/stream-db.md
- https://github.com/confluentinc/ksql/tree/master/docs/developer-guide/ksqldb-reference

Goal: propose and then implement a convention-based DurableTable declaration
and action layer:

- DurableTable.define("table", { collection: Schema.Struct({ id:
  DurableTable.PrimaryKey(Schema.String), ... }) })
- no collection wrapper or options object for the common path;
- no user-facing symbol annotations;
- `PrimaryKey` stores field-level metadata as a schema annotation internally;
- durable type is always `${tableNamespace}.${collectionKey}` in v0;
- generated collection-bound facade exposes get/query/changes plus
  insert/upsert/delete methods;
- generated writes use upstream createStreamDB actions, txid headers, and
  awaitTxId;
- workflow state store becomes a thin consumer of that generic API.

Do not preserve activity claims or legacy Firegrid service planes.
```
