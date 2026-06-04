# Shape C Handler Slice — Delta & Deletion Map

Doc-Class: internal-contract
Status: active
Date: 2026-05-22
Branch: `sidecar/shape-c-runtime-context-handler` (off `rearch/shape-c-cutover`)
Baseline: `docs/architecture/2026-05-22-shape-c-cutover-baseline.md`
Operating plan: `docs/architecture/2026-05-22-shape-c-cutover-operating-plan.md`

This slice contributes one component of the Wave 1 coherent replacement: the
per-event Shape C RuntimeContext handler, with the tightened executor type
boundary it depends on, and focused tests. It does **not** delete the
wrong-shape `RuntimeContextWorkflowNative` body, because deletion correctly
waits on the sibling host-composition-rewire slice that wires
`handleRuntimeContextEvent` as the production registration. See
"Why deletion waits" below.

## What this slice ships

### Added

| File | LOC | Role |
|---|---:|---|
| `packages/runtime/src/agent-event-pipeline/subscribers/runtime-context/handler.ts` | 263 | The Shape C per-event handler (`handleRuntimeContextEvent`) with the target signature: `R = RuntimeContextStateStore \| AgentSession \| RuntimeToolUseExecutor`. No `WorkflowEngine`, no entity-lifetime body, no `DurableDeferred`, no dense scan. Lands under #683's TOPOLOGY landing zone so the Shape C semgrep guard (`firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber`) covers it. |
| `packages/runtime/test/agent-event-pipeline/subscribers/runtime-context/handler.test.ts` | 279 | Three focused tests: (a) state transition + dispatch through `AgentSession`; (b) reload idempotency (second handler call reloads from durable row and skips already-processed events); (c) tool-result roundtrip through `RuntimeToolUseExecutor` + `AgentSession`. |
| `docs/architecture/2026-05-22-shape-c-handler-slice-delta.md` | this file | This doc. |
| **Subtotal added** | **549 (src+test)** | |

### Modified

| File | Net Δ LOC | Why |
|---|---:|---|
| `packages/runtime/src/workflow-engine/tool-execution/runtime-tool-use-executor.ts` | +5 | Tightened `RuntimeToolUseExecutorService.execute` to drop the vestigial `WorkflowEngine \| WorkflowInstance` from the return type's R channel. The existing `RuntimeToolUseExecutorLive` implementation already captures and provides its real deps (`AgentToolHost`, `RuntimeChannelRouter`, `RuntimeAgentToolExecution`, `RuntimeObservationStreams`) at layer construction; the wider type was unused declaration debt from the workflow-body-only call era. Tests + the live impl + the firelab sim impl all satisfy the narrower type with no other change. This is the single load-bearing reason the Shape C handler's R can name `RuntimeToolUseExecutor` without dragging `WorkflowEngine` through. |
| `packages/runtime/src/workflow-engine/workflows/runtime-context.ts` | 0 | Two existing local `type` aliases (`RuntimeContextTransitionAction`, `RuntimeContextTransitionResult`) now `export`ed so the new handler module can pattern-match action variants. No new exports beyond these; no behavior change. The wrong-shape body remains intact pending the composition-rewire sibling slice. |

### Subtotal: net `+554` LOC against the baseline.

A net-positive delta in this slice alone is expected per the operating plan
("any positive movement names the target-shaped capability it adds"): the
+554 names the target-shaped Shape C handler (replacement for the
context-lifetime body) and its tests. The Wave 1 cumulative delta becomes
negative when the composition-rewire slice lands and the deletions in the next
section follow it.

## What becomes deletable, and what unblocks each deletion

Every entry below is **made unreachable by**, not by this slice alone, but by
the small sibling composition-rewire slice that:

1. Constructs and provides a layer that drives `handleRuntimeContextEvent` per
   event from existing typed sources (`RuntimeAgentOutputAfterEvents.forContext`
   for output, intent dispatcher for input, ToolCallWorkflow result fanout for
   ToolResult).
