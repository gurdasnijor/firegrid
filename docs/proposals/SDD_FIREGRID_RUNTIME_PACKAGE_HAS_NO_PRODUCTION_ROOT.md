# SDD: Firegrid Runtime Package Has No Production Root

Date: 2026-05-09

Status: proposed architecture

Spec anchors:

- `firegrid-platform-invariants.PRODUCTION_SURFACE.1`
- `firegrid-platform-invariants.PRODUCTION_SURFACE.2`
- `firegrid-platform-invariants.PRODUCTION_SURFACE.3`
- `firegrid-platform-invariants.PRODUCTION_SURFACE.4`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.9`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.10`
- `firegrid-durable-launch-runtime-operator.INVARIANTS.1`
- `firegrid-event-pipeline-materialization.PIPELINE.1`
- `firegrid-event-pipeline-materialization.PIPELINE.5`
- `firegrid-event-pipeline-materialization.BOUNDARY.1`
- `firegrid-event-pipeline-materialization.BOUNDARY.3`

## Problem

The runtime package has accumulated architecture-shaped directories and
composition-shaped helpers while the actual model is simpler:

```txt
runtime modules define services, Layers, and programs
applications compose those services at their entrypoints
```

The previous "single composition root" direction tried to fix hidden scenario
wiring by adding a `composition/` directory. That is the wrong abstraction.
Composition is an Effect operation performed at the edge of an application; it
is not a Firegrid runtime domain.

The same issue shows up in the top-level `control-plane/` and `data-plane/`
directories. The distinction is real at runtime: some streams are coordination
state, some streams are durable journals, and some outputs are derived
projections. But forcing every source file to choose a plane at directory
creation time turns a runtime property into a code-organization tax.

Examples:

- `workflow-engine` is infrastructure used by runtime coordination; it is not
  owned by the runtime-context control plane.
- `materialization` consumes runtime journals and writes projections; calling it
  "data-plane" is true in one sense but does not clarify its module boundary.
- `RuntimeCaptureJournal` writes durable output facts and is invoked by runtime
  execution; directory placement alone cannot express that relationship.

The recurring failure mode is not "we lack a composition folder." It is
"runtime package modules keep importing concrete Layers and acting like
applications."

## Decision

`@firegrid/runtime` should not contain a production root.

The runtime package exposes:

- service Tags;
- implementation Layers;
- small programs that depend on Tags;
- protocol-adjacent runtime helpers;
- public extension points.

Applications compose those pieces at their own entrypoints:

- `apps/*/main.ts`
- runtime binaries such as `packages/runtime/bin/*`
- scenario tests, which are application-like proof harnesses
- downstream product runtimes such as Flamecast

This means there is no `composition/` directory and no `RuntimeHost` service in
the runtime package. A composed Layer graph is an application artifact.

## Source Layout

Organize runtime package source by bounded context:

```txt
packages/runtime/src/
  runtime-context/
    command.ts
    errors.ts
    ids.ts
    schema.ts
    service.ts
    workflow.ts
    start-runtime.ts

  workflow-engine/
    clock.ts
    codec.ts
    engine-runtime.ts
    state.ts
    workflows.ts

  execution/
    sandbox/
      sandbox.ts
      providers/
        local-process.ts

  runtime-output/
    writer.ts

  materialization/
    event-pipeline.ts
    runtime-output-source.ts
    projectors/
    sinks/
    materialize/
    session-pipeline.ts
    materialize-pipeline.ts

  config.ts
  index.ts
```

This removes `control-plane/` and `data-plane/` as physical source roots.
Control-plane/data-plane remain architectural terms for diagrams, stream
roles, and specs, not the primary file-placement mechanism.

## Effect Boundary Rule

Runtime modules may depend on another module's Tag or program contract. They
must not import another module's concrete `Live` Layer unless they are in an
application entrypoint or test.

Allowed inside package source:

```ts
const program = Effect.gen(function* () {
  const journal = yield* RuntimeCaptureJournal
  const sandbox = yield* SandboxProvider
  // ...
})
```

Not allowed inside package source:

```ts
RuntimeContextWorkflowLayer.pipe(
  Layer.provide(RuntimeControlPlaneLive(...)),
  Layer.provide(RuntimeCaptureJournalLive(...)),
  Layer.provide(LocalProcessSandboxProviderLive),
)
```

That second shape is application wiring. It belongs at an entrypoint.

## Programs

A program is a useful Effect value that depends on Tags.

For example, runtime execution should be:

```ts
export const startRuntime = Effect.fn("startRuntime")(
  function* (input: { readonly contextId: string }) {
    return yield* RuntimeContextWorkflow.execute({
      contextId: input.contextId,
    })
  },
)
```

`startRuntime` depends on whatever `RuntimeContextWorkflow.execute(...)`
requires: runtime context state, workflow engine state, runtime output journal,
sandbox provider, command executor, clock, and so on. It does not provide those
requirements itself.

Session projection should remain a materialization program:

```ts
export const runSessionProjection = Effect.fn("runSessionProjection")(
  function* (input: SessionProjectionInput) {
    const pipeline = yield* EventPipeline
    return yield* pipeline.run
  },
)
```

Concrete source/projector/sink Layers are supplied by the caller. The program
does not become a runtime host method.

## Layers

Each bounded-context module owns its own `Live` Layer.

Examples:

- `RuntimeControlPlaneLive`
- `WorkflowStateStoreLive`
- `RuntimeCaptureJournalLive`
- `LocalProcessSandboxProviderLive`
- `RuntimeOutputEventSourceLive`
- `RuntimeOutputSessionProjectorLive`
- `StateProtocolEventSinkLive`
- `StateProtocolWriterLive`
- `MaterializeProviderPgLive`
- `MaterializeEventSinkLive`

