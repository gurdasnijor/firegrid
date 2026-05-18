# durable-tools vs. workflow-engine convergence

Status: stable note (architectural finding; not a migration commitment)
Evidence artifact: [`waitfor-durabledeferred-migration-feasibility-2026-05-17.md`](./waitfor-durabledeferred-migration-feasibility-2026-05-17.md)
(full file:line walkthrough, three migration shapes, effort/sequencing)
Invariant guard: `packages/runtime/test/workflow-engine/deferred-done-idempotency.test.ts`

## Why this note exists

`@firegrid/runtime/durable-tools` (`WaitFor.match`, the wait router,
`DurableToolsTable`, `reconcile.ts`) predates Firegrid's convergence on
`@effect/workflow` as the durable execution substrate. It is a second mechanism
for "suspend a workflow on a durable condition" running in parallel with the
engine-native `DurableDeferred`. This note records what was learned about
whether those two mechanisms can converge, so the next reader does not
re-derive it or deepen the redundant parts.

## The two load-bearing findings

1. **`engine.deferredDone` is idempotent — first-writer-wins.**
   `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:252-266`:
   the exit is `upsert`ed only `if (Option.isNone(existingDeferred))`, keyed on
   `${executionId}/${deferredName}`. A second call with the same key does not
   overwrite; `deferredResult` returns the first-written exit. `resume()` fires
   every call but is a deterministic no-op on an already-resolved workflow.
   This is a **Firegrid engine property, not an upstream `@effect/workflow`
   guarantee** — upstream `DurableDeferred.done` specifies no idempotency. It is
   now pinned by `deferred-done-idempotency.test.ts`; do not remove that test
   without re-homing the invariant.

2. **The typed wait sources are durable replay streams.**
   `RuntimeAgentOutputEvents` / `RuntimeRuns` are `DurableTable.rows()` streams
   with `includeInitialState: true`
   (`packages/effect-durable-operators/src/DurableTable.ts:597,753`): full
   deterministic replay from the start + live tail. A matcher that restarts
   re-reads the whole table and re-derives the same match. There is **no
   "subscription gap on restart" failure mode** for these sources.

## What this makes redundant

Given (1) and (2), `DurableToolsTable`'s `completions` table and
`reconcile.ts` are **redundant correctness theatre**, not load-bearing state:

- `reconcile.ts` exists to re-issue `engine.deferredDone` after a crash between
  "match recorded" and "workflow resumed". But idempotent `deferredDone` +
  replayable sources mean a restarted matcher re-derives the same match and
  re-calls `done` safely on its own. The reconciler's own header
  (`reconcile.ts:13-17`) already admits it relies entirely on engine
  idempotency.
- The `completions` table is the durable record the reconciler walks. Remove
  the reconciler and the table's only remaining consumer is its own crash-gap
  bridge, which the two findings already cover.

The **one** genuinely non-redundant role of `DurableToolsTable` is telling the
**external, non-workflow-driven wait router** which waits are pending after a
host restart (`waits.rows()` replay → re-attach subscriptions,
`wait-router.ts:186-288`). An external worker has no workflow recovery to
rediscover its work; that is the *only* reason a durable wait index must exist
at all.

## Convergence direction (recorded, not scheduled)

- **Shape C — strip the router (recommended near-term).**

  - **Step 1 — LANDED (branch `codex/reconcile-isolated-deletion`).**
    `reconcile.ts` deleted, the
    `DurableWaitCompletionRows` stream tag removed, and `completeMatch`
    reordered so `engine.deferredDone` fires *before* the `status: "completed"`
    write. The load-bearing change is the reorder, which establishes the
    invariant `status === "completed" ⟹ deferredDone fired` and collapses the
    completed-but-not-notified crash gap into the still-active gap already
    covered by the live-replay path. The deletion is the consequence. No
    `WaitFor.match` contract change.
  - **Step 2 — remaining.** Collapse the `completeMatch` / `writeTimeoutCompletion`
    match-vs-timeout arbitration onto `DurableDeferred.raceAll` (the race
    deferred already decides the winner; the `completions` reads are a
    redundant second mechanism given idempotent `deferredDone`).
  - **Step 3 — remaining.** With nothing left reading `completions`, delete the
    table entirely and reduce `durable-wait-store.ts` to the minimal
    pending-wait index (or eliminate it by deriving pending-ness from absence
    of the engine deferred row).

  Steps 2–3 are safe to schedule after the per-context engine slice.
- **Shape A — fold matching into the workflow body.** Eliminates
  `DurableToolsTable` entirely by making the matcher a raced effect inside the
  workflow (extending the pattern `wait-for.ts:392` already uses for the
  timeout side). Feasible and clean, but it should ride with the deferred-input
  rewrite that is already reshaping the same workflows
  (`runtime-context-workflow-core.ts`), not be done speculatively first.
- **Shape B (per-source matcher workflow) is rejected** — it relocates the
  table into a workflow's state and adds cross-workflow rendezvous; it does not
  reduce the parallel surface.

`WaitFor.match` has exactly two production call sites, both reducible to one
shape: the `wait_for` agent tool
(`host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:216`, dynamic
source + scalar-AND predicate + optional timeout) and the runtime-context
"next agent-output chunk" wait
(`host-sdk/src/host/runtime-context-workflow-core.ts:170`, fixed
`AgentOutputAfter` + empty trigger). Both shapes above preserve that contract.

## Open intent question (cannot be resolved from code)

Is the `wait_for` agent tool's typed-source + `FieldEqualsTrigger` surface a
stable external contract that agents/tools depend on? It is lowered from
protocol bindings (suggesting yes). Both convergence shapes preserve it as-is,
but the answer bounds how minimal Shape C's residual pending-wait index can be.