2. Removes the `RuntimeContextWorkflowNativeLayer` provision from host
   composition (the layer that registers the wrong-shape body with the workflow
   engine).

Once that slice lands, the symbols/files below have no callers and can be
deleted in the same PR per operating-plan Rule 3.

### Inside `packages/runtime/src/workflow-engine/workflows/runtime-context.ts` (928 LOC today)

| Symbol | Lines | Deletable after composition rewire? |
|---|---:|---|
| `runMergedEventLoop` | 805–869 | yes — the entity-lifetime while loop. |
| `runWorkflowNativeRuntimeContext` | 871–898 | yes — top-level workflow body driver. |
| `RuntimeContextWorkflowNative` | 900–906 | yes — `Workflow.make` identity for the body. |
| `RuntimeContextWorkflowNativeLayer` | 908–928 | yes — registers the body with the workflow engine. |
| `handleRuntimeContextEvent` (in-body version) | 766–803 | yes — superseded by `agent-event-pipeline/subscribers/runtime-context/handler.ts`. |
| `transitionRuntimeContextEventActivity` | 640–680 | yes — the Activity wrapper around the pure transitions. Pure transitions move; the Activity-memoization wrapper retires. |
| `transitionActivityName` | 613–626 | yes — Activity name builder used only by the wrapper above. |
| `awaitNextRuntimeContextEvent` | 751–764 | yes — uses `DurableDeferred.await`. |
| `awaitRuntimeInput` / `completedRuntimeInput` | 208–250 | yes — `DurableDeferred` mailbox boundary. |
| `inputWaitName` / `runtimeInputDeferredName` / `runtimeInputDeferredFor` | 189–206 | yes — `DurableDeferred` naming for the mailbox. |
| `runToolUseActivity` | 340–369 | yes — Activity wrapper; Shape C calls `executor.execute` directly. |
| `RuntimeContextWorkflowSession`, `RuntimeContextWorkflowSessionService`, `RuntimeContextSessionCommand*`, `RuntimeContextSessionStartedEvidence*` | 66–124 | yes — body-scoped session command surface; Shape C dispatches through `AgentSession.send` directly. |
| `RuntimeContextWorkflowExecutionEnv` | 127–135 | yes — captured-env type used only by the body's deferred provider. |
| `startSessionActivity` / `sendSessionActivity` | 137–187 | yes if no other caller — the Activity wrappers around session.send become a direct call in Shape C. (Confirm no kernel callers before deletion.) |
| `completedRuntimeContextEvent` | 718–749 | yes — replay-path event reader, only the body uses it. |
| `eventAlreadyProcessed` | 710–716 | yes — Shape C handler has its own typed-event version inline. |
| **PURE TRANSITIONS — KEEP**: `transitionInputEvent` (508–551), `transitionOutputEvent` (554–611), `decodeRuntimeInputEvent` (371–390), `withoutPermissionRequest`/`withPermissionRequest`/`withoutPermissionResponse`/`withPermissionResponse` (479–505), `toolExecutionFailed`/`toolErrorResult` (303–338), `RuntimeContextTransitionAction*`, `RuntimeContextTransitionResult*`, `RuntimeAgentOutputObservationSchema`. | — | These are the pure transforms / shape-neutral helpers the Shape C handler depends on. They should move to a `transforms/` location per the type-boundaries doc (§"Physical Tree Guidance") in the same composition-rewire slice; deletion here = relocation, not removal. |

**Indicative file LOC after the deletion**: from 928 to ≈ 320 (pure transforms +
schemas, no body). Likely fully removed once the transforms relocate to
`packages/runtime/src/transforms/` per the type-boundaries doc.

### Whole-file deletions made unreachable by the composition rewire

| File | LOC | Why |
|---|---:|---|
| `packages/runtime/src/workflow-engine/runtime-input-deferred.ts` | 171 | The per-sequence `DurableDeferred` input mailbox is the artifact Shape C replaces. Its only consumer is `runtime-context.ts`'s `awaitRuntimeInput` (above). |

