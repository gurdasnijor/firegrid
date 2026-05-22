# Kernel-owned write+arm

Status: canonical architecture direction (validated by tiny-firegrid reference)
Date: 2026-05-22
Beads: tf-c9r9 (this), supersedes the tf-12q9 engine-sweep approach
Reference sim: `packages/tiny-firegrid/src/simulations/kernel-owned-write-arm/`

## §0 — The load-bearing decision

**Restart recovery of a workflow that is parked waiting for input is owned by a
single serialized host-kernel/controller that replays its OWN durable write+arm
facts — NOT by a generic engine sweep that resumes every suspended execution.**

The kernel writes the workflow-owned input row and arms (resumes) the owning
execution as one durable control step, recording that pair as a fact it owns. On
restart it replays only its own pending facts and re-drives exactly those
executions. This is sound; a generic engine-level "resume all suspended" sweep is
not.

## Why the generic engine sweep is unsound (tf-12q9 evidence)

A workflow parked on a `DurableDeferred.await` and a workflow parked on a
table-wait `Workflow.suspend` are **indistinguishable at the engine-row level**:
vendored `repos/effect/packages/workflow/src/DurableDeferred.ts:116-119` shows
`DurableDeferred.await` *is* `Workflow.suspend(instance)` when the deferred is
unresolved, and the `WorkflowExecutionRow` records only `suspended` /
`interrupted` / `cause` — nothing about *what* a suspension waits on.

So an engine sweep that "resumes all suspended executions" necessarily also
resumes deferred-awaits, injecting a concurrent body fiber that races the
engine's own `deferredDone → resume` and `interrupt` paths for the same
execution. tf-12q9 demonstrated this empirically: the sweep made the S1 probes
green but regressed `tf-gyxc` (interrupt terminality) and
`deferred-done-idempotency` (first-writer-wins). It also has a registration
timing hazard: a construction-time sweep runs before workflows register, so
`resume` (which needs the execute fn) no-ops.

## The sound shape

Three properties, all validated green in the reference sim:

1. **Bounded ownership.** The kernel owns a private control table of write+arm
   facts (`{commandKey, executionId, inputKey, inputValue, status}`). Recovery
   iterates THAT table, never `engine.executions`. Executions the kernel owns no
   fact for (deferred-awaits, foreign table-waits) are never touched. The
   reference sim's Probe C asserts a parked `DurableDeferred.await` execution is
   left untouched by the replay and recovers only via its own `deferredDone`.

2. **One durable control step.** The write+arm fact is written first (the durable
   record of intent). Writing the workflow-owned input row and arming
   (`resume`) are the idempotent effects the kernel (re-)performs to satisfy the
   fact: input via `insertOrGet`; resume short-circuits on `finalResult`. A crash
   at any point leaves the fact pending; restart replays it to completion.

3. **Deterministic register → replay ordering, single serialized owner.** The
   kernel registers its workflows, then runs the replay — so `resume` always has
   the execute fn (the tf-12q9 timing hazard is gone). The kernel is the sole
   driver of write+arm for its executions, so it never forks a competing body
   fiber into an execution another path is concurrently driving.

## Non-goals / invariants

- **No input deferred mailbox.** The body parks on a workflow-owned table input
  (`Workflow.suspend`), not a `DurableDeferred` per-input mailbox. The production
  `DurableDeferred` input mailbox is a transitional bridge this direction
  retires (see the migration SDD).
- **No generic resume-all sweep.** Recovery is keyed off owned facts only.
- **No ordering authority.** Write+arm facts are independent, keyed per
  `(executionId, inputKey)`. The kernel imposes no cross-input ordering; it is
  not a sequencer.

## Authority position (today vs target)

There is **no `HostKernelWorkflow` symbol today.** The current authority position
is the `RuntimeContextWorkflowRuntimeLive` layer
(`packages/runtime/src/kernel/runtime-context-workflow-runtime.ts`), which owns
the host-scoped engine, the active-execution map, and the input dispatcher — it
holds the engine reference and the execution identity (`runtime-context:{id}`)
needed to drive write+arm. That is the *old-shape* position, not the target
implementation: today the write (edge `inputIntents.insertOrGet`) and the arm
(kernel dispatcher `deferredDone`) are split across owners and mediated by the
deferred mailbox. The target collapses write+arm into one kernel-owned durable
step over a table input. The migration SDD enumerates the cutover surface.
