# ADR: Runtime Control Plane And Data Plane Boundary

Date: 2026-05-08

## Status

Accepted for the durable agent tracer work.

## Decision

Firegrid runtime execution must separate runtime control-plane state from
agent data-plane journals. These concerns use different substrates, live in
different modules, and are wired into workflows as separate services.

```txt
Control plane = state-shaped runtime coordination.
Data plane = append-only agent/runtime output journal.
```

## Why

The prior implementations kept drifting because `launch`, `runtime context`,
`run lifecycle`, stdout/stderr capture, snapshot reads, and future session
materialization were all placed behind one service or one stream. That blurred
two access patterns:

- Control-plane code asks state questions: "does context X exist?", "what runs
  exist for context X?", "did the run exit?"
- Data-plane code appends and replays facts: "line N appeared on stdout",
  "stderr emitted this text", "a provider frame arrived".

Trying to force one substrate over both patterns creates recurring confusion:

- putting unbounded output into State Protocol collections;
- scanning a raw journal to answer control-plane lookup questions;
- naming one service as both store, journal, writer, and reader;
- making tracer 002 materializers consume producer-side State Protocol shapes
  instead of runtime output facts.

## Boundary

### Runtime Control Plane

Purpose:

- coordinate runtime execution;
- hold small, queryable runtime facts;
- support workflow reads/writes by id.

Substrate:

- Durable Streams State / StreamDB.

State families:

- `contexts`: one runtime context per `contextId`;
- `runs`: bounded run lifecycle rows per context and attempt.

Expected service/module shape:

```txt
packages/runtime/src/control-plane/runtime-context/
  service.ts RuntimeControlPlane
packages/protocol/src/launch/state.ts
  runtimeContextStateSchema for contexts+runs
```

Example service:

```ts
class RuntimeControlPlane extends Context.Tag("firegrid/runtime/RuntimeControlPlane")<
  RuntimeControlPlane,
  {
    readonly appendContext: (context: RuntimeContext) => Effect<void, RuntimeControlPlaneError>
    readonly appendRunStarted: (params: RunParams) => Effect<void, RuntimeContextError>
    readonly appendRunExited: (params: RunExitedParams) => Effect<void, RuntimeContextError>
    readonly appendRunFailed: (params: RunFailedParams) => Effect<void, RuntimeContextError>
    readonly getContext: (contextId: string) => Option<RuntimeContext>
    readonly runsFor: (contextId: string) => ReadonlyArray<RuntimeRunEvent>
  }
>() {}
```

Allowed:

- `createStreamDB(...)`;
- `createStateSchema(...)`;
- State Protocol `upsert` rows;
- snapshot reads over bounded control-plane state.

Not allowed:

- provider message parsing;
- stdout/stderr data-plane payloads;
- session messages;
- permission materialization;
- unbounded provider event history.

### Runtime Data Plane / Capture Journal

Purpose:

- preserve ordered runtime output facts;
- keep provider output opaque until downstream materializers interpret it;
- feed tracer 002 session materialization and tracer 003 permission workflows.

Substrate:

- raw Durable Streams append/read/tail;
- `IdempotentProducer` for high-volume append paths.

Journal facts:

- stdout line/frame emitted;
- stderr line emitted;
- possibly future stdin/input facts if the runtime needs durable input delivery.

Expected service/module shape:

```txt
packages/runtime/src/data-plane/runtime-output/
  writer.ts RuntimeCaptureJournal
packages/protocol/src/launch/schema.ts
  RuntimeJournalEventSchema for stdout/stderr facts
packages/runtime/src/data-plane/execution/
  sandbox/ live SandboxProvider implementations
```

Example service:

```ts
class RuntimeCaptureJournal extends Context.Tag("firegrid/runtime/RuntimeCaptureJournal")<
  RuntimeCaptureJournal,
  {
    readonly openAttempt: (params: {
      readonly contextId: string
      readonly activityAttempt: number
    }) => Effect<
      {
        readonly write: (event: RuntimeCaptureEvent) => Effect<void, RuntimeContextError>
        readonly flush: Effect<void, RuntimeContextError>
      },
      never,
      Scope
    >
  }
>() {}
```

Allowed:

