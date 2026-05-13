# Target Architecture: Managed-Agent Runtime Over Durable Facts

**Status:** canonical target architecture. Promoted from "proposed fork" to
canonical on 2026-05-12 and updated after the DurableTable surface cleanup on
2026-05-13.

**Last updated:** 2026-05-13

Source material:

- `docs/research/durable-execution-api-design-survey.md` (historical research)
- `docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md`
- `docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md`
- `docs/tracers/017-effect-durable-operators.md`
- PR #166, "Collapse durable state surfaces onto DurableTable"

## Thesis

Firegrid is a managed durable agent runtime whose behavior is driven by durable
facts and durable table state.

The target is not "many small durable abstractions." The target is a small set
of blessed primitives:

1. `DurableTable` for ordinary queryable durable state.
2. `effect-durable-streams` for raw retained fact streams that are intentionally
   append-only.
3. Effect `Layer`, `Stream`, `Scope`, and service requirements for composition.
4. `@effect/workflow` for workflow execution, activity replay, clocks, and
   deferred resume.

Everything else should be product-owned code that composes these primitives.
Do not reintroduce broad generic surfaces just because a local workflow needs a
few lines of policy.

## Blessed Components

### DurableTable

`DurableTable` is the default for table-shaped durable state:

- runtime control plane rows;
- runtime ingress rows;
- delivery/checkpoint/claim rows;
- workflow executions, activities, deferreds, and clock wakeups;
- app-owned state such as Flamecast turns/messages/sessions;
- any read model that is queried, snapshotted, subscribed to, or keyed by
  stable identity.

Layers are provided at service or application scope, not per row operation.
Code should use the service facade directly:

```ts
const table = yield* RuntimeIngressTable
yield* table.inputs.upsert(row)
const rows = yield* table.inputs.query((coll) => coll.toArray)
```

Do not wrap `DurableTable` with store services, materializer services,
checkpoint-store services, or one-off helpers that only forward to
`insert`/`upsert`/`get`/`query`.

### effect-durable-streams

`effect-durable-streams` remains the Effect-native raw Durable Streams boundary.
Use it only for retained fact streams where the append-only log is the product
semantics.

The current accepted exception is runtime output: child-process stdout/stderr
is still written as an append-only retained fact journal. That exception must
remain isolated in the runtime output boundary. It must not justify raw stream
reintroduction for runtime control plane, runtime ingress, delivery
checkpointing, or ordinary app state.

If runtime output becomes primarily a queried/snapshotted/subscribed state
surface, it should move to `DurableTable` too.

### Effect Layers

Composition is an application or package entrypoint concern. Do not create a
new top-level package just to hold "composition" helpers or URL-formatting
topology.

Use Effect layers to install:

- durable table services;
- sandbox providers;
- workflow engine services;
- runtime host config;
- app-owned handlers.

The top-level package APIs should remain domain/runtime primitives. Product
composition belongs in a root app entrypoint, package-specific `Live` layer, or
future root `src/` composition module if the repository needs one.

## Current Package Shape

The post-cleanup package map is:

```txt
packages/
  effect-durable-streams/
    src/
      DurableStream.ts
      Bound.ts
      Reader.ts
      Writer.ts

  effect-durable-operators/
    src/
      DurableTable.ts

  protocol/
    src/
      launch/            # shared launch/control-plane schemas + table
      runtime-ingress/   # shared ingress/delivery schemas + table

  runtime/
    src/
      runtime-host/      # runtime host layer/entrypoint
      runtime-ingress/   # table delivery/sequencing owned by runtime
      runtime-output/    # isolated raw retained output fact stream
      workflow-engine/   # workflow table + Effect Workflow engine bridge
      providers/
        sandboxes/

  client/
    src/
      firegrid.ts        # public client API over shared tables/fact streams
```

Deleted and not part of the target:

```txt
packages/durable-streams/
packages/effect-durable-streams-state/
packages/runtime/src/materialization/
packages/runtime/src/runtime-context/
packages/runtime/src/providers/materialize/
packages/protocol/src/required-action/
packages/protocol/src/session/
packages/effect-durable-operators/src/DurableConsumer.ts
packages/effect-durable-operators/src/DurableProjection.ts
packages/effect-durable-operators/src/ConsumerSource.ts
packages/effect-durable-operators/src/ConsumerCheckpointStore.ts
packages/effect-durable-operators/src/electric.ts
scenarios/firegrid/src/scenario-harness.ts
scenarios/firegrid/src/durable-stream-fixtures.ts
```

Do not preserve these names by moving them into a different package.

## Protocol Package Boundary

`@firegrid/protocol` currently acts as the shared durable-contract package.
The name may be revisited later, but the boundary is:

- public request schemas;
- shared durable row schemas;
- shared `DurableTable` declarations when browser/client and host both need
  the same table contract;
- stable ID/key constructors only when they encode durable product identity.

It must not own:

- Durable Streams server/client/state imports;
- `createStateSchema` or `createStreamDB`;
- deployment topology or URL derivation;
- runtime provider delivery policy;
- materialization strategies;
- workflow engine state stores;
- generic test helpers.

If a schema test only proves Effect Schema or DurableTable library behavior, it
does not belong here. Keep protocol tests only when they prove Firegrid product
contracts such as public launch redaction, deterministic idempotency IDs, or
durable row ID conventions.

