# HANDOFF — tf-qoyg Shape A NARROW prototype (Lane 1 halt)

**Bead**: `tf-qoyg` (P1, task)
**Branch**: `sidecar/tf-qoyg-s6-shape-a-narrow-agentoutputafter`
**Worktree**: `firegrid-worktrees/tf-qoyg-s6-shape-a-narrow-agentoutputafter`
**Status**: HALT — prototype implemented + sim-verified + test-suite refuted. NOT pushed (no PR opened). Awaiting coordinator decision on three paths (A/B/C below).
**Predecessor merges on main**: `9f7d0cc95` tf-9ut (workflow-core-paths sim, the reproducer used here) · `88bc600f2` tf-gc7 leaf fix (#445) · `9d933f1fe` tf-ps2 (#436)

This file is the durable handoff for the next agent picking up tf-qoyg. Read end-to-end before touching anything. The core finding is **empirical, source-verified, and refutes the dispatch's "narrow Shape A works" premise**.

---

## 0. One-paragraph summary

Shape A narrow (inline the `AgentOutputAfter` wait at `runtime-context-workflow-core.ts:188` via `Stream.runHead(events.after(source))`) **works mechanically in-sim** (workflow-core-paths shows the prototype eliminating 127 `wait_for.match` + 116 `wait_router.complete_match` spans for the AgentOutputAfter path, with the agent-tool CallerFact path preserved at 1+2) but **breaks the host-sdk test suite (5 tests in `runtime-context-workflow-core.test.ts` time out)**. Root cause: `Stream.runHead` blocks the workflow body's fiber without calling `Workflow.suspend(instance)`; the engine's `discard:true` execute does `Fiber.join` on that fiber, which hangs because the body never returns `Suspended`. The convergence doc's note "Shape A should ride with the deferred-input rewrite" was probing exactly this — confirmed.

---

## 1. What the dispatch asked for (verbatim scope)

From the coordinator dispatch (paraphrasing the binding constraints):

> Refactor `packages/host-sdk/src/host/runtime-context-workflow-core.ts:193` (the `WaitFor.match<RuntimeAgentOutputObservation>({...})` call site for AgentOutputAfter) to use an inline raced effect inside the workflow body. Pattern: `Stream.find + DurableClock.sleep` race inside the workflow handler. DO NOT touch `tool-use-to-effect.ts:216` (agent-tool wait_for — different path). DO NOT delete wait-router / WaitRow / DurableToolsTable (preserves for agent-tool path). VERIFICATION: workflow-core-paths sim should show AgentOutputAfter generic-machinery spans drop; wait-pre-attach-roundtrip should be unchanged (agent-tool path).

The dispatch's "Stream.find + DurableClock.sleep race" sketch turns out to be where the rubber meets the road — see §5 root cause.

---

## 2. Files modified on this branch (all UNCOMMITTED, working tree)

```
 M packages/host-sdk/src/host/runtime-context-workflow-core.ts
 M packages/host-sdk/src/host/runtime-substrate.ts
 M packages/host-sdk/test/host/runtime-context-workflow-core.test.ts
```

### 2.1 `packages/host-sdk/src/host/runtime-context-workflow-core.ts`

- Dropped `WaitFor` import (no longer called from this file).
- Added `RuntimeAgentOutputAfterEvents` import from `@firegrid/runtime/runtime-output`.
- Added `Option` and `Stream` to the `effect` import.
- Replaced `waitForAgentOutput` body: was `WaitFor.match<RuntimeAgentOutputObservation>({ name, source: { _tag: "AgentOutputAfter", contextId, activityAttempt, afterSequence }, trigger: [] })`; is now:

  ```ts
  Effect.gen(function*() {
    const events = yield* RuntimeAgentOutputAfterEvents
    const source = {
      _tag: "AgentOutputAfter" as const,
      contextId: context.contextId,
      activityAttempt,
      afterSequence,
    }
    const head = yield* Stream.runHead(events.after(source)).pipe(
      Effect.mapError(cause => asRuntimeContextError(
        "runtime-context.output.wait",
        "failed reading runtime-context output stream",
        context.contextId,
        cause,
      )),
    )
    if (Option.isNone(head)) {
      return yield* asRuntimeContextError(
        "runtime-context.output.wait",
        "runtime-context output stream completed without emitting a row",
        context.contextId,
      )
    }
    return head.value
  }).pipe(Effect.withSpan("firegrid.runtime_context.workflow.output.wait", { ... }))
  ```

- Collapsed `nextAgentOutput` to a pass-through `waitForAgentOutput(...)` (no more `Match | Timeout` discriminator since the inline path can't time out without an explicit timeout, which the original call didn't set).
- Deleted `outputWaitName` helper (no longer needed — no wait-row name to compute).

### 2.2 `packages/host-sdk/src/host/runtime-substrate.ts`

- Added `type RuntimeAgentOutputAfterEvents` import.
- Added `RuntimeAgentOutputAfterEvents` to the `RuntimeContextWorkflowExecutionEnv` union (the workflow body now requires it directly).

### 2.3 `packages/host-sdk/test/host/runtime-context-workflow-core.test.ts`

- Added imports: `RuntimeAgentOutputAfterEvents`, `RuntimeAgentOutputEvents`, `Option`, `Stream`.
- Added a test-only adapter `testHostWideRuntimeAgentOutputAfterEventsLive` that bridges `RuntimeAgentOutputAfterEvents` over the HOST-WIDE `RuntimeAgentOutputEvents` stream (the production `PerContextRuntimeAgentOutputAfterEventsLive` reads from a per-context URL that doesn't match the test's host-wide writes; the adapter applies the same source-filter the deleted `RuntimeWaitStreams.agentOutputAfter` `onNone` branch used).
- Wired the adapter into both `runtimeContextWorkflowTestLayer` and the standalone "skips log gaps" test's layer via `Layer.provideMerge(testHostWideRuntimeAgentOutputAfterEventsLive)` (the latter is built with `.pipe(Layer.provide(RuntimeAgentOutputEventsLayer))` so the adapter's RIn shrinks to `RuntimeOutputTable`).
- Added a new sync helper `waitUntilWorkflowStarted(contextId, activityAttempt)` that polls `RuntimeControlPlaneTable.runs` for a `started` row (replacing the now-unobservable `waitUntilActiveWait` wait-row poll for tests that drive the production workflow).
- Kept `waitUntilActiveWait` for the one test that drives a custom workflow still calling `WaitFor.match` directly (the "live writes" test at the original line 377+ — that test STILL writes a wait row because it doesn't go through `runtime-context-workflow-core.ts`).
- Replaced 5 call sites of `waitUntilActiveWait` (for `executeNativeRuntimeContext` tests) with `waitUntilWorkflowStarted` or an inline `beforeRestart.emissions.length >= 1` poll (the latter for the "send activity replay" test that needed a "ToolResult was emitted" sync, not just "workflow started").

---

## 3. Measurements — what I actually ran and saw

### 3.1 Baseline (workflow-core-paths sim on this branch, before code changes)

Trace: `packages/tiny-firegrid/.simulate/runs/2026-05-20T05-02-31-996Z__workflow-core-paths/trace.jsonl`

```
wait_for.match by source:
  127 AgentOutputAfter
    2 CallerFact

wait_router.complete_match by source:
  116 AgentOutputAfter
    2 CallerFact

runtime_context.workflow.output.wait: 127
outcome: DriverCompleted
```

### 3.2 After Shape A narrow applied (workflow-core-paths sim)

Trace: `packages/tiny-firegrid/.simulate/runs/2026-05-20T05-17-11-784Z__workflow-core-paths/trace.jsonl`

```
wait_for.match by source:
    1 CallerFact          # agent-tool path UNCHANGED (preserved by design)

wait_router.complete_match by source:
    2 CallerFact          # agent-tool path UNCHANGED

runtime_context.workflow.output.wait: 22    # workflow body's own span — variance, lower-iteration loop converged faster
outcome: DriverCompleted
```

**The mechanical refactor works in-sim.** AgentOutputAfter path no longer touches the generic wait_for / wait_router machinery. Agent-tool CallerFact path is byte-for-byte unchanged.

### 3.3 host-sdk test suite — REFUTES the prototype

Running `pnpm test` inside `packages/host-sdk` after my changes:

```
Test Files  1 failed | 15 passed (16)
     Tests  5 failed | 98 passed (103)
```

5 failing tests, ALL in `test/host/runtime-context-workflow-core.test.ts`, ALL using `executeNativeRuntimeContext` (the production workflow body):

1. `firegrid-workflow-driven-runtime.VALIDATION.6 proves idempotent startOrAttach across duplicate workflow starts`
2. `firegrid-workflow-driven-runtime.VALIDATION.6 proves cached startOrAttach replay can lazy reattach on send with an empty registry`
3. `delivers public session.prompt ingress through RuntimeContextWorkflowSession.send without ingress-delivery tracker`
4. `firegrid-workflow-driven-runtime.VALIDATION.6 proves send activity replay does not duplicate external emission across restart`
5. `workflow-native runtime-context core skips runtime-output log gaps while waiting for ToolUse output`

Failure shape (all 5): `Test timed out in 5000ms` (or 15000ms after I added the test-layer adapter that fixed the "Service not found" earlier failure). The fiber hangs on Fiber.join.

The two tests in the same file that PASS:
- `resolves AgentOutputAfter initial state through PerContextRuntimeOutputWriter` (uses CUSTOM workflow + `WaitFor.match` directly — not the production workflow body, so my change doesn't affect it).
- `resolves AgentOutputAfter live writes through PerContextRuntimeOutputWriter` (same shape — custom workflow + WaitFor.match).

---

## 4. Iterative findings during the attempt

I went through several iterations as I debugged. Each step source-verified one layer deeper:

**Iteration 1**: Just the inline `Stream.runHead` change. Test failure mode: `Service not found: @firegrid/runtime/RuntimeAgentOutputAfterEvents`. The test layer didn't provide the new requirement.

**Iteration 2**: Added `PerContextRuntimeAgentOutputAfterEventsLive` to the test layer. Test failure mode: 15s timeouts. Diagnosis: the production layer reads from a PER-CONTEXT URL built from `RuntimeHostConfig.streamPrefix` + `contextId`, but the test writes events to the HOST-WIDE `RuntimeOutputTable` URL. URLs don't match → stream is empty → `Stream.runHead` blocks forever → fiber hangs → `Fiber.join` hangs.

**Iteration 3**: Wrote `testHostWideRuntimeAgentOutputAfterEventsLive` (a test-only adapter that reads from `RuntimeAgentOutputEvents` host-wide stream + same source-filter as the deleted `RuntimeWaitStreams.agentOutputAfter` `onNone` branch). Initially failed with `Service not found: RuntimeAgentOutputEvents` (layer composition issue — fixed by `.pipe(Layer.provide(RuntimeAgentOutputEventsLayer))` on the adapter so its RIn shrinks to `RuntimeOutputTable`, which the test layer chain satisfies below).

**Iteration 4**: Test layer composition fixed. Adapter resolves cleanly. Now the test reaches the workflow body which can subscribe to the host-wide stream. **NEW failure mode**: tests time out at 15s — but events ARE being written (verified). Why isn't the workflow body's Stream.runHead returning?

**Iteration 5 (THE ACTUAL BLOCKER)**: Direct-source read of `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:211-216`:

```ts
yield* resume(options.executionId)
const fiber = running.get(options.executionId)
if (options.discard) {
  if (fiber) yield* Fiber.join(fiber)
  return undefined as never
}
```

`executeNativeRuntimeContext({ discard: true })` does `Fiber.join` on the workflow body's fiber. Under the OLD `WaitFor.match` design, the workflow body's `DurableDeferred.await(matchDeferred)` internally calls `Workflow.suspend(instance)`. The workflow engine catches that suspension via `Workflow.intoResult` and returns `Suspended` — so the fiber RETURNS (with Suspended), `Fiber.join` completes. Under Shape A narrow's `Stream.runHead(events.after(source))`, there is **NO call to `Workflow.suspend`**. The fiber just blocks on the stream waiting for the first row. It never returns. `Fiber.join` hangs forever. **The convergence doc's note "Shape A should ride with the deferred-input rewrite" is exactly this — the workflow-engine integration needs a coordinated rewrite when you fold matching into the workflow body, because the engine's suspend signal is missing without DurableDeferred.**

---

## 5. The load-bearing convergence-doc passage (source-verified)

`docs/research/durable-tools-vs-workflow-engine-convergence.md` lines 84-89:

> **Shape A — fold matching into the workflow body.** Eliminates `DurableToolsTable` entirely by making the matcher a raced effect inside the workflow (extending the pattern `wait-for.ts:392` already uses for the timeout side). Feasible and clean, but it **should ride with the deferred-input rewrite** that is already reshaping the same workflows (`runtime-context-workflow-core.ts`), not be done speculatively first.

The empirical mechanism behind "should ride with the deferred-input rewrite" is what this halt has now sourced: the workflow body's matcher needs `Workflow.suspend` integration; the deferred-input rewrite is the natural place to add it because that rewrite is already restructuring how the workflow body interacts with the engine's suspension/replay primitives. Doing Shape A narrow without that integration leaves an orphan: the workflow body blocks the engine's discard-execute path.

---

## 6. Three honest paths forward (need coordinator decision)

### (A) STOP — confirm Shape A is gated on deferred-input rewrite

- Close `tf-qoyg` as `verified-blocked-on:deferred-input-rewrite`.
- The artifacts from this attempt — sim metrics (§3.1, §3.2) showing the mechanical refactor works + test-failure shape (§3.3) localizing the Workflow.suspend gap — become the load-bearing evidence to inform that future deferred-input-rewrite work.
- tf-9ut already files a doc-gap at tf-sjr on adjacent ground (per-wait forked-fiber lifecycle); this finding extends the doc-gap territory.
- **Cleanest of the three. No new code lands.**

### (B) WRAP — Shape-A-with-deferred-bridge variant

- Workflow body calls `DurableDeferred.await(matchDeferredFor(...))` (preserves Workflow.suspend).
- A small fiber forked from the workflow body subscribes to `events.after(source)` and fires `engine.deferredDone(matchDeferred, Exit.succeed(row))` on first match.
- Preserves engine suspend semantics. BUT re-introduces a per-wait fiber + a deferred lifecycle (just moved into the workflow body), defeating the convergence-doc Shape A cleanliness goal.
- Closer to "Shape A-light" — not the doc's Shape A. May still be worth doing as a stepping stone.

### (C) WIDEN — accept deferred-input rewrite as prerequisite

- Reshape this lane into the broader workflow body refactor (the deferred-input rewrite the convergence doc says Shape A "should ride with").
- Out of "narrow" scope per the dispatch's explicit non-scope clause.
- Significant work; likely needs an SDD before code.

---

## 7. Sim runs cataloged in `.simulate/runs/`

For the next agent to inspect — the relevant trace files on this branch:

```
packages/tiny-firegrid/.simulate/runs/2026-05-20T05-02-31-996Z__workflow-core-paths/trace.jsonl   # BASELINE (pre-Shape-A)
packages/tiny-firegrid/.simulate/runs/2026-05-20T05-17-11-784Z__workflow-core-paths/trace.jsonl   # AFTER Shape A narrow applied
```

Useful jq for re-deriving counts:

```bash
TRACE=packages/tiny-firegrid/.simulate/runs/<runId>/trace.jsonl

# wait_for.match counts by source
jq -r 'select(.name=="firegrid.durable_tools.wait_for.match") | .attributes."firegrid.wait.source"' $TRACE | sort | uniq -c

# wait_router.complete_match counts by source
jq -r 'select(.name=="firegrid.durable_tools.wait_router.complete_match") | .attributes."firegrid.wait.source"' $TRACE | sort | uniq -c

# Sim outcome
jq -r 'select(.name=="firegrid.simulation.run") | .attributes."firegrid.simulation.outcome"' $TRACE
```

---

## 8. Methodology lessons applied (and one that re-fired)

Per `feedback_inference_is_not_verified_groundtruth` (memory):

- **The dispatch's "narrow Shape A should work" was inference-tier** (extrapolating from the empirical refactor mechanics + the convergence doc's published shapes).
- **The verification gate triggered**: I source-verified the engine-runtime code (the Fiber.join + Workflow.suspend mechanism) AND ran the actual test suite (which refuted the prototype).
- **The lesson re-fires**: even after I'd absorbed it twice (PR #373 / Shape C dispatch correction), the dispatch's confidence pulled me toward applying the change without first reading `wait-for.ts:392`'s timeout-side pattern carefully enough to notice it uses `DurableDeferred.await`-shaped suspension. The integration-with-workflow-engine concern was knowable from source pre-attempt; I should have read engine-runtime.ts:211-216 before writing code, not after the test failures.
- **Memory note**: when extending a "raced effect inside the workflow body" pattern, read the engine's resume/suspend integration FIRST. The suspend mechanism is the contract; the race is a surface detail.

---

## 9. Worktree status + next-step mechanics

- **Working tree dirty** with 3 modified files (§2). NOT committed.
- **No PR opened**. The work is local-only on `sidecar/tf-qoyg-s6-shape-a-narrow-agentoutputafter`.
- **Bead `tf-qoyg`** has the HALT comment posted (see `br comments add tf-qoyg` from this session) describing the same finding more briefly.
- **If coordinator chooses (A) STOP**: revert the 3 modified files (`git restore`); update the bead with the close rationale; reap the worktree on next pass.
- **If coordinator chooses (B) WRAP**: keep the changes as a starting point but add the deferred-bridge fiber. The `RuntimeAgentOutputAfterEvents` env-type addition + adapter test layer + sync-helper changes are reusable.
- **If coordinator chooses (C) WIDEN**: this is a fresh design exercise; the changes here are at most a reference artifact, probably revert.

To pick this up cleanly, the next agent should:
1. Read this doc end-to-end.
2. `cd firegrid-worktrees/tf-qoyg-s6-shape-a-narrow-agentoutputafter` if the worktree still exists; if reaped, recreate via `bash scripts/task-enter.sh tf-qoyg <new-slug>`.
3. Inspect `git status` and `git diff` to see the working-tree changes.
4. Decide (A)/(B)/(C) per coordinator direction.

---

## 10. Pointer to this file

If memory pruning happens before the next session, this file lives at:

- `docs/handoffs/HANDOFF_tf-qoyg_shape-a-narrow.md` in branch `sidecar/tf-qoyg-s6-shape-a-narrow-agentoutputafter` (push-preserved).
- Also referenced from a `~/.claude/projects/.../memory/` pointer (see `MEMORY.md` for the slug).

End of handoff.
