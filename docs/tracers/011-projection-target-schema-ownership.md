# 011: Projection Target Schema Ownership

## Objective

Remove the hardcoded session-specific query/schema knowledge from
materialization strategies and prove that projection targets own their own
schemas, encoders, folds, and query adapters.

The load-bearing claim is:

```txt
projection definition declares source + projector + target contract
  -> strategy supplies storage/query mechanics
  -> target contract supplies state schema, event encoder, fold, and query adapter
  -> the same strategy can run a non-session projection without code changes
```

Tracer 008 proved the first strategy seam. It intentionally left the State
Protocol strategy with hardcoded `sessionStateSchema` and
`SessionProjectionQuery` support. That is acceptable only as tracer debt.

## Why This Is Load Bearing

Materialization is supposed to be host-selected infrastructure. It should be
possible to swap State Protocol, raw-fold, Materialize, or a future provider
without rewriting each projection. The strategy layer cannot become a registry
of every product projection shape.

If the strategy owns session schemas, every new derived system will require
strategy edits. If the target owns schema/query behavior, new projections can be
added by defining new target descriptors.

## Current Ground Truth

Current hardcoded session coupling:

```txt
packages/runtime/src/data-plane/materialization/state-protocol/StateProtocolStrategy.ts
  -> imports sessionStateSchema
  -> imports SessionProjectionQuery
  -> querySessionRows(...) knows sessions/messages collections
```

Current projection/session files:

```txt
packages/runtime/src/data-plane/materialization/session-projection-definition.ts
packages/runtime/src/data-plane/materialization/sinks/state-protocol/session-state-change.ts
packages/runtime/src/data-plane/materialization/raw-fold/RawFoldStrategy.ts
packages/runtime/src/data-plane/materialization/state-protocol/StateProtocolStrategy.ts
packages/protocol/src/session/**
packages/durable-streams/src/DurableState.ts
```

Relevant ACIDs:

- `firegrid-platform-invariants.PRODUCTION_SURFACE.5`
- `firegrid-materialization-engines.ENGINE.4`
- `firegrid-materialization-engines.ENGINE.5`
- `firegrid-materialization-engines.ENGINE.7`
- `firegrid-materialization-engines.STATE_PROTOCOL.1`
- `firegrid-materialization-engines.STATE_PROTOCOL.2`
- `firegrid-materialization-engines.RAW_FOLD.1`
- `firegrid-materialization-engines.RAW_FOLD.2`
- `firegrid-materialization-engines.BOUNDARY.4`
- `firegrid-materialization-engines.BOUNDARY.5`

## Target Shape

Introduce a target contract that is supplied by the projection definition, not
the strategy:

```ts
interface ProjectionTarget<Change, Query, Result> {
  readonly name: string
  readonly encodeStateProtocol?: (
    change: Change,
    context: ProjectionContext,
  ) => unknown
  readonly stateSchema?: unknown
  readonly fold?: (
    events: ReadonlyArray<Change>,
  ) => ReadonlyArray<unknown>
  readonly query: (
    rows: ReadonlyArray<unknown>,
    query: Query,
  ) => Result
}
```

The exact type shape should follow the existing `ProjectionDefinition`,
`MaterializationStrategyService`, and Durable State helper constraints. The
important boundary is ownership:

- Session projection owns session state schema/query mapping.
- State Protocol strategy owns writing/reading Durable State streams.
- Raw-fold strategy owns retained in-memory folding mechanics.
- Materialize strategy/provider owns SQL provisioning/query mechanics.

## Minimal Proof

This tracer should prove the seam with the current session projection and one
tiny non-session projection. The second projection can be intentionally small,
such as a count/probe projection over runtime output rows, as long as it forces
the strategy to stop importing session-specific types.

The proof should show:

```txt
sessionProjection target
  -> raw-fold query
  -> State Protocol query

probeProjection target
  -> raw-fold query
  -> State Protocol query, or documented unsupported shape with a typed reason
```

If full State Protocol support for the second projection is too large, the PR
must still remove session imports from the strategy and make unsupported targets
fail through a target capability check rather than a hardcoded target name.

## Non-Goals

- Do not implement the Materialize strategy adapter unless it is needed to prove
  the target contract.
- Do not extract `@firegrid/materialization` into a separate package.
- Do not redesign runtime host configuration.
- Do not add new client-facing launch configuration.
- Do not build a broad projection registry.

## Write Scope

Primary:

```txt
packages/runtime/src/data-plane/materialization/core/**
packages/runtime/src/data-plane/materialization/session-projection-definition.ts
packages/runtime/src/data-plane/materialization/raw-fold/**
packages/runtime/src/data-plane/materialization/state-protocol/**
packages/runtime/src/data-plane/materialization/sinks/state-protocol/**
packages/runtime/src/data-plane/materialization/*.test.ts
features/firegrid/firegrid-materialization-engines.feature.yaml
```

Avoid:

```txt
packages/runtime/src/runtime-host/**
packages/runtime/src/control-plane/**
packages/runtime/src/data-plane/execution/**
scenarios/firegrid/src/tracer-001.test.ts
```

Tracer 002 may be touched only to prove the existing session projection still
runs through the production package surface.

## Acceptance Criteria

1. State Protocol strategy no longer imports session protocol schemas or
   `SessionProjectionQuery`.
2. Projection definitions or target descriptors provide the State Protocol
   schema/encoder and query adapter needed by strategies.
3. Raw-fold and State Protocol continue to support the session projection
   through the common strategy API.
4. A second tiny projection proves the target contract is not session-only, or
   unsupported target capability is reported through a typed strategy error.
5. Client launch request types remain unaware of projection target schemas,
   query adapters, and materialization strategy choice.
6. A tracer 011 scenario-level E2E appends runtime-output facts, runs the
   production materialization surface through State Protocol, and queries the
   derived projection through target-owned schema/query behavior.
7. Tests assert the new target ownership boundary with full ACID references.

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

## Questions To Answer

- Should the target contract live on `ProjectionDefinition` directly or as a
  separate `ProjectionTarget` object referenced by definition?
- Which target capabilities are required for State Protocol, raw-fold, and
  Materialize?
- Should State Protocol query support require a Durable State schema, or can
  some targets expose write-only projection streams?
- Is target ownership enough to defer `@firegrid/materialization` extraction,
  or does this tracer make extraction obviously cheaper?