## Runtime Control Plane

Runtime control plane is DurableTable-backed. It owns runtime context rows and
run lifecycle rows.

Clients create contexts through `@firegrid/client`. Runtime hosts read contexts
and write run status through the same shared table. There should be one table
contract and one durable type convention, not client/runtime variants.

The runtime host must not wrap this table in a generic service that only
renames table operations.

## Runtime Ingress

Runtime ingress is DurableTable-backed. The accepted v0 model is:

1. writers create pending input rows;
2. the host/sequencer assigns explicit per-context sequence and marks rows
   sequenced;
3. providers read/query/subscribe sequenced rows;
4. provider delivery writes claim rows before externally visible side effects.

This table shape gives Firegrid:

- deterministic idempotency by input ID;
- multi-writer safety by separating write intent from host sequencing;
- query/subscription ergonomics through `DurableTable`;
- delivery checkpoint state without a generic checkpoint store.

Do not reintroduce a raw runtime-ingress stream plus a reducer layer. If a
future path needs strict global ordering, add an explicit sequence allocation
design to the table model instead of relying on hidden stream append order.

## Runtime Output

Runtime output is currently the one raw retained fact-stream exception. The
reason is append-only process telemetry: stdout/stderr chunks are written as
facts in order by a scoped producer.

This exception is under active architectural review. Any code that reads
runtime output as state, snapshots it, queries it by context, or projects it
into sessions is evidence that runtime output should become a `DurableTable`
instead.

The boundary rule is strict:

- raw output writer code may live only in `runtime-output/`;
- runtime host may call that boundary but must not contain producer/mapping
  ceremony itself;
- runtime output must not become another service plane;
- output table migration should be preferred once product semantics are
  clearly table-shaped.

## Workflow Engine

Workflow engine rows are mostly DurableTable-backed:

- executions;
- activities;
- deferreds;
- clock wakeups;
- activity claims as materialized rows.

Activity claim fencing is the current tiny exception. The claim path uses a
raw durable append because the current `DurableTable` facade does not expose
the exact fenced/idempotent append semantics needed for raced worker claims.
This exception is acceptable only while:

- it is isolated inside workflow-engine internals;
- it is documented near the claim code;
- the raced-claim test proves one activity body run and one durable claim;
- no general store/service wrapper is reintroduced around it.

A future DurableTable extension for fenced append may remove this exception.

## Runtime Host

The runtime host is a composition/execution boundary, not a general durable
state framework.

It may:

- derive product table/stream URLs from `durableStreamsBaseUrl + namespace`;
- provide shared DurableTable layers once per runtime host lifetime;
- provide the sandbox provider and workflow engine layer;
- start a runtime for a context;
- append runtime ingress through the ingress table when input is enabled.

It should not:

- contain row schemas that belong to shared contracts;
- contain local-process-specific command derivation if that belongs with the
  provider;
- instantiate DurableTable layers per operation;
- own output producer details directly;
- own generic materialization or projection strategies;
- expose a broad service if plain Effect functions over table/provider services
  are sufficient.

## Client Boundary

Client launch and prompt APIs describe user or agent intent.

```ts
const handle = yield* firegrid.launch({
  runtime: local.jsonl({
    argv: ["node", "agent.js"],
  }),
})

yield* firegrid.prompt({
  contextId: handle.contextId,
  payload: { type: "text", text: "Continue." },
  idempotencyKey: "user:continue:1",
})
```

Clients should not choose workflow engines, provider registries,
materialization strategies, operator sets, matcher code, or runtime host
topology.

For tests and local development, a product-level config such as
`durableStreamsBaseUrl + namespace` is acceptable. Individual tests should not
manually juggle table stream URLs when exercising table-backed Firegrid
behavior.

## Future Durable Capabilities

Future agent capabilities should lower to durable facts and/or durable table
rows through the existing primitives.

Examples:

- `wait_for(trigger, timeout?)` should create named wait descriptors and
  outcome rows, then resume workflow-owned deferreds or executions.
- `schedule_me(when, prompt)` should create schedule rows and later append
  runtime ingress through the host ingress table.
- `spawn(agent, prompt)` should create child runtime context rows and initial
  ingress rows through the same client/host surfaces.
- `execute(tool/sandbox, input)` should use explicit durable request/result
  rows and provider-owned side-effect policy.

Do not rebuild a required-action-specific service, callback package, runtime
operator framework, materialization framework, or consumer/checkpoint package
to implement these.

## Guardrails For Review

Reviewers should look for these smells:

- direct `@durable-streams/*` imports outside blessed substrate packages or
  test files;
- new wrappers around `DurableTable` that only rename table operations;
- `DurableTable.layer(...)` acquired per insert/get/query instead of per
  service scope;
- raw streams used for table-shaped state;
- test helpers that hide product composition or stream ownership;
- package creation for one function or one scenario;
- protocol owning URL topology, runtime policy, or deployment concerns;
- stale folders recreated under new names;
- tests that verify library behavior rather than Firegrid semantics.

The north star is smaller surface area: table state uses `DurableTable`, raw
facts use `effect-durable-streams`, and product behavior is ordinary Effect
code at the owning boundary.
