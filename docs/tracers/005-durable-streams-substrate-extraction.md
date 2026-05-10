# Agent D Brief: Durable Streams Substrate Extraction Stress Test

Objective: stress-test the strongest near-term package split against current
Firegrid code. This pass should be executable by an implementation agent without
having to invent the future package model.

Target architecture reference:

`docs/architecture/managed-agent-runtime-target.md`

Use the target architecture for direction, but keep this stress test grounded in
today's repository. If the target architecture asks for a package or abstraction
that current code cannot justify yet, report that as a finding instead of
building speculative scaffolding.

## Current Ground Truth

Current Durable Streams usage is concentrated in a few places:

```txt
packages/runtime/src/control-plane/workflow-engine/
  clock.ts
  codec.ts
  engine-runtime.ts
  state.ts
  workflows.ts
  workflow-engine.test.ts

packages/runtime/src/data-plane/runtime-output/
  writer.ts

packages/runtime/src/data-plane/materialization/
  runtime-output-source.ts
  sinks/state-protocol/state-protocol-writer.ts
  event-pipeline.test.ts

packages/protocol/src/
  launch/state.ts
  session/state.ts
```

Run these before changing structure:

```sh
rg '@durable-streams/' packages scenarios
rg 'createStreamDB|createStateSchema|DurableStream|IdempotentProducer' packages scenarios
```

The stress test should use those results as its worklist.

## Primary Hypothesis

Create a new package:

```txt
packages/durable-streams/
```

This package should become the only package importing `@durable-streams/*`.
Every other package should use Effect services, constructors, Layers, or helper
APIs exported by `@firegrid/durable-streams`.

This is intentionally aligned with the Effect ecosystem pattern:

- `@effect/workflow` defines the workflow abstraction;
- `@effect/cluster` provides `ClusterWorkflowEngine.layer`;
- `@firegrid/durable-streams` should provide a Durable Streams-backed workflow
  engine and related Durable Streams substrate APIs.

## Immediate Extraction Scope

Start with what current code proves.

### Workflow Engine

Move the Durable Streams-backed workflow engine out of `@firegrid/runtime`:

```txt
packages/runtime/src/control-plane/workflow-engine/engine-runtime.ts
  -> packages/durable-streams/src/DurableStreamsWorkflowEngine.ts

packages/runtime/src/control-plane/workflow-engine/workflows.ts
  -> packages/durable-streams/src/DurableStreamsWorkflowEngine.ts

packages/runtime/src/control-plane/workflow-engine/clock.ts
  -> packages/durable-streams/src/internal/workflow/clock.ts

packages/runtime/src/control-plane/workflow-engine/codec.ts
  -> packages/durable-streams/src/internal/workflow/codec.ts

packages/runtime/src/control-plane/workflow-engine/state.ts
  -> packages/durable-streams/src/internal/workflow/state.ts
```

Expected public surface:

```ts
import { DurableStreamsWorkflowEngine } from "@firegrid/durable-streams"

const WorkflowEngineLive = DurableStreamsWorkflowEngine.layer({
  streamUrl,
})
```

Keep the behavior close to the previous runtime-local workflow-engine layer
factory. Rename enough to make the substrate ownership clear. The target public
API should be `DurableStreamsWorkflowEngine.layer(...)`; do not keep a
compatibility alias.

### Durable Producer Mechanics

Current producer mechanics exist in:

```txt
packages/runtime/src/data-plane/runtime-output/writer.ts
packages/runtime/src/data-plane/materialization/sinks/state-protocol/state-protocol-writer.ts
```

Both use `IdempotentProducer`. Extract only the generic mechanics that are
actually duplicated:

```txt
packages/durable-streams/src/DurableStreamProducer.ts
```

This should cover stable producer identity, append, flush, detach, and async
error handling. Do not move runtime-output event semantics or session-state
change semantics into `@firegrid/durable-streams`.

### Retained Log Reads

Current retained reads exist in:

```txt
packages/runtime/src/data-plane/materialization/runtime-output-source.ts
```

If useful, extract a small retained-log read helper:

```txt
packages/durable-streams/src/DurableStreamLog.ts
```

This helper should hide `@durable-streams/client` from materialization/runtime
code. Keep runtime-output filtering by `contextId` outside the durable-streams
package.

### State Protocol / StreamDB Boundary

Current protocol files import `@durable-streams/state` directly:

```txt
packages/protocol/src/launch/state.ts
packages/protocol/src/session/state.ts
```

This violates the target boundary. Stress-test the smallest viable correction:

