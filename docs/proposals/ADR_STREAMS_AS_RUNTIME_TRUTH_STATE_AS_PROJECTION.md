# ADR: Durable Streams As Runtime Truth, Durable State As Projection

Date: 2026-05-08

## Status

Accepted for the durable agent tracer work.

Refined by
`docs/proposals/ADR_RUNTIME_CONTROL_PLANE_AND_DATA_PLANE_BOUNDARY.md`: runtime
context and run rows are control-plane state, while stdout/stderr/provider
output remains raw data-plane journal data.

## Decision

Firegrid runtime output facts are written first as raw Durable Streams journal
events. Durable State / StreamDB is used for control-plane runtime context/run
state and for downstream projection outputs, not as the producer-side write
format for stdout/stderr/provider output observed at live runtime boundaries.

Short rule:

```txt
Live data-plane producers append output facts to Durable Streams.
Control-plane producers and projectors/materializers write Durable State.
```

## Why This Matters

Firegrid's runtime model depends on one invariant:

```txt
The durable log is the source of truth.
All application-observable state must be derivable from durable records.
```

Using `createStateSchema(...).collection.upsert(...)` inside live runtime
producers weakens that boundary. It makes the producer emit State Protocol
change messages instead of primitive facts, which forces every downstream
consumer to treat the runtime journal as a pre-materialized StreamDB collection.

That is backwards for the runtime agent substrate. Runtime stdout/stderr,
process lifecycle, launched context, permission requests, and future input
delivery are facts. Session messages, permission queues, run summaries, and UI
snapshots are projections.

## Boundaries

### Raw Durable Streams Journals

Use raw Durable Streams append / `IdempotentProducer` for data-plane facts or
commands:

- runtime stdout line emitted
- runtime stderr line emitted
- future session input appended
- future permission requested / resolved facts

Events should be schema-validated envelopes, for example:

```ts
type RuntimeJournalEvent =
  | {
      type: "firegrid.runtime.output.stdout"
      id: string
      contextId: string
      activityAttempt: number
      sequence: number
      at: string
      payload: { format: "jsonl"; raw: string }
    }
  | {
      type: "firegrid.runtime.output.stderr"
      id: string
      contextId: string
      activityAttempt: number
      sequence: number
      at: string
      payload: { format: "text-lines"; raw: string }
    }
```

These journal events are the replay authority. They should not be wrapped in
State Protocol `insert` / `upsert` / `delete` messages at the live producer
boundary.

### Durable State / StreamDB

Use Durable State / StreamDB for derived state:

- runtime context control-plane rows
- runtime run control-plane rows
- session-shaped message collections
- runtime context snapshot views
- permission queue views
- run summary views
- browser-friendly live projections
- tests that verify projection output materializes correctly

The writer at this boundary is a projector/materializer:

```txt
raw runtime journal
  -> materializer
  -> State Protocol changes
  -> StreamDB client view
```

## Current Affected Areas

The current tracer branch has code that should be realigned with this decision.

### Runtime Output Writer

Current file:

- `packages/runtime/src/data-plane/runtime-output/writer.ts`

Current issue:

- It converts runtime output rows into `runtimeContextStateSchema.events.upsert`
  and `runtimeContextStateSchema.logs.upsert` messages.
- That makes process output a State Protocol collection write instead of a raw
  runtime journal fact.

Target:

- Rename/reshape this as a runtime journal writer.
- Append schema-validated runtime journal event envelopes through
  `IdempotentProducer`.
- Do not call `runtimeContextStateSchema.events.upsert(...)` or
  `runtimeContextStateSchema.logs.upsert(...)` from workflow activities.

### Runtime Context State Schema

Current file:

- `packages/protocol/src/launch/state.ts`

Target:

- Runtime event/log payload schemas may remain in protocol.
- Event/log journal facts should not be modeled as `runtimeContextStateSchema`
  collections for tracer 001.
- If a runtime snapshot view is needed, build it as a later projection from the
  raw runtime journal.

### Firegrid Client Snapshot

Current file:

- `packages/client/src/firegrid.ts`

Current issue:

- Snapshot reads use StreamDB collections for runtime events/logs.

Target:

- For tracer 001, snapshot can be a thin retained journal reader.
- For later richer UI observation, snapshot can read a derived State Protocol
  stream produced by a runtime-context projector.
- The client should not require raw State Protocol event/log collections to be
  written by the live runtime workflow.

### Runtime Workflow

Current file:

- `packages/runtime/src/control-plane/runtime-context/workflow.ts`

Current issue:

- The workflow calls a writer that emits State Protocol changes for output.

Target:

- Workflow activities append raw runtime journal facts.
- The workflow remains responsible for flushing runtime output facts before
  appending terminal run facts.
- Provider payloads remain opaque at this boundary.

### Tracer Docs

Current files:

- `docs/tracers/001-black-box-agent-output-to-durable-state.md`
- `docs/tracers/002-runtime-events-to-session-state.md`
- `docs/tracers/003-runtime-events-to-permission-workflow.md`

Target:

- Tracer 001 stops at raw runtime journal facts.
- Tracer 002 introduces the first materializer from raw runtime journal facts
  into session-shaped Durable State.
- Tracer 003 consumes the same raw journal facts for permission workflow
  behavior.

## Guardrails

Use these review checks for runtime/tracer work:

1. If the code is at a live boundary, it should not call
   `createStateSchema(...).upsert(...)` for the fact it just observed.
2. If the code writes State Protocol changes, it should be named and scoped as a
   projector, materializer, or derived-view producer.
3. Runtime process output should be append-only journal events, not StreamDB
   collections.
4. StreamDB clients are valid for derived views, not for establishing runtime
   execution truth.
5. Tests may use StreamDB to verify projection outputs, but tracer 001 tests
   should prove retained raw journal facts exist after process exit.

## Relationship To Existing Specs

This decision refines the tracer direction without changing the broader
durable-records principle:

- `features/firegrid/durable-records-and-projections.feature.yaml`
  distinguishes durable records from projections.
- `docs/tracers/README.md` defines the tracer sequence: tracer 001 produces
  runtime facts, tracer 002 materializes session state, tracer 003 handles
  permission workflows.

The key clarification is that Durable State is not the default persistence
format for every row written to Durable Streams. It is the projection protocol
used when the desired output is a materialized state view.
