# effect-durable-operators

Generic, Effect-native durable operators composed over
`effect-durable-streams`, `@durable-streams/state`, and `@tanstack/db`.

This is the v0 implementation of the proposal in
[`docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md`](../../docs/proposals/SDD_EFFECT_DURABLE_OPERATORS.md)
and tracer [`017`](../../docs/tracers/017-effect-durable-operators.md).

## What ships

| Module                       | Role                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DurableTable`               | Scope-managed Effect facade over `@durable-streams/state`'s `createStreamDB`. Effect Schema in; Standard Schema at the upstream boundary. Pull (`get`/`query`) and push (`changes`) helpers. |
| `DurableProjection`          | Stream operator that converts raw durable facts into State Protocol change events. Projection state is allocated inside Effect (Ref/SynchronizedRef).                              |
| `DurableConsumer`            | "Process each logical item once per subscriber" operator. Selects, keys, claims/completes via the `ConsumerCheckpointStore` service. Exposes `run`, `sink`, and `stream` shapes.   |
| `ConsumerCheckpointStore`    | `Context.Tag` service. v0 ships a `Live` Layer that materializes checkpoint rows directly via `effect-durable-streams.snapshotThenFollow` (see "Checkpoint backend choice" below). Layer acquisition is a deterministic catch-up barrier. |
| `ClaimPolicy`                | `Data.taggedEnum` over `AtMostOnce`, `AtLeastOnce`, `AtLeastOnceWithClaim`.                                                                                                       |

## Boundaries

- This package does **not** import Firegrid runtime, client, protocol,
  scenarios, apps, or `@firegrid/durable-streams`. It is generic.
- It imports `@durable-streams/state` only (not other `@durable-streams/*`
  packages), enforced by `.dependency-cruiser.cjs` rules
  `durable-streams-imports-contained` and
  `effect-durable-operators-state-only`.

## Checkpoint backend choice

The SDD and tracer text describe checkpoints as "State Protocol-backed."
This implementation takes a slightly different path:
`ConsumerCheckpointStoreLive` materializes checkpoint rows directly from the
underlying durable stream using `effect-durable-streams.snapshotThenFollow`
rather than going through the `effect-durable-streams-state` `State`
materialization.

**Why:** `State.make` runs its read-and-decode work in a forked fiber and
does not expose a deterministic "caught-up" signal. The State Protocol's
`SnapshotEnd` control event is not emitted on fresh streams by the test
server, so a SnapshotEnd-based preload would silently swallow the wait.
`snapshotThenFollow` returns `{ snapshot, live }` only after the catch-up
read has completed, which gives the Layer a precise, type-checked sync
barrier: the first `read` after acquire is guaranteed to see all retained
checkpoints, so restart semantics for AtMostOnce/AtLeastOnce are
deterministic.

The wire format remains a State-Protocol-compatible change event (the
`CheckpointRow` schema is appended through a typed
`DurableStream.Producer`); a future Layer could swap to a `State`-backed
implementation without changing the service surface.

## Not in v0

- Workflow suspension, durable-clock primitives, required actions, prompts,
  tools, or any Firegrid session semantics.
- Append-only or pluggable checkpoint backends.
- Exactly-once external side effects.
- Windowing, `GlobalKTable` equivalents, SQL parsing.
- Firegrid runtime input refactor — see follow-up.

## Status vs. tracer 017

This is **the generic foundation only**.

Tracer 017 acceptance items NOT satisfied by this package:

- `effect-durable-operators.FIREGRID_PROOF.1` — Firegrid runtime input fold
  has not been replaced yet.
- `effect-durable-operators.FIREGRID_PROOF.2` — no scenario E2E proving
  production Firegrid surfaces yet.
- `effect-durable-operators.TRACER_017.5` — scenario E2E deferred.

A follow-up PR will:
1. Add a Firegrid-specific `ConsumerCheckpointStore` Layer that maps to the
   existing `firegrid.runtime_ingress.accepted` row family (no new wire
   format).
2. Refactor `packages/runtime/src/runtime-ingress/local-process-stdin.ts` to
   delegate to `DurableConsumer.stream` and drop `PendingRuntimeIngressState`.
3. Add `scenarios/firegrid/src/tracer-017.test.ts` running through production
   `Firegrid.launch` / `Firegrid.prompt` / `Firegrid.open(...).snapshot` and
   host `startRuntime`.

The split is per the tracer's own implementation order (#6): "Only after the
generic tests pass, replace Firegrid runtime input..."
