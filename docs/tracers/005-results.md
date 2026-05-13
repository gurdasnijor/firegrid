# Runtime Package Layout Pressure Test

Date: 2026-05-09

Branch: `firegrid/tracer-005-durable-streams-substrate`

Scope: tracer 005 Durable Streams substrate extraction from the current tracer
planning baseline on `main`.

## Summary

Tracer 005 supports the package split: the current Durable Streams workflow
engine can move out of `@firegrid/runtime` into a new
`@firegrid/durable-streams` package without introducing a `RuntimeHost`,
launch-slot packages, public claims, or a public Durable Streams test server.

The extraction made the current architecture clearer. Runtime now owns runtime
context, sandbox execution, runtime output, and materialization semantics, while
`@firegrid/durable-streams` owns the concrete Durable Streams substrate calls.

Relevant ACIDs:

- `workflow-engine-durable-state.ENGINE.1`
- `workflow-engine-durable-state.ENGINE.4`
- `workflow-engine-durable-state.VALIDATION.1`
- `workflow-engine-durable-state.VALIDATION.2`
- `workflow-engine-durable-state.VALIDATION.3`
- `workflow-engine-durable-state.VALIDATION.4`
- `workflow-engine-durable-state.VALIDATION.5`
- `workflow-engine-durable-state.VALIDATION.6`
- `firegrid-architecture-boundary.DEPENDENCY_GRAPH.1`
- `firegrid-architecture-boundary.DEPENDENCY_GRAPH.2`
- `firegrid-architecture-boundary.DEPENDENCY_GRAPH.3`
- `firegrid-architecture-boundary.AUTHORITY.4`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.9`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.10`
- `firegrid-event-pipeline-materialization.BOUNDARY.3`

## Files Moved

Moved from `packages/runtime/src/control-plane/workflow-engine/`:

- `clock.ts`
- `codec.ts`
- `engine-runtime.ts`
- `state.ts`
- `workflow-engine.test.ts`

Moved into `packages/durable-streams/src/`:

- `DurableStreamsWorkflowEngine.ts`
- `DurableStreamsWorkflowEngine.test.ts`
- `internal/workflow/clock.ts`
- `internal/workflow/codec.ts`
- `internal/workflow/engine-runtime.ts`
- `internal/workflow/state.ts`

No runtime workflow-engine compatibility shim remains. Runtime's production
launcher imports `DurableStreamsWorkflowEngine` from
`@firegrid/durable-streams` directly.

## New Package

Added `packages/durable-streams` as `@firegrid/durable-streams`.

Current public surfaces:

- `DurableStreamsWorkflowEngine.make`
- `DurableStreamsWorkflowEngine.layer`
- `fireDueWorkflowClocks`
- workflow state store types and error types
- `openDurableStreamProducer`
- `appendJson`
- `createJsonDurableStream`
- `readRetainedJson`
- `createDurableStateDb`
- `runtimeContextStateSchema`
- `sessionStateSchema`

Test-only surface:

- `@firegrid/durable-streams/test-utils`
  - historical Firegrid-owned Durable Streams test-server helper
  - `DurableStreamsTestServerHandle`

This does not expose `DurableStreamTestServer` directly. It gives package and
scenario tests a narrow helper so they do not import `@durable-streams/server`.

## Imports Eliminated

Direct `@durable-streams/*` imports were removed from:

- `packages/client/src/firegrid.ts`
- `packages/client/src/firegrid.test.ts`
- `packages/protocol/src/launch/state.ts`
- `packages/protocol/src/session/state.ts`
- `packages/runtime/src/control-plane/runtime-context/service.ts`
- `packages/runtime/src/control-plane/runtime-context/launcher.test.ts`
- `packages/runtime/src/data-plane/runtime-output/writer.ts`
- `packages/runtime/src/data-plane/materialization/runtime-output-source.ts`
- `packages/runtime/src/data-plane/materialization/event-pipeline.test.ts`
- `packages/runtime/src/data-plane/materialization/sinks/state-protocol/state-protocol-writer.ts`
- `scenarios/firegrid/src/tracer-001.test.ts`
- `scenarios/firegrid/src/tracer-002.test.ts`

Current boundary scan:

```txt
packages/durable-streams/** -> imports @durable-streams/*
packages/client/**          -> no direct @durable-streams/* imports
packages/protocol/**        -> no direct @durable-streams/* imports
packages/runtime/**         -> no direct @durable-streams/* imports
scenarios/**                -> no direct @durable-streams/* imports
apps/flamecast/**           -> still has legacy direct @durable-streams/* imports
```

Remaining direct Durable Streams imports outside `packages/durable-streams` are
limited to the pre-existing Flamecast app storage/runtime files listed in
Remaining Gaps. They were not migrated in tracer 005 because this pass is
scoped to Firegrid packages, scenarios, and the runtime workflow-engine
extraction.

## Package Dependency Changes

Added:

- `@firegrid/durable-streams`

Moved direct Durable Streams npm dependencies from client/runtime/scenario and
protocol into `@firegrid/durable-streams`.

Updated consumers:

- `@firegrid/client` now depends on `@firegrid/durable-streams` for retained log
  reads and Runtime Context StreamDB state schema construction.
- `@firegrid/runtime` now depends on `@firegrid/durable-streams` for workflow
  engine, runtime control-plane StreamDB construction, runtime-output producer
  mechanics, retained runtime-output reads, and State Protocol sink writing.
