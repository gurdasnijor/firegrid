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
| `ConsumerCheckpointStore`    | `Context.Tag` service. v0 ships a `Live` Layer backed by `effect-durable-streams.snapshotThenFollow` so layer acquisition is a deterministic catch-up barrier.                    |
| `ClaimPolicy`                | `Data.taggedEnum` over `AtMostOnce`, `AtLeastOnce`, `AtLeastOnceWithClaim`.                                                                                                       |

## Boundaries

- This package does **not** import Firegrid runtime, client, protocol,
  scenarios, apps, or `@firegrid/durable-streams`. It is generic.
- It imports `@durable-streams/state` only (not other `@durable-streams/*`
  packages), enforced by `.dependency-cruiser.cjs` rules
  `durable-streams-imports-contained` and
  `effect-durable-operators-state-only`.

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
