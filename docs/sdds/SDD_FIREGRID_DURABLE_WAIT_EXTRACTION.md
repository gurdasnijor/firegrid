# SDD: Firegrid Durable Wait Extraction

Status: draft package-boundary design
Created: 2026-05-16
Owner: Firegrid Runtime

Related specs:

- `firegrid-durable-wait-extraction`
- `firegrid-runtime-boundary-reconciliation`
- `firegrid-durable-tools`
- `effect-durable-operators`

## Purpose

`firegrid-runtime-boundary-reconciliation.EFFECT_DURABLE_OPERATORS.1` through
`firegrid-runtime-boundary-reconciliation.EFFECT_DURABLE_OPERATORS.4` require a
separate package-boundary design before runtime durable wait internals are
treated as permanent runtime concepts or moved into
`packages/effect-durable-operators`.

This SDD is that design checkpoint. It evaluates the current
`packages/runtime/src/waits/**` surface after the boundary reconciliation PRs,
classifies what is generic durable operator behavior versus Firegrid runtime
vocabulary, and defines staged acceptance criteria. It does not move code.

`firegrid-runtime-boundary-reconciliation.SEQUENCING.3` remains the sequencing
guard: generic durable wait extraction needs this design before implementation.

## Current Shape

The current waits bounded context is already factored into distinct roles:

| File | Current role | Initial classification |
| --- | --- | --- |
| `packages/runtime/src/waits/internal/keys.ts` | Composite wait key schema using an Effect Schema JSON tuple transform. | Generic candidate. |
| `packages/runtime/src/waits/internal/table.ts` | `DurableToolsTable`, wait rows, completion rows, and table layer options. | Mixed: row schemas are generic candidates; table name/options are runtime-owned until a generic table factory is designed. |
| `packages/runtime/src/waits/internal/durable-wait-store.ts` | Row-level lookup, upsert, and row stream capability tags over wait and completion rows. | Generic candidate if tag names and package keys become non-Firegrid. |
| `packages/runtime/src/waits/internal/types.ts` | Scalar field-equality trigger DSL, wait status/outcome types, `WaitForError`, and predicate evaluator. | Mostly generic candidate. Error naming may need a package-neutral name. |
| `packages/runtime/src/waits/internal/source-collections.ts` | Dynamic source registry mapping source names to row observation streams. | Generic candidate if named as durable source registry, not Firegrid source registration. |
| `packages/runtime/src/waits/internal/wait-for.ts` | Workflow-handler operator that writes wait rows, races match with timeout, and decodes matched payloads. | Mixed: generic durable wait operator plus `@effect/workflow` integration. |
| `packages/runtime/src/waits/internal/wait-router.ts` | Scoped subscriber driver over active waits and registered source streams. | Generic candidate, but runtime owns composition and source registrations. |
| `packages/runtime/src/waits/internal/reconcile.ts` | Reconciles completion rows to workflow deferred state after restart. | Mixed: generic completion reconciliation plus `@effect/workflow` deferred integration. |
| `packages/runtime/src/waits/DurableToolsWaitFor.ts` | Runtime composition layer for table, source registry, row authority, and router. | Runtime adapter until a generic package layer exists. |
| `packages/runtime/src/waits/index.ts` | Public runtime wait barrel. | Runtime-owned compatibility/public surface. |
| `packages/runtime/src/waits/source-registration.ts` | Narrow re-export used by runtime source-registration layers. | Runtime-owned adapter surface. |

The generic package today intentionally exposes only `DurableTable` and related
types from `packages/effect-durable-operators/src/index.ts`. Its README states
that old consumer/projection/source abstractions were removed and that callers
should express workflows with ordinary Effect Stream code plus `DurableTable`.
Any wait extraction must respect that direction: add durable coordination
primitives only when they are demonstrably generic and Effect-native, not as a
revival of the old broad consumer framework.

## Generic Durable Operator Candidates

The strongest generic candidates are independent of Firegrid runtime vocabulary:

- wait identity: `WaitKeySchema`, `WaitKeyEncoded`, and the stable
  `{ executionId, name }` key shape;
