# SDD: Target Tiny-Firegrid Architecture Reference

Status: draft architecture
Bead: `tf-3w1e`, reconciled by `tf-qnq9`
Created: 2026-05-21
Last amended: 2026-05-21
Owner: Firegrid Architecture
Extends:
- `SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`
- `SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md`
- `SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md`
- `features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`

## Problem

The current runtime architecture repeatedly grows bridging machinery around
workflow input:

```text
channel or client input
  -> public or semi-public intent row
  -> dispatcher/reconciler
  -> appendRuntimeInputDeferred
  -> numbered workflow deferred
  -> workflow awaits input/N
```

That shape preserves the channel API, but it still treats workflow input as a
mailbox built out of deferred names. It creates extra concepts that are not the
application state:

- request rows;
- claim rows;
- completion rows;
- input-intent rows;
- numbered deferred rows as mail slots;
- dispatcher fibers;
- reconciliation passes;
- helper APIs that expose engine/deferred mechanics.

The big architectural question for this reference is intentionally narrow:

> Can channels write and read workflow-owned `DurableTable` state directly,
> while an individual workflow runs as a state machine over that same table?

The target tiny-firegrid reference exists to answer that question in a clean
room before production migration work keeps fighting historical layers.

## Decision

Build a compact executable reference under `packages/tiny-firegrid` where:

```text
production-compatible channel contract
  -> channel router
  -> channel binding
  -> workflow-owned DurableTable write/read
  -> workflow body reads table state and applies transitions
  -> channel reads expose production-compatible observations
```

The reference must not introduce a second workflow command API, a workflow
inbox service, a kernel authority layer, Host-to-child workflow orchestration,
or a router inside the workflow engine.

The seam is the workflow-owned table:

```text
channels are the public semantic surface
DurableTable is the durable state surface
workflow is the state machine over that table
engine wires table + workflow lifecycle
```

`appendRuntimeInputDeferred` is treated as the production bridge this reference
is trying to make unnecessary for ordinary semantic workflow input.

## Non-Goals

This reference does not:

- replace production `packages/runtime` or `packages/host-sdk`;
- define simulation-only public APIs;
- expose workflow handles, engine handles, stream URLs, or table handles to
  callers;
- model provider execution, sandbox policy, remote hosts, auth, or failover;
- add an authority model;
- add Host-to-child workflow orchestration;
- add a workflow-engine semantic router;
- preserve request/claim/completion/deferred row families as the default
  implementation pattern.

Host workflow ownership, child session workflow launch, authority, placement,
failover, and cross-host routing are later questions. This SDD is Phase 0A:
one workflow, one workflow-owned table seam.

## Architecture Rule

The reference has one rule:

> A workflow declares and owns its durable table. Channels bind to that table.
> The workflow reads that table and transitions table state.

This replaces both outer and inner mailbox shapes:

```text
not: channel -> input intent -> dispatcher -> deferredDone -> await input/N
yes: channel -> table write -> workflow reads table rows/state
```

The channel binding may use `DurableTable.insertOrGet`, `upsert`, `get`,
`query`, or `rows`. It must not complete workflow deferreds, assign deferred
names, call workflow methods as a public command surface, or expose low-level
table/engine handles to the caller.

## Minimum Primitives

### Channel

A production-compatible semantic target plus schema. It is the API callers and
edge adapters use.

Examples for the reference:

```text
session.prompt   send prompt input
session.events   wait/read session-visible output
session.snapshot call point-in-time session state
```

Prompt and events may remain separate channel registrations because they have
different direction and schema. Architecturally they are one session I/O
capability over the same workflow-owned table.

### Channel Router

The edge dispatch surface. It decodes `target + verb + payload`, validates the
route, emits dispatch spans, and invokes the typed channel binding.

The router does not know workflow names, execution ids, deferred names, table
collection names, stream URLs, or resource transition logic.

### Channel Binding

The implementation of a channel. In this reference, bindings are intentionally
thin:

```text
send/call binding -> write or read SessionTable
wait_for binding  -> stream/query SessionTable
```

Bindings are allowed to know the workflow-owned table service because they are
below the channel boundary. Callers are not.

### Workflow-Owned DurableTable

The table is the workflow's durable state and input surface. The reference uses
one small table for the session vertical slice.

The table should include:

- a session/resource row;
- append-only input rows;
- append-only event/output rows if the reference needs observable output.

The table should not include:

- request rows per operation;
- claim rows for ordinary lifecycle transitions;
- completion rows for ordinary route receipts;
- deferred rows as numbered input mail slots.

