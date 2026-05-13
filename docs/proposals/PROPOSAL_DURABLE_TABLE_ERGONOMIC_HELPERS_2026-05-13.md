# Proposal: `DurableTable` Ergonomic Helpers

**Date:** 2026-05-13
**Status:** Proposed (no implementation yet).
**Author:** OLA (durable-tools `wait_for` implementation feedback).

## Problem

Three patterns recurred during the wait_for implementation and had to be
reinvented inline:

1. **Subscribe-only-active-rows.** "Emit each row from a collection that
   matches a predicate, including initial state, exclude deletes." Today
   this is ~10 lines of `subscribe((coll, emit) => coll.subscribeChanges(
   (changes) => changes.forEach((c) => { if (c.value && pred(c.value))
   emit(c.value) }), { includeInitialState: true }))`.

2. **Composite-key find.** `.get` is broken for composite primary keys
   (see [`packages/effect-durable-operators/KNOWN_ISSUES.md`](../../packages/effect-durable-operators/KNOWN_ISSUES.md#1-durabletablecollectionfacadeget-misses-rows-with-composite-primary-keys)).
   The runtime workaround is a query-scan: `.query.toArray.find(...)`.
   Multiple modules (Firegrid wait_for, plausibly future durable-tools
   modules, plausibly any future composite-keyed collection in
   `@firegrid/protocol`) want the same scan.

3. **Initial-state-replaying facade.** The vast majority of subscribers
   want `{ includeInitialState: true }`. Having to pass it every time is
   minor noise but adds up.

## Proposal

Add a small `DurableTable.Helpers` (or `effect-durable-operators/helpers`
subpath, TBD) module exporting:

```ts
// 1. Subscribe to live row values (with initial-state replay), optionally
//    filtered by a predicate.
const subscribeRows: <Row, Key>(
  facade: DurableTableCollectionFacade<Row, Key>,
  options?: { readonly where?: (row: Row) => boolean }
) => Stream.Stream<Row, DurableTableError>

// 2. Find a row by predicate, scanning the materialized collection. Use
//    this for composite-key lookups until DurableTable.get is fixed.
const findRowBy: <Row, Key>(
  facade: DurableTableCollectionFacade<Row, Key>,
  predicate: (row: Row) => boolean,
) => Effect.Effect<Option.Option<Row>, DurableTableError>

// 3. (Maybe) a subscribeChanges-with-defaults variant that returns the
//    Stream directly without the (coll, emit) ceremony.
```

The package would *not* gain new state primitives; these are pure adapters
over the existing facade.

## Why this is on hold

This proposal sits behind two upstream concerns:

1. **`.get` should be fixed first.** Helper #2 is a workaround. If the
   bug in
   [`KNOWN_ISSUES.md#1`](../../packages/effect-durable-operators/KNOWN_ISSUES.md#1-durabletablecollectionfacadeget-misses-rows-with-composite-primary-keys)
   is fixed, `findRowBy` becomes redundant — callers should use `.get`.
   Landing the helper before the fix risks calcifying the workaround.
2. **One consumer isn't justification.** Today only the Firegrid
   `wait_for` router (PR #171) needs `findRowBy`; only Firegrid runtime
   ingress and runtime output need a `where`-filtered subscription
   stream. The bar for promoting a helper into the operators package is
   "two consumers, written independently."

## Validation plan

When a second consumer emerges (most likely `schedule_me` or `spawn` from
the durable-tools roadmap), revisit this proposal. Promotion path:

1. Land the helpers in `effect-durable-operators` with their own tests.
2. Update the Firegrid `wait_for` package to use the promoted helpers,
   deleting its inline `findWaitByKey` helper.
3. Add a spec ACID to `effect-durable-operators.feature.yaml` documenting
   the helper API.

## Risks

- **Forced abstraction.** Two callers is the minimum bar. Three would be
  better, since two can coincidentally share a shape without it being a
  good abstraction.
- **Helper namespace pollution.** Once a `Helpers` module exists, every
  contributor will want to drop their utility in there. The bar must stay
  high: "we've written this same code at least twice in different
  packages."
