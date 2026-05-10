# 008: Materialization Strategy Interface

## Objective

Prove that Firegrid can choose a materialization strategy at runtime-host
configuration time while keeping projection definitions reusable and client
launch requests unaware of the backend.

The load-bearing claim is that the same projection definition can run against
multiple materialization strategies:

```txt
runtime-output journal
  -> EventSource
  -> EventProjector
  -> MaterializationStrategy
  -> queryable derived state
```

The runtime host chooses `state-protocol`, `raw-fold`, `materialize`, or a
future backend. The client launch request does not choose or see this.

## Why This Runs In Parallel With 006

Tracer 006 owns the runtime host root and launch boundary. Tracer 008 owns the
materialization abstraction that the host root will eventually select.

Do not make 008 depend on a finished runtime-host root. Expose a production
package surface that 006 can later consume.

## Current Ground Truth

Current materialization code lives under:

```txt
packages/runtime/src/data-plane/materialization/
  event-pipeline.ts
  runtime-output-source.ts
  projectors/runtime-output-session-projector.ts
  sinks/state-protocol/*
  sinks/materialize/*
  session-pipeline.ts
  materialize-pipeline.ts
```

This already has useful pieces:

- `EventSource`
- `EventProjector`
- `EventSink`
- `EventPipeline`
- `RuntimeOutputSessionProjectorLive`
- State Protocol writer/sink
- Materialize provider/sink

But the public shape still reads like recipe-specific pipelines:

```txt
runSessionProjection(...)
runMaterializeRuntimeOutputProjection(...)
SessionProjectionPipelineLive(...)
MaterializeRuntimeOutputPipelineLive(...)
```

Those are useful proof points, but the target abstraction is a host-selected
strategy, not named compatibility recipes.

## Target Shape

Create or stage toward a dedicated materialization package shape:

```txt
packages/materialization/
  src/
    core/
      EventSource.ts
      EventProjector.ts
      ProjectionDefinition.ts
      MaterializationStrategy.ts
      Query.ts
      index.ts
    state-protocol/
      StateProtocolStrategy.ts
      index.ts
    raw-fold/
      RawFoldStrategy.ts
      index.ts
    materialize/
      MaterializeProvider.ts
      MaterializeStrategy.ts
      MaterializeQuery.ts
      index.ts
```

If moving into a new package is too large for one tracer, keep the files in
`@firegrid/runtime` temporarily but expose the same public vocabulary and
report what blocked the package move. Do not add a compatibility wrapper around
the old recipe names.

The core abstraction should be close to:

```ts
export interface ProjectionDefinition<Source, Projected, Query = unknown> {
  readonly name: string
  readonly version: string
  readonly source: EventSource<Source>
  readonly projector: EventProjector<Source, Projected>
  readonly target: ProjectionTarget<Projected, Query>
}

export interface MaterializationStrategyService {
  readonly run: <Source, Projected, Query>(
    projection: ProjectionDefinition<Source, Projected, Query>,
  ) => Effect.Effect<ProjectionSummary, ProjectionError>

  readonly query: <A>(
    query: ProjectionQuery<A>,
  ) => Effect.Effect<ReadonlyArray<A>, ProjectionError>

  readonly subscribe: <A>(
    query: ProjectionQuery<A>,
  ) => Stream.Stream<A, ProjectionError>
}
```

The exact type names can change if implementation pressure suggests better
names. Preserve the conceptual boundary:

- Source reads source-of-truth facts.
- Projector interprets facts into projection changes.
- Strategy persists and queries derived state.
- Query/subscribe belong to the strategy or provider, not to projectors.

## Strategy Requirements

Implement enough of at least two strategies to prove swapability.

Preferred pair:

1. **State Protocol strategy** over Durable Streams State Protocol, adapted from
   current tracer 002 behavior.
2. **Raw fold strategy** over retained runtime-output events, for local/dev/test
   queryability without a derived stream.

Materialize can remain as an existing provider/sink in this tracer if fully
unifying it would make the PR too large. If Materialize is not unified, leave a
clear follow-up note for 008D.

## Non-Goals

- Do not build the runtime host root. That is tracer 006.
- Do not let client launch config choose a materialization backend.
- Do not make Materialize a special top-level engine outside the common model.
- Do not move runtime-output journaling into materialization.
- Do not couple projection definitions to Durable Streams, State Protocol, or
  Materialize implementation details.

## Write Scope

Primary:

```txt
packages/runtime/src/data-plane/materialization/**
packages/materialization/**          # only if creating the new package
packages/*/package.json              # only required dependency/export updates
features/firegrid/firegrid-event-pipeline-materialization.feature.yaml
features/firegrid/firegrid-materialization-engines.feature.yaml
```

Avoid touching:

```txt
packages/runtime/src/control-plane/runtime-context/**
packages/runtime/src/runtime-host/**
scenarios/firegrid/src/tracer-001.test.ts
```

Those are owned by tracer 006.

## Acceptance Criteria

1. A common `MaterializationStrategy` interface exists in package source.
2. A reusable session projection definition exists independently of the selected
   strategy.
3. The session projection can run through at least two strategies without
   changing the projector definition.
4. Existing tracer 002 behavior still passes through production package code.
5. The implementation does not introduce legacy materializer/engine wrapper
   names as public compatibility APIs.
6. The PR/report states whether `packages/materialization` earned extraction now
   or should remain staged under runtime for one more tracer.
7. The PR/report states what remains before Materialize fully satisfies the same
   strategy interface.

## Validation

Run the relevant checks for the implementation scope:

```sh
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/scenario-firegrid test -- tracer-002.test.ts
pnpm run check:docs
pnpm run check:specs
pnpm run lint
pnpm run lint:deps
pnpm run lint:dup
pnpm run lint:dead
pnpm run lint:effect-quality
```

If a new `@firegrid/materialization` package is introduced, also run its
package-specific typecheck/tests.

## Questions To Answer

- Is `MaterializationStrategy` a service Tag selected by host root, a plain
  value passed to a host root, or both?
- Does raw-fold reveal a simpler query model than the current EventSink-based
  pipeline?
- Does State Protocol fit as a strategy, or is it better modeled as one sink
  under a more general strategy?
- What does a strategy query type need to contain to support both raw-fold and
  Materialize without flattening into untyped SQL strings?
- What dependency boundary prevents `@firegrid/materialization/core` from
  importing Durable Streams or runtime control-plane code?