### Workflow Body

The workflow is the state machine over the table. It reads unprocessed inputs,
applies state transitions, records output/event rows, and advances its durable
cursor.

The cursor lives in table state, not in memory, not in a deferred name, and not
in a dispatcher-local registry.

### Engine Wiring

The engine's role is lifecycle and wiring:

- acquire the workflow's `DurableTable` layer for the execution stream;
- provide that table to the workflow body;
- start/resume/replay workflow execution;
- optionally resume when table writes occur, if the implementation needs an
  explicit wakeup during the reference.

The engine does not route semantic channel targets.

## Complexity Ground Rules

This reference is allowed to be small. Its job is to prove the table seam, not
to grow a production-ready runtime around it.

The implementation must stop and re-evaluate the SDD before continuing if it
needs any of these above the workflow-owned table seam:

- a new public abstraction or API surface;
- a request, claim, completion, input-intent, or deferred bridge;
- a registry/catalog broader than the channel router;
- a side-effect adapter subsystem;
- host authority, placement, failover, or cross-host routing;
- parent/child workflow orchestration;
- generic repository/helper layers over `DurableTable`;
- more than the five reference files without a clear reason tied to the seam
  proof.

The expected implementation size should stay boring. If the simulation starts
needing hundreds of lines outside `session.ts`, `binding.ts`, and `layer.ts`,
that is evidence the reference is drifting away from the intended claim:

```text
channel -> table write/read -> workflow reads table state
```

In that case the next step is not to keep coding. The next step is to name the
missing primitive or invalid assumption in the SDD.

## Target State Model

The initial reference should prove a single session workflow. Host and
parent/child workflow composition can be added after the table seam is proven,
using the same pattern with a host-owned table.

The schema below is the reference's concrete instantiation. The architectural
claim is the seam shape, not this exact column list or collection count.

```ts
class SessionTable extends DurableTable("tinyReference.session", {
  sessions: Schema.Struct({
    sessionId: Schema.String.pipe(DurableTable.primaryKey),
    status: Schema.Literal(
      "created",
      "running",
      "cancelling",
      "closed",
      "failed",
    ),
    nextInputSequence: Schema.Number,
    revision: Schema.Number,
    updatedAt: Schema.Number,
  }),

  inputs: Schema.Struct({
    inputKey: Schema.String.pipe(DurableTable.primaryKey),
    sessionId: Schema.String,
    sequence: Schema.Number,
    kind: Schema.Literal("prompt", "cancel", "close"),
    payload: Schema.Unknown,
    createdAt: Schema.Number,
  }),

  events: Schema.Struct({
    eventKey: Schema.String.pipe(DurableTable.primaryKey),
    sessionId: Schema.String,
    sequence: Schema.Number,
    kind: Schema.Literal("accepted", "text", "closed", "failed"),
    payload: Schema.Unknown,
    createdAt: Schema.Number,
  }),
}) {}
```

For the tiny reference, the driver supplies `sequence` per session. The
reference does not allocate sequences server-side; that would reintroduce
coordination the table seam is trying to eliminate. The important property is
that the workflow's durable cursor is `sessions.nextInputSequence`.

The workflow consumes input by table state:

```ts
const nextInputForSession = (
  table: SessionTable["Type"],
  session: SessionRow,
) =>
  table.inputs.query(coll =>
    coll.toArray
      .filter(row =>
        row.sessionId === session.sessionId &&
        row.sequence === session.nextInputSequence)
      .sort((a, b) => a.sequence - b.sequence)[0])
```

After processing an input, the workflow updates the same table:

```ts
yield* table.sessions.upsert({
  ...nextSession,
  nextInputSequence: input.sequence + 1,
  revision: session.revision + 1,
  updatedAt: now,
})
```

This is the core proof: replay reconstructs progress from table state.

## Channel Binding Sketch

The prompt route writes the workflow-owned table. It does not call the
workflow, complete a deferred, or write an intent row.

```ts
const sessionPromptChannel = makeEgressChannel({
  target: SessionPromptTarget,
  schema: SessionPromptSchema,
  append: input =>
    Effect.gen(function*() {
      const table = yield* SessionTable

      yield* table.inputs.insertOrGet({
        inputKey: `${input.sessionId}/${input.sequence}`,
        sessionId: input.sessionId,
        sequence: input.sequence,
        kind: "prompt",
        payload: input.prompt,
        createdAt: input.createdAt,
      })
    }),
})
```

The event route reads the same table:

