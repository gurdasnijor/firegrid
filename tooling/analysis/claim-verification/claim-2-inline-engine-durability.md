# Claim 2 — Inline WorkflowEngine composition discards durability at restart

## Claim & test (restated)

HYPOTHESIS: `WorkflowEngine`/`WorkflowEngineTable` are composed inline
(via `Layer.unwrapEffect`/`unwrapScoped`/`scoped`/`buildWithScope`)
rather than as catalogued const layers, and this discards durable state
on host restart. TEST: locate every composition site; compare to the
sibling catalogued layer; find any restart-durability test.

## Finding: the premise is a misclassification

The host-sdk `Layer.succeed(WorkflowEngine.WorkflowEngine, handle.engine)`
sites are **not the engine's construction** — they re-inject an
already-constructed, durably-backed handle into a per-context support
layer. The engine is constructed from a **catalogued `const layer`**,
and its durable state lives in a Durable Streams stream, not process
memory. There is no `ClusterWorkflowEngine` in firegrid production code
(it exists only under vendored `repos/effect/packages/cluster/`); the
firegrid equivalent is `DurableStreamsWorkflowEngine`.

## STATIC — every WorkflowEngine / WorkflowEngineTable site

**Real construction (catalogued layer):**
- `packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.ts:33-52`
  — `layer = Layer.scopedContext(Effect.gen(…))`, exported as
  `DurableStreamsWorkflowEngine.layer` (`:54-57`). Resolves
  `WorkflowEngineTable` (durable backing, `:42`), calls
  `makeWorkflowEngine(table, workerId)` (`:43`), returns a `Context`
  with both tags; `WorkflowEngineTable.layer(...)` is `Layer.provide`d
  (`:51`). Scope managed by `Layer.scopedContext` — a proper Effect
  scope, **not** a raw `Layer.succeed` of a pre-built value.
- `DurableStreamsWorkflowEngine.ts:14-31` — `make = Effect.gen(…)`
  scoped variant, same body, `Scope.Scope` in requirements.
- `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:25-296`
  — `makeWorkflowEngine`; all durable state
  (`executions`/`activities`/`deferreds`/`clockWakeups`/`activityClaims`)
  is read/written through `table.*` (the Durable Streams
  `WorkflowEngineTable`); construction runs `recoverPendingClockWakeups`
  (`:293`) and `resume(...)` reads persisted rows back — construction
  *recovers* durable state, it does not discard it.

**Host-sdk re-injection (NOT construction — `Layer.succeed` of a built handle):**
- `packages/host-sdk/src/host/runtime-context-engine-registry.ts:152-174`
  — the host construction path:
  `Layer.buildWithScope(DurableStreamsWorkflowEngine.layer({ streamUrl: … }), engineScope)`
  builds the catalogued layer into a per-context `Scope.make()`,
  extracts `engine`/`table` via `Context.get`, stores in a `Ref<Map>`,
  closes the scope deterministically on `deregister` (`:82-95,125-134`).
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:113-114`,
  `packages/host-sdk/src/host/runtime-context-workflow-support.ts:50-51`,
  `runtime-context-engine-registry.ts:74-75`,
  `packages/host-sdk/src/host/runtime-substrate.ts:107-108`,
  `packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:267,269`
  — all re-inject the already-resolved `handle.engine`/`handle.table`;
  none re-runs construction.

The orientation's `Layer.unwrapEffect` sites at `host/layers.ts:74,171`
wrap `SandboxSupervisorCommandTable` / `RuntimeOutputTable`, **not**
`WorkflowEngine` — unrelated to this claim.

**Sibling comparison:** upstream `ClusterWorkflowEngine`
(`repos/effect/packages/cluster/`, used via `ClusterWorkflowEngine.layer`
in `repos/effect/packages/cluster/test/ClusterWorkflowEngine.test.ts:258`)
is the catalogued-layer pattern. `DurableStreamsWorkflowEngine.layer`
(`DurableStreamsWorkflowEngine.ts:33-57`) is the structurally
**equivalent** catalogued `const layer`; the test at
`packages/runtime/test/workflow-engine/DurableStreamsWorkflowEngine.test.ts:278`
asserts it "exposes a ClusterWorkflowEngine-shaped layer installer."
Same shape, not different. The host-sdk `Layer.succeed(...handle.engine)`
calls are downstream re-injection (equivalent to `Effect.provideService`
after a layer has built) — they cannot discard state that was never in
the handle; the state is in the Durable Stream addressed by `streamUrl`.

## RUNTIME — durability-across-reconstruction is tested and passes

- `packages/runtime/test/workflow-engine/DurableStreamsWorkflowEngine.test.ts:391-431`
  (VALIDATION.3): persists a workflow `DurableClock` wakeup and fires it
  **after engine reconstruction**. First `runWith(...)` discards (engine
  torn down), the table is inspected to show a pending clock row, then a
  **fresh** `DurableStreamsWorkflowEngine.layer` is built (each `runWith`
  constructs a new engine layer over the same `streamUrl`) and the
  workflow resolves to `"awake"`. Verified directly: the second
  `runWith` at `:425-429` asserts `expect(result).toBe("awake")`.
- `DurableStreamsWorkflowEngine.test.ts:888+` (VALIDATION.9): persists
  SuspendOnFailure causes across engine reconstruction.
- `DurableStreamsWorkflowEngine.test.ts:278-312` (ENGINE.4): same
  idempotency key across two independently-constructed engine layers;
  activity runs exactly once (`runs === 1`).
- `:314` (VALIDATION.1 replay completed activity), `:498`
  (VALIDATION.5), `:751` (interrupted state persisted).

Each `runWith` builds a brand-new layer over the same `streamUrl` — i.e.
"engine restart with durability preserved" — and the assertions confirm
preservation. The host per-context path
(`runtime-context-engine-registry.ts`) uses that identical catalogued
layer via `Layer.buildWithScope`, so the proven semantics carry over.

## Verdict

"Inline composition" is a misclassification: the host-sdk
`Layer.succeed`/`provideService` sites re-inject an already-built,
durably-backed handle and discard nothing. The real construction is the
catalogued `DurableStreamsWorkflowEngine.layer`, whose durable state
resides in the `WorkflowEngineTable` Durable Stream and is provably
recovered across full engine reconstruction by multiple passing runtime
tests. (Note: this is REFUTED, not merely UNVERIFIED, because runtime
restart-durability evidence exists and passes — stronger than the
brief's "likely UNVERIFIED" prediction.)

VERDICT: REFUTED