- `DurableStream`;
- `IdempotentProducer`;
- tagged journal event schemas;
- retained stream reads for tracer 001 snapshots;
- downstream materializers that project into State Protocol streams.

Not allowed:

- `createStateSchema(...).events.upsert(...)`;
- `createStreamDB` actions for runtime output facts;
- workflow control-plane lookup state;
- materialized session rows.

## Workflow Wiring

The runtime workflow consumes both services:

```txt
RuntimeContextWorkflow
  -> RuntimeControlPlane.getContext(contextId)
  -> RuntimeControlPlane.appendRunStarted(...)
  -> SandboxProvider.stream(...)
  -> RuntimeCaptureJournal.openAttempt(...).write(stdout/stderr)
  -> RuntimeCaptureJournal.flush
  -> RuntimeControlPlane.appendRunExited(...) or appendRunFailed(...)
```

The workflow should not provide one umbrella `RuntimeJournal` or
`RuntimeContextStore` service that owns both control and data concerns.

## Repo Organization

Use physical module boundaries to make mixing harder:

```txt
packages/runtime/src/control-plane/
  runtime-context/
    service.ts
    workflow.ts
    launcher.ts
  workflow-engine/
    workflows.ts
    state.ts
packages/runtime/src/data-plane/
  runtime-output/
    writer.ts
  execution/
    sandbox/
```

Protocol schemas should mirror the distinction:

```txt
packages/protocol/src/launch/
  control-plane.ts or state.ts  # contexts/runs State Protocol schema
  data-plane.ts                 # stdout/stderr journal event schemas
```

`execution` belongs under `data-plane` because process/sandbox work is live
data-plane work. The control plane may orchestrate it through workflows, but it
must not own process handles, stdio pipes, or sandbox-provider internals.

## Tracer Implications

Tracer 001:

```txt
client.launch(...)
  -> control-plane context row
  -> runtime workflow
  -> control-plane run rows
  -> data-plane stdout/stderr journal events
  -> retained snapshot reads both planes
```

Tracer 002:

```txt
data-plane stdout/provider events
  -> session materializer
  -> session State Protocol stream
```

Tracer 003:

```txt
data-plane provider events
  -> permission workflow/materializer
  -> durable permission wait / resolution state
```

## Affected Current Files

Current branch files that need realignment:

- `packages/runtime/src/control-plane/runtime-context/service.ts`
  - owns StreamDB-backed runtime context and run rows only.
- `packages/runtime/src/control-plane/runtime-context/workflow.ts`
  - depends on `RuntimeControlPlane`, `RuntimeCaptureJournal`, and
    `SandboxProvider` separately.
- `packages/runtime/src/control-plane/runtime-context/launcher.ts`
  - provides control-plane, data-plane, and workflow-engine layers explicitly.
- `packages/runtime/src/data-plane/runtime-output/writer.ts`
  - owns raw stdout/stderr durable stream journal writes only.
- `packages/runtime/src/data-plane/execution/sandbox/*`
  - owns live sandbox/process execution providers.
- `packages/client/src/firegrid.ts`
  - should append launch intent to the control plane and read snapshots from
    control plane plus data plane, without pretending one substrate owns both.
- `packages/protocol/src/launch/state.ts`
  - should only describe control-plane State Protocol collections.
- `packages/protocol/src/launch/schema.ts`
  - should separate control-plane row schemas from data-plane journal schemas
    even if they remain re-exported from the package root for now.
- `docs/tracers/001-black-box-agent-output-to-durable-state.md`
  - should describe the two-plane tracer 001 path.
- `docs/tracers/002-runtime-events-to-session-state.md`
  - should consume data-plane journal facts, not control-plane state.

## Review Guardrails

1. A module named `control-plane` may import `@durable-streams/state`; it should
   not own provider payload history.
2. A module named `data-plane` may import `DurableStream` /
   `IdempotentProducer`; it should not expose `getContext` or `runsFor`.
3. `workflow.ts` should make both dependencies visible in its environment.
4. Tracer 001 snapshot code may read from both planes, but should not collapse
   them into one writer abstraction.
5. Tracer 002 materializers start from data-plane facts and produce State
   Protocol session state.