### Major refactor (not whole-file delete) made obsolete by the composition rewire

| File | LOC | Disposition |
|---|---:|---|
| `packages/runtime/src/kernel/runtime-context-workflow-runtime.ts` | 429 | Three concerns mix here today: (a) `RuntimeInputIntentDispatcher` (the host-scoped intent → row dispatcher; KEEP, becomes the input-side event feed for Shape C); (b) reconcile-on-startup that re-issues `deferredDone` per intent (DELETE — the deferred-mailbox bridge); (c) workflow-execution lifecycle bookkeeping (KEEP if still load-bearing for Shape D subscribers, else trim). The composition-rewire slice owns this split. |

### Tightening already shipped here (no follow-up needed)

- `RuntimeToolUseExecutorService.execute` no longer declares `WorkflowEngine | WorkflowInstance` in its return-type R. This was the single load-bearing surface fix the Shape C handler's R channel hinges on; it lands with this slice per operating-plan Rule 4 (guards/invariants land with the behavior they protect).

## Why deletion waits (operating-plan Rule 3)

Operating plan Rule 3: "Deletion belongs with proof. If your slice makes old
code unreachable, delete that old code in your slice or report exactly why
deletion must wait."

This slice **does not** make `RuntimeContextWorkflowNative` and friends
unreachable. The wrong-shape body is still registered in host composition via
`RuntimeContextWorkflowNativeLayer`; production code paths still run through
it. The composition-rewire slice — small, additive, well-scoped — is the one
that makes the deletions safe. Deleting here without that slice would break
the host composition's typecheck and runtime.

The composition-rewire slice's contract is named in §"What becomes deletable",
and the deletions are enumerated above so that slice can absorb them in one
coherent PR per operating-plan Rule 1 (Wave 1 lands as one coherent merge).
This is not a bridge slice (Rule 6); nothing here exists to keep the wrong
shape alive — every symbol added is target-shaped.

## Guards (Rule 4)

The handler's tightened R channel is testable today (the three tests assert
state advance, reload idempotency, and tool roundtrip), and the executor's
service-interface tightening is type-system-enforced for every existing caller.

Two named follow-up guards belong with the composition-rewire slice that
lands the deletions:

1. **Semgrep / typecheck guard**: PR #683 lands the `firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber` rule scoped to `/packages/runtime/src/agent-event-pipeline/subscribers/runtime-context/**/*.ts`, which covers this handler's path. (Cross-PR reconciliation: this slice was originally landed under `packages/runtime/src/subscribers/C-runtime-context/` per the doc's "Physical Tree Guidance"; the integration owner picked #683's canonical landing zone as the single target, and this slice moved there to sit under the guard. No transitional dual topology remains.)
2. **Negative-line ratchet**: once the composition rewire lands and the deletions follow, the cumulative line/module delta against the baseline must become negative (operating plan Wave 5 entry gate). Hook the ratchet into `pnpm run verify`.

## Coordination with CC1

No CC1 prototype helper exists on this branch (no `*subscriberFromSnapshot`,
no shape-specific helpers under `subscribers/`). The handler's signature
matches the type-boundaries doc §Shape C exactly, with one explicit deviation:
the doc's `handleRuntimeContextEvent(context, event)` is shipped here as
`handleRuntimeContextEvent(context, activityAttempt, event)`. Reason:
`RuntimeContextStateStore.load`/`save` keys on `(contextId, activityAttempt)`
today; until the kernel-allocated attempt becomes context-private, it must be
threaded into the handler. When CC1's subscriber helper / kernel slice lands,
the explicit param can drop.

## How to verify

```bash
git fetch origin rearch/shape-c-cutover
git checkout sidecar/shape-c-runtime-context-handler

# focused tests (3/3 green)
pnpm --filter @firegrid/runtime exec vitest run test/subscribers

# package typecheck
pnpm --filter @firegrid/runtime exec tsc --noEmit

# repo-wide typecheck (no rebase-induced ripples)
pnpm -r exec tsc --noEmit
```