- wait rows and completion rows: active wait intent, completion outcome, matched
  payload, timestamps, and optional deadline;
- row authority shapes: lookup by key, upsert row, and row stream capabilities
  for waits and completions;
- scalar matching: the AND-of-field-equality trigger DSL and evaluator over
  decoded row payloads;
- dynamic named source lookup: a `SourceCollectionHandle`-like handle with
  `name` plus `subscribe()`;
- router/subscriber-driver mechanics: attach active waits to dynamic source
  streams, re-read before completing, write completion rows, and idempotently
  mark wait rows terminal;
- completion reconciliation: walk completion rows on startup and reconcile
  durable completion evidence to the waiting workflow/deferred bridge;
- timeout/match race semantics: write timeout completions without overwriting an
  already-matched completion.

These candidates line up with
`firegrid-runtime-boundary-reconciliation.EFFECT_DURABLE_OPERATORS.2`, which
calls out wait keys, wait rows, completion rows, timeout/race semantics, durable
deferred/clock integration, and source-name matching.

## Firegrid Runtime-Owned Pieces

The following should not move into `effect-durable-operators`:

- runtime source names such as `RuntimeObservationSourceNames` and
  `RuntimeAuthoritySourceNames`;
- source-registration layers under `packages/runtime/src/source-registration/**`;
- agent-tool schemas, MCP exposure, or `wait_for` tool lowering;
- runtime-host composition and host-owned Durable Streams URL construction;
- runtime permission, session, codec, provider, or agent vocabulary;
- docs/examples that teach Firegrid app authors which runtime observation source
  to wait on;
- `@firegrid/client` session wait APIs and browser-safe projections.

These boundaries satisfy
`firegrid-runtime-boundary-reconciliation.EFFECT_DURABLE_OPERATORS.3`: Firegrid
runtime keeps source registrations, agent-tool bindings, runtime observation
names, and host composition adapters that depend on Firegrid runtime vocabulary.

## Mixed Boundaries

Some code is generic in concept but coupled to a specific integration:

- `WaitFor.match` uses `@effect/workflow` `DurableDeferred`,
  `DurableClock`, `WorkflowEngine`, and `WorkflowInstance`. That may be a
  legitimate generic dependency for `effect-durable-operators`, but it is a
  separate package dependency decision.
- `reconcileCompletions` writes workflow deferred state through
  `WorkflowEngine.deferredDone`. The completion-row scan is generic; the
  deferred bridge is workflow-specific.
- `DurableToolsTable` uses the runtime table namespace
  `firegrid.durableTools`. The row schemas are portable, but the retained stream
  namespace is a runtime compatibility commitment.
- `SourceCollections` is a generic dynamic name-to-stream registry, while
  runtime source-registration modules own which Firegrid source names are
  registered.

Extraction should split mixed modules at typed adapter boundaries before moving
code. A good target is:

```ts
// generic package shape, illustrative only
interface DurableWaitWorkflowBridge {
  readonly currentExecution: Effect.Effect<{
    readonly workflowName: string
    readonly executionId: string
  }>
  readonly waitForDeferred: (name: string) => unknown
  readonly completeDeferred: (
    input: {
      readonly workflowName: string
      readonly executionId: string
      readonly deferredName: string
      readonly payload: unknown
    },
  ) => Effect.Effect<void, unknown>
}
```

The exact API should follow Effect primitives directly: `Context.Tag` services,
`Layer` providers, `Stream` row observations, narrow `Effect` methods, and
Effect Schema row definitions. It should not introduce custom Firegrid wrapper
types for authority, source, stream, or subscriber roles.

## Extraction Criteria

A candidate may move to `packages/effect-durable-operators` only when all of the
following are true:

1. It can be named without Firegrid runtime vocabulary.
2. It can be expressed without importing any `@firegrid/*` package.
3. It has at least two plausible non-Firegrid consumers or clearly belongs
   beside `DurableTable` as generic durable coordination behavior.
4. Its row/key schemas preserve encoded wire forms unless a separate retained
   stream migration plan exists.