```ts
const sessionEventsChannelFor = (sessionId: string) =>
  makeIngressChannel({
    target: SessionEventsTarget,
    schema: SessionEventSchema,
    stream: Stream.unwrap(
      Effect.map(SessionTable, table =>
        table.events.rows().pipe(
          Stream.filter(event => event.sessionId === sessionId),
        ))
    ),
  })
```

If the current channel factory requires one static target per registration,
the route descriptor can adapt the `sessionId` input into a table filter. That
is router/channel plumbing, not workflow-engine routing. The multi-session
ingress factoring question is separate from the table-seam claim: the
reference should pick one route shape, record any production router gap as a
finding, and keep moving.

## Workflow Sketch

The workflow body owns transition logic and durable cursor advancement.

```ts
const SessionWorkflowLive = SessionWorkflow.toLayer(({ sessionId }) =>
  Effect.gen(function*() {
    const table = yield* SessionTable

    while (true) {
      const session = yield* readSessionOrCreate(table, sessionId)
      const input = yield* waitForNextInput(table, session)

      const transitioned = transitionSession(session, input)

      yield* table.sessions.upsert(transitioned.session)
      yield* table.events.insertOrGet(transitioned.event)
    }
  }))
```

`waitForNextInput` is workflow-local table observation. Prefer
`table.inputs.rows()` filtered to the session's `nextInputSequence`; this
matches the workflow's replay-from-table-state model and avoids introducing
polling intervals. It is not a public API and not an activity.

## Reference Layout

Use a deliberately small layout for the first simulation:

```text
packages/tiny-firegrid/src/simulations/target-architecture-reference/
  index.ts       # simulation registration
  channels.ts    # production-compatible targets and schemas, plus local aliases only when production lacks a neutral contract
  session.ts     # SessionTable, SessionWorkflow, transitionSession, cursor logic
  binding.ts     # channel registrations backed by SessionTable writes/reads
  layer.ts       # router + table + workflow composition
```

This layout is intentionally flatter than production. It is a reference for the
target dependency direction, not a package-boundary rehearsal.

Expected dependency direction:

```text
channels.ts -> production protocol contracts
session.ts  -> DurableTable + workflow primitives
binding.ts  -> channels.ts + session.ts
layer.ts    -> binding.ts + session.ts + router composition
index.ts    -> layer.ts
```

Forbidden dependency direction:

```text
session.ts -> binding.ts
session.ts -> any router module
index.ts -> SessionTable handle
```

Forbidden symbol references anywhere in the reference:

```text
appendRuntimeInputDeferred
WorkflowEngineTable.deferreds
RuntimeInputIntentDispatcherLive
RuntimeControlPlaneTable.inputIntents
```

## Validation

The first simulation should prove the PHASE_0 target-reference ACIDs:

- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.1`
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.2`
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.3`
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.4`
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.5`
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.6`
- `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.7`

Concrete checks:

1. A public driver creates or starts a session, then sends prompt/cancel/close
   through channel/router contracts.
2. The prompt channel writes `SessionTable.inputs`.
3. The workflow advances `SessionTable.sessions.nextInputSequence`.
4. Session-visible output is read from `SessionTable.events` through a channel.
5. Duplicate input identity converges through `insertOrGet`.
6. Static import checks reject `appendRuntimeInputDeferred`, production
   runtime-context workflow modules, production host-control route bodies, and
   production request/claim/completion row implementations.
7. Trace output contains `firegrid.channel.dispatch` and
   `firegrid.tiny_reference.session.transition` spans.
8. Trace output does not contain spans for input-intent dispatch,
   request-row reconciliation, or runtime input deferred append.

## Production Migration Signal

This reference is useful only as a comparison point. A production migration is
moving toward the target when it:

- makes channels the public semantic surface;
- makes workflow-owned `DurableTable` state the implementation seam;
- removes deferred names as the way ordinary workflow input is addressed;
- removes request/claim/completion table families where a state transition on
  one workflow-owned table is sufficient;
- keeps workflow transition logic inside workflow modules;
- keeps edge/router code ignorant of engine and table internals.

For `RuntimeContextWorkflowRuntime`, the migration is moving toward the target
when the active-execution map, workflow-support registry, reconcile pass, and
intent dispatcher each have a clear replacement in workflow-owned table
mechanics or have been deleted.

The reference is not saying every production deferred is wrong. Durable waits,
clocks, and Effect workflow internals may still use deferreds where the
primitive is actually a suspended wait. The reference rejects deferreds as the
ordinary mailbox for semantic workflow input.