- `@firegrid/protocol` should own Effect Schemas and Firegrid descriptors.
- `@firegrid/durable-streams` should adapt those descriptors to
  `createStateSchema(...)`.

Do not over-design this. The output may be a concrete refactor or a written
finding that the descriptor boundary needs a separate follow-up.

## Do Not Build Yet

Do not create these unless current code forces them:

```txt
DurableClaim.ts
DurableStreamsTestServer.ts
packages/runtimes/*
packages/sandboxes/*
packages/workspaces/*
packages/tools/*
packages/secrets/*
```

Those are target-architecture directions, not required for this extraction
stress test. The only exception is if moving current files requires a tiny
placeholder package for typecheck; if so, keep it minimal and document why.

## Runtime Package After Extraction

`@firegrid/runtime` should continue to own Firegrid domain semantics:

- runtime context workflow definition;
- runtime context state meaning;
- runtime output journal event meaning;
- runtime-output source filtering;
- materialization/projector domain logic;
- local process sandbox provider until a later launch-slot package split.

After the workflow-engine extraction, runtime should depend on
`@firegrid/durable-streams` for substrate services rather than importing
`@durable-streams/*`.

## Composition Root To Prove

Show at least one real composed root using the extracted package. Prefer a
scenario or smoke entry point that already exists.

The shape should be close to:

```ts
import { DurableStreamsWorkflowEngine } from "@firegrid/durable-streams"
import { RuntimeContext } from "@firegrid/runtime"

const Live = Layer.mergeAll(
  DurableStreamsWorkflowEngine.layer({ streamUrl: workflowStreamUrl }),
  RuntimeContext.layer({ /* current runtime-context config */ }),
  // current runtime output / sandbox / materialization layers
)

yield* RuntimeContext.run({ contextId }).pipe(Effect.provide(Live))
```

Do not invent a full `RuntimeHost` abstraction for this stress test. The target
architecture may later introduce a cleaner host root, but this pass should
prove whether the substrate package extraction improves the current roots.

## Call Sites To Validate

Rewrite or adjust the real current call sites that break after the extraction:

1. `packages/runtime/src/control-plane/runtime-context/workflow.ts`
2. `packages/runtime/src/control-plane/runtime-context/launcher.ts`
3. `scenarios/firegrid/src/tracer-001.test.ts`
4. `scenarios/firegrid/src/tracer-002.test.ts`
5. workflow-engine tests after they move to `packages/durable-streams`

Do not rewrite hypothetical launch-slot packages in this pass.

## Boundary Rule To Enforce

After the extraction, this should be true or explicitly listed as a remaining
gap:

```txt
packages/durable-streams/** -> may import @durable-streams/*
all other packages/**       -> must not import @durable-streams/*
scenarios/**                -> must not import @durable-streams/*
```

If tests need a Durable Streams server, expose it through an internal test
helper in `@firegrid/durable-streams` or document why this should be deferred.
Do not make `DurableStreamsTestServer` public just to satisfy a test.

## Materialization Boundary

This stress test should not implement the full target materialization package
split. It should only prevent new direct Durable Streams imports from leaking
into materialization code.

The target architecture says materialization will eventually be one package
with subpath strategies:

```txt
@firegrid/materialization
@firegrid/materialization/state-protocol
@firegrid/materialization/raw-fold
@firegrid/materialization/materialize
```

For this pass, report whether the current materialization code becomes simpler
or harder when it consumes `@firegrid/durable-streams` helpers.

## Acceptance Criteria

- `@firegrid/durable-streams` exists as a package.
- Current workflow-engine implementation is extracted from
  `@firegrid/runtime` into `@firegrid/durable-streams`.
- Runtime workflow definitions still use `@effect/workflow` normally and
  receive the Durable Streams workflow engine through a Layer.
- Direct `@durable-streams/*` imports outside `packages/durable-streams` are
  eliminated or listed as explicit remaining gaps.
- Existing tracer 001 and tracer 002 scenarios still pass or have precise
  failure notes.
- No speculative launch-slot packages are introduced.
- The PR or report explains whether `DurableStreamProducer`,
  `DurableStreamLog`, `DurableState`, and `DurableStateProtocol` earned public
  surfaces or should remain internal helpers for now.

## Output

Add results to:

`docs/tracers/005-results.md`

Include:

- files moved;
- imports eliminated;
- package dependency changes;
- composed root before/after;
- remaining direct Durable Streams imports, if any;
- whether the extraction made the current architecture clearer;
- what target-architecture assumptions should be revised based on the stress
  test.