Layers are public building blocks. They are not automatically composed inside
the runtime package.

## Application Composition

Applications assemble the final graph.

Example scenario/application wiring:

```ts
const RuntimeConfigLive = Layer.succeed(FiregridRuntimeConfig, {
  workflowStreamUrl,
  runtimeContextStreamUrl,
  runtimeOutputStreamUrl,
  sessionStateStreamUrl,
  workerId: "scenario-worker",
})

const RuntimeExecutionLayer = Layer.mergeAll(
  RuntimeConfigLive,
  RuntimeControlPlaneLive({ streamUrl: runtimeContextStreamUrl }),
  WorkflowStateStoreLive({ streamUrl: workflowStreamUrl }),
  RuntimeCaptureJournalLive({ streamUrl: runtimeOutputStreamUrl }),
  LocalProcessSandboxProviderLive,
)

const SessionProjectionLayer = Layer.mergeAll(
  RuntimeOutputEventSourceLive({
    streamUrl: runtimeOutputStreamUrl,
    contextId,
  }),
  RuntimeOutputSessionProjectorLive,
  StateProtocolEventSinkLive({
    streamUrl: sessionStateStreamUrl,
    contextId,
  }),
  StateProtocolWriterLive,
)

const program = Effect.gen(function* () {
  const run = yield* startRuntime({ contextId })
  const session = yield* runSessionProjection({ contextId })
  return { run, session }
}).pipe(
  Effect.provide(Layer.mergeAll(RuntimeExecutionLayer, SessionProjectionLayer)),
)
```

This is not a hidden test-only root if it lives at an application or scenario
entrypoint. Scenarios are application-like proof harnesses. They may compose
Layers, but they should use runtime package programs and services rather than
reimplementing package behavior.

## Materialization

Materialization remains:

```txt
EventSource -> EventProjector -> EventSink -> EventPipeline
```

The plugin point is `EventSink`, paired with `EventProjector` and `EventSource`
Tags. Materialize is a provider and sink implementation, not the common
materialization abstraction.

State Protocol:

```ts
Layer.mergeAll(
  RuntimeOutputEventSourceLive(...),
  RuntimeOutputSessionProjectorLive,
  StateProtocolEventSinkLive(...),
  StateProtocolWriterLive,
)
```

Materialize:

```ts
Layer.mergeAll(
  RawRuntimeJournalEventSourceLive(...),
  IdentityEventProjectorLive({
    name: "runtime-output-materialize",
    version: "1",
  }),
  MaterializeEventSinkLive({ target }),
  MaterializeProviderPgLive(pgConfig),
)
```

Custom sink:

```ts
const CustomSinkLive = Layer.succeed(
  EventSink,
  EventSink.of({
    writeAll: events => customWarehouse.write(events),
    flush: Effect.void,
  }),
)
```

## Public Exports

`packages/runtime/src/index.ts` should expose curated bounded-context surfaces,
not implementation internals or application wiring:

```ts
export * from "./runtime-context/index.ts"
export * from "./workflow-engine/index.ts"
export * from "./execution/sandbox/index.ts"
export * from "./runtime-output/index.ts"
export * from "./materialization/index.ts"
export * from "./config.ts"
```

Avoid root exports that make infrastructure look like app-facing API:

```ts
export * as Workflows from "./workflow-engine/workflows.ts"
```

If workflow-engine internals need to be public for extension or tests, expose
them through an explicit subpath or context-specific index with a narrow name.

## Dependency Enforcement

Replace directory-plane rules with bounded-context and Layer rules:

- `runtime-context/*` may import workflow-engine Tags/program contracts, runtime
  output Tags, execution Tags, and protocol types, but not their concrete
  `Live` Layers.
- `materialization/*` may import runtime-output schemas/types and sink/provider
  implementations, but not runtime-context workflow modules.
- `workflow-engine/*` is substrate infrastructure and does not import
  runtime-context, runtime-output, execution, or materialization modules.
- `execution/*` does not import runtime-context, workflow-engine, or
  materialization modules.
- No package-source module imports a peer module's concrete `Live` Layer unless
  it is explicitly marked as a test fixture or app entrypoint.

## Restructuring Plan

1. Replace physical `control-plane/` and `data-plane/` source roots with
   bounded-context directories.
2. Move `control-plane/runtime-context/*` to `runtime-context/*`.
3. Move `control-plane/workflow-engine/*` to `workflow-engine/*`.
4. Move `data-plane/execution/*` to `execution/*`.
5. Move `data-plane/runtime-output/*` to `runtime-output/*`.
6. Move `data-plane/materialization/*` to `materialization/*`.
7. Remove cross-module Layer assembly from runtime package modules such as
   `runtime-context/launcher.ts`; expose programs that depend on Tags instead.
8. Update scenario tests to compose concrete Layers at the scenario entrypoint.
9. Update dependency-cruiser rules to enforce no peer `Live` Layer imports in
   package source.
10. Regenerate architecture graphs and confirm they show bounded-context modules
   plus application entrypoints, not a fake runtime-package root.

## Acceptance Bar

- The runtime package has no `composition/` directory and no `RuntimeHost`
  umbrella service.
- Top-level runtime source directories are bounded contexts, not plane names.
- Plane terminology still appears in specs, docs, stream names, and diagrams
  where it describes runtime authority and data flow.
- Runtime package modules expose Tags, Layers, and programs without composing a
  full application graph.
- Application entrypoints and scenario entrypoints own final Layer composition.
- Tracer scenarios prove production package programs rather than reimplementing
  behavior.
- Materialize remains pluggable through `EventSink` and `MaterializeProvider`,
  not through a generic materialization engine.