5. Its API uses stock Effect surfaces instead of new package-specific wrappers.
6. Its tests prove retained replay, live row observation, idempotent match,
   idempotent timeout, completion reconciliation, and startup ordering.
7. `pnpm run lint:deps` continues to enforce that
   `effect-durable-operators` imports no `@firegrid/*` packages.

The strongest first extraction target is the schema/evaluator layer:
`WaitKey`, wait row schemas, completion row schemas, wait status/outcome enums,
and scalar field-equality matching. That slice is mostly Effect Schema plus pure
functions and does not require a workflow dependency decision.

## Staged Plan

### Stage 0: Design Only

This PR lands `firegrid-durable-wait-extraction` and this SDD. No runtime or
package implementation changes.

Acceptance:

- `firegrid-runtime-boundary-reconciliation.EFFECT_DURABLE_OPERATORS.1-.4` have
  an explicit follow-up design;
- `firegrid-runtime-boundary-reconciliation.SEQUENCING.3` is satisfied for the
  design prerequisite;
- `check:specs`, `check:docs`, and `git diff --check` pass.

### Stage 1: Schema And Matching Extraction

Move or duplicate behind compatibility exports only the pieces that are pure
schemas/functions:

- wait key schema and encoded key;
- wait row and completion row schemas;
- field-equality trigger schema and evaluator;
- wait status and outcome kind schemas.

Do not move runtime source registrations, runtime host composition, or
`WaitFor.match` in this stage.

Acceptance:

- encoded wait keys and existing wait rows remain backward compatible;
- runtime wait tests pass unchanged except import target updates internal to the
  runtime package;
- effect-durable-operators package tests cover key encoding and predicate
  matching.

### Stage 2: Generic Row Authority Layer

Evaluate a generic `DurableWaitTable` and row capability tags in
`effect-durable-operators`, backed by `DurableTable`.

Acceptance:

- the generic layer exposes lookup/upsert/row-stream capabilities rather than a
  bundled service that owns lifecycle policy;
- Firegrid runtime provides the generic layer through an adapter that preserves
  its current stream URL and public runtime wait barrel;
- retained stream compatibility is proven against existing runtime wait rows.

### Stage 3: Dynamic Source Registry

Evaluate moving the source registry and source handle type into
`effect-durable-operators`.

Acceptance:

- the API remains a dynamic lookup boundary for wait operators;
- static runtime subscribers still consume `Stream` capability tags, not source
  handles;
- Firegrid runtime keeps the source-registration layers that register runtime
  observation names.

### Stage 4: Workflow Bridge And Operator

Evaluate moving the `WaitFor.match`, timeout race, wait router, and completion
reconciliation mechanics behind a generic workflow bridge.

Acceptance:

- any new `@effect/workflow` dependency in `effect-durable-operators` is
  deliberate and documented;
- timeout/match races remain idempotent across crash and replay;
- completion reconciliation remains scoped and restart-safe;
- Firegrid runtime keeps its `WaitFor` public surface and agent-tool lowering.

## Non-Goals

- Do not move code in this SDD PR.
- Do not add a scheduler, timer resolver, claim system, or storage primitive.
- Do not expose wait rows or completions from `@firegrid/client`.
- Do not move Firegrid runtime observation names or source registration layers
  to `effect-durable-operators`.
- Do not revive the deprecated `DurableConsumer`, `DurableProjection`,
  source-adapter, or checkpoint-store framework.
- Do not change PR9 codec/session or runtime agent event-pipeline behavior.

## Validation For Future Extraction PRs

Each implementation PR should run at least:

```bash
pnpm --filter effect-durable-operators typecheck
pnpm --filter effect-durable-operators test
pnpm --filter @firegrid/runtime typecheck
pnpm --filter @firegrid/runtime exec vitest run test/waits/WaitFor.test.ts
pnpm run lint:deps
pnpm run check:specs
pnpm run check:docs
git diff --check
```

Broader runtime host/source tests are required if an implementation touches
runtime source registration, host composition, or workflow integration.
