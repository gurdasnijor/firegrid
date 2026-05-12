# 017: Effect Durable Operators

## Objective

Prove a small, reusable Effect-native operators package can replace
application-level durable stream folds without introducing another Firegrid
service plane.

The package should compose:

```txt
effect-durable-streams
  + @durable-streams/state createStreamDB
  + Effect Stream / Scope / Layer / Schema
  -> durable table, projection, and consumer operators
```

## Why This Is Load Bearing

Firegrid keeps rediscovering the same mechanics:

- read retained durable facts;
- fold requested-minus-progress state;
- subscribe to new facts;
- claim or checkpoint before a provider side effect;
- rebuild queryable state from retained history.

Those mechanics should not live in runtime-ingress, required-action,
materialization, or future tool-specific modules. They are generic durable
operator concerns. This tracer validates that they can be factored once without
hiding Effect streams or overfitting to Firegrid.

## Design Inputs

- `docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md`
- `docs/effect-durable-streams/MAINTAINERS.md`
- `packages/effect-durable-streams*/BACKLOG.md`
- `features/firegrid/effect-durable-operators.feature.yaml`

## Required ACIDs

- `effect-durable-operators.PACKAGE.1`
- `effect-durable-operators.PACKAGE.2`
- `effect-durable-operators.PACKAGE.3`
- `effect-durable-operators.TABLE.1`
- `effect-durable-operators.TABLE.2`
- `effect-durable-operators.TABLE.3`
- `effect-durable-operators.TABLE.4`
- `effect-durable-operators.TABLE.5`
- `effect-durable-operators.PROJECTION.1`
- `effect-durable-operators.PROJECTION.2`
- `effect-durable-operators.PROJECTION.3`
- `effect-durable-operators.PROJECTION.4`
- `effect-durable-operators.CONSUMER.1`
- `effect-durable-operators.CONSUMER.2`
- `effect-durable-operators.CONSUMER.3`
- `effect-durable-operators.CONSUMER.4`
- `effect-durable-operators.CONSUMER.5`
- `effect-durable-operators.CONSUMER.6`
- `effect-durable-operators.CONSUMER.7`
- `effect-durable-operators.CONSUMER.8`
- `effect-durable-operators.FIREGRID_PROOF.1`
- `effect-durable-operators.FIREGRID_PROOF.2`
- `effect-durable-operators.FIREGRID_PROOF.3`
- `effect-durable-operators.BOUNDARIES.1`
- `effect-durable-operators.BOUNDARIES.2`
- `effect-durable-operators.BOUNDARIES.3`
- `effect-durable-operators.BOUNDARIES.4`
- `effect-durable-operators.BOUNDARIES.5`
- `effect-durable-operators.TRACER_017.1`
- `effect-durable-operators.TRACER_017.2`
- `effect-durable-operators.TRACER_017.3`
- `effect-durable-operators.TRACER_017.4`
- `effect-durable-operators.TRACER_017.5`

## Target Package Shape

```txt
packages/effect-durable-operators/
  src/
    DurableTable.ts
    DurableProjection.ts
    DurableConsumer.ts
    ConsumerCheckpointStore.ts
    Errors.ts
    index.ts
  test/
    durable-table.test.ts
    durable-projection.test.ts
    durable-consumer.test.ts
```

The package is generic. It must not import Firegrid runtime, client, protocol,
scenario, app, or `@firegrid/durable-streams` packages.

## Implementation Order

1. Implement package skeleton, exports, and boundary checks.
2. Implement `DurableTable` as an Effect facade over
   `@durable-streams/state` `createStreamDB`.
3. Implement `DurableProjection` and prove raw debit/credit facts become
   queryable account-balance rows through `DurableTable`.
4. Implement `DurableConsumer` and `ConsumerCheckpointStore` with State
   Protocol-backed checkpoints.
5. Add restart/cold-start tests for table replay and consumer checkpoint
   semantics.
6. Only after the generic tests pass, replace Firegrid runtime input
   requested-minus-accepted fold code with `DurableConsumer`.
7. Add a scenario E2E that invokes production Firegrid surfaces and observes
   provider-visible runtime behavior.

## Firegrid Proof Rules

- The scenario must start from production client/runtime surfaces.
- The scenario must not use Firegrid-specific shadow harnesses or product-shaped
  read helpers.
- The operators package must remain generic; Firegrid-specific schemas and row
  names stay outside it.
- Runtime input delivery may still use the transitional physical
  `runtime_ingress` row family, but the fold/checkpoint logic should move to the
  generic consumer operator.

## Non-Goals

- Do not implement workflow suspension, required actions, tools, scheduling, or
  prompt APIs.
- Do not add a `DurableLog` wrapper around `DurableStream`.
- Do not reimplement TanStack DB Collections or db-ivm.
- Do not create append-only checkpoint backends in v0.
- Do not solve exactly-once external side effects.

## Acceptance

Tracer 017 is complete when:

- `packages/effect-durable-operators` has generic package tests for table,
  projection, and consumer semantics;
- restart/cold-start tests cover the table and consumer paths;
- Firegrid runtime input no longer owns a custom requested-minus-progress fold
  where `DurableConsumer` can own it;
- a scenario E2E proves production Firegrid input still reaches a real provider;
- all required ACIDs above are referenced by package tests, scenario tests, or
  narrowly relevant implementation comments.