- `@firegrid/scenario-firegrid` now depends on `@firegrid/durable-streams` for
  stream test setup and session State Protocol verification.
- `@firegrid/protocol` no longer depends on Durable Streams. It exports
  Firegrid-owned state descriptors, not concrete StreamDB schemas.

## Composed Root Before And After

Before:

```ts
import { RuntimeWorkflowEngine } from "../workflow-engine/workflows.ts"

const Live = RuntimeContextWorkflowLayer.pipe(
  Layer.provideMerge(RuntimeWorkflowEngine.layer({
    streamUrl: workflowStreamUrl,
  })),
  Layer.provide(RuntimeControlPlaneLive({ streamUrl: controlPlaneStreamUrl })),
  Layer.provide(RuntimeCaptureJournalLive({ streamUrl: dataPlaneStreamUrl })),
)
```

After:

```ts
import { DurableStreamsWorkflowEngine } from "@firegrid/durable-streams"

const Live = RuntimeContextWorkflowLayer.pipe(
  Layer.provideMerge(DurableStreamsWorkflowEngine.layer({
    streamUrl: workflowStreamUrl,
  })),
  Layer.provide(RuntimeControlPlaneLive({ streamUrl: controlPlaneStreamUrl })),
  Layer.provide(RuntimeCaptureJournalLive({ streamUrl: dataPlaneStreamUrl })),
)
```

Runtime workflow definitions still use `@effect/workflow` normally. The Durable
Streams-backed workflow engine is provided through a Layer.

## Surface Decisions

### `DurableStreamsWorkflowEngine`

Earned a public surface now. Current runtime and tests already need a
ClusterWorkflowEngine-shaped `make` and `layer`.

### `DurableStreamProducer`

Earned a public substrate helper now. Current runtime-output journal writing
and State Protocol projection writing both had duplicated
`IdempotentProducer` setup, producer identity, flush, detach, and async error
drain mechanics. The helper keeps runtime-output and session-state semantics
outside `@firegrid/durable-streams`.

### `DurableStreamLog`

Earned a small public helper now. Client snapshots, runtime-output
materialization, and tracer scenarios need retained raw JSON reads and test
stream creation without importing `@durable-streams/client` directly.

### `DurableState`

Earned a minimal helper now, but not a full abstraction. `createDurableStateDb`
is intentionally a thin StreamDB constructor boundary, and
`runtimeContextStateSchema` / `sessionStateSchema` adapt protocol descriptors
to `createStateSchema(...)`.

A richer `DurableState` service can wait until a second state backend or a
stronger lifecycle abstraction appears.

### `DurableStateProtocol`

Did not earn a separate public surface yet. The only concrete need is the
session State Protocol sink, and its event semantics remain Firegrid
materialization semantics. The durable-streams package currently provides the
state schemas; the writer stays in runtime materialization code.

## Materialization Boundary Result

Materialization became slightly clearer. `runtime-output-source.ts` now calls
`readRetainedJson` and remains responsible for:

- decoding `RuntimeJournalEventSchema`;
- filtering by `contextId`;
- applying runtime output cursor order;
- isolating decode failures.

`StateProtocolWriterLive` now uses `openDurableStreamProducer` but still owns
session projection changes and deterministic writer ids. Materialization did
not absorb Durable Streams substrate mechanics, and
`@firegrid/durable-streams` did not learn session semantics.

## Target Architecture Revisions

The target architecture should keep the durable-streams package boundary, but
revise the public surface timing:

1. `DurableStreamsWorkflowEngine`, `DurableStreamProducer`, and
   `DurableStreamLog` are justified now.
2. `DurableState` is justified only as a thin helper/state-schema adapter for
   current StreamDB call sites.
3. `DurableStateProtocol` should remain deferred until another State Protocol
   writer or reader needs a common abstraction.
4. `DurableStreamsTestServer` should not be public. A test-only helper subpath
   is sufficient for current tests.
5. No public `DurableClaim` is justified by this extraction. Workflow activity
   claim rows remain internal workflow-engine state.
6. No launch-slot packages are justified by this extraction.

## Validation

Validated locally:

```sh
pnpm --filter @firegrid/durable-streams run typecheck
pnpm --filter @firegrid/protocol run typecheck
pnpm --filter @firegrid/client run typecheck
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/durable-streams run test
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid test -- tracer-001.test.ts tracer-002.test.ts
```

`pnpm install` completed with existing workspace bin-link warnings for the
unbuilt `@firegrid/runtime` CLI binary.

## Remaining Gaps

Pre-existing Flamecast app files still import `@durable-streams/*` directly:

- `apps/flamecast/src/shared/db.ts`
- `apps/flamecast/src/shared/state.ts`
- `apps/flamecast/src/runtime/main.ts`
- `apps/flamecast/src/runtime/agent-webhooks.test.mts`

`apps/flamecast/package.json` also still declares direct Durable Streams
dependencies. These are outside the tracer 005 runtime package extraction scope
and should be handled by a separate Flamecast storage-boundary pass if the
target boundary is extended from Firegrid packages/scenarios to all apps.

The remaining intentional thinness is `createDurableStateDb`, which still
returns a StreamDB-shaped object. That is acceptable for tracer 005 because the
current call sites already use StreamDB collections/actions directly and no
second state backend exists yet.
