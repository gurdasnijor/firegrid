# Workflow Engine API Gap Audit

Date: 2026-05-13

Scope: read-only architecture spike for
`firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.*`,
`firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.*`, and future
`firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.*`.

Context:

- `docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md`
- `features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`
- `packages/runtime/src/workflow-engine/internal/engine-runtime.ts`
- `packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts`

## Summary

Phase 1 can delegate `startRuntime(contextId)` into a
`RuntimeContextWorkflow`, but the implementation should use the current
`@effect/workflow` deterministic idempotency mechanism rather than passing an
explicit `executionId` option to public `Workflow.execute`.

Future `HostWorkflow` child initiation has a real adapter gap:
`execute(..., { discard: true })` is fire-and-forget in upstream workflow
memory semantics, but Firegrid's Durable Streams adapter currently joins the
workflow fiber in the discard branch. Fixing that adapter behavior is the
smallest API move.

Activity-claim hardening should remain workflow-engine-internal first. Remove
the fixed polling loop and remove the silent local-winner fallback before
activity claims become the runtime side-effect fence.

## Phase 1: `startRuntime` Delegation

The current public workflow API supports stable deterministic execution ids,
but not the exact option shape shown in the workflow-driven runtime SDD.

- `Workflow.execute(payload, options?)` only accepts `discard` at
  `packages/runtime/node_modules/@effect/workflow/src/Workflow.ts:110`.
- `Workflow.make` computes execution ids from workflow name plus
  `idempotencyKey(payload)` at
  `packages/runtime/node_modules/@effect/workflow/src/Workflow.ts:263`.
- `Workflow.executionId(payload)` exposes that deterministic id at
  `packages/runtime/node_modules/@effect/workflow/src/Workflow.ts:354`.
- The SDD snippet passes `{ executionId, discard }` to public
  `RuntimeContextWorkflow.execute` at
  `docs/proposals/SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md:620`.
  That option shape is not currently supported.

Recommendation:

Use `RuntimeContextWorkflow.idempotencyKey` as the stable key source and call
`RuntimeContextWorkflow.executionId({ contextId })` whenever the code needs to
poll/resume/inspect the concrete execution id. For example, choose whether the
idempotency key is `contextId` or `runtime-context:${contextId}` and treat the
resulting upstream hash as the durable execution row id.

This is only a blocker if Phase 1 requires
`WorkflowEngineTable.executions.executionId === contextId` literally. If a
stable deterministic id is acceptable, the existing API is enough for Phase 1
delegation.

The existing `startRuntime` still directly owns runtime side effects and run
evidence in `packages/runtime/src/runtime-host/index.ts:223`. That body needs
to move under a `runRuntimeContext` activity to satisfy
`firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.1`,
`firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.3`, and
`firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.4`.

## HostWorkflow Child Initiation

`Workflow.execute(..., { discard: true })` is not currently usable as
fire-and-forget child workflow initiation with Firegrid's Durable Streams
workflow engine adapter.

Upstream behavior:

- Public discard execution returns the execution id after the encoded engine
  execute call returns at
  `packages/runtime/node_modules/@effect/workflow/src/WorkflowEngine.ts:365`.
- The upstream in-memory engine returns immediately when `options.discard` is
  true at
  `packages/runtime/node_modules/@effect/workflow/src/WorkflowEngine.ts:565`.
- Upstream tests advance the test clock after discard returns in
  `repos/effect/packages/workflow/test/WorkflowEngine.test.ts:14` and
  `repos/effect/packages/workflow/test/WorkflowEngine.test.ts:28`.

Firegrid adapter behavior:

- The Durable Streams adapter resumes/forks the workflow at
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:174`.
- Its discard branch joins the running fiber at
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:176`.

That means discard returns only after the workflow completes or suspends. A
future `HostWorkflow` that starts a `RuntimeContextWorkflow` with discard would
still serialize behind a child runtime if the child remains in a live activity.

The current Firegrid tests use discard for workflows that quickly suspend on
`DurableClock` or a deferred:

- `packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts:355`
- `packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts:411`
- `packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts:463`

Those tests do not prove non-suspending child initiation.

## Smallest API Move

Recommended first move: fix the Durable Streams adapter to match upstream
discard semantics. After the execution row is created and `resume` has forked
the workflow, the discard branch should return immediately. Public
`Workflow.execute(..., { discard: true })` will then return the stable
execution id through upstream `makeUnsafe`.

If the team wants a clearer Firegrid-facing name, the smallest addition is a
narrow initiation helper over the existing workflow value:

```ts
initiate(workflow, payload): Effect.Effect<string, never, WorkflowEngine>
```

The helper should create or resume the deterministic workflow execution and
return the execution id without joining.

Avoid broad additions:

- no public workflow-name registry;
- no `executeByName`;
- no durable consumer/projection replacement.

Those boundaries are explicit in
`firegrid-workflow-driven-runtime.BOUNDARIES.4`.

`resumeOnly(workflow, executionId)` is not enough for first child starts
because it cannot create the execution row. `executeDetached` would mostly be
a clearer alias for fixed discard semantics.

## Activity-Claim Hardening

The current activity-claim path is load-bearing if
`runRuntimeContext` becomes the runtime side-effect fence.

Current risky points:

- `waitForActivityClaim` polls every 10 ms at
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:73`.
- `claimActivity` silently reports the local row as winner if materialization
  never shows the claim row at
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:102`.
- `activityExecute` runs the activity body when the claim worker id matches at
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:234`.

Minimal changes:

1. Keep the deterministic producer/claim-key fence in
   `appendActivityClaimInsert` at
   `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:43`.
2. Use append materialization acknowledgement instead of fixed sleeps.
   `DurableTableService.awaitTxId` already exists at
   `packages/effect-durable-operators/src/DurableTable.ts:154`, and generated
   table writes already use txid plus await at
   `packages/effect-durable-operators/src/DurableTable.ts:380` and
   `packages/effect-durable-operators/src/DurableTable.ts:407`.
3. After append acknowledgement or duplicate/conflict handling, read the claim
   once and return the materialized winner.
4. Remove the local-winner fallback. If the claim row cannot be observed, fail
   or suspend explicitly. Do not run the local activity body.
5. Keep loser behavior as `Workflow.Suspended`.

This should remain workflow-engine-internal first. The Durable Claim proposal
says activity claims may later consume `DurableClaim`, but it also calls out
the workflow-driven runtime path as internal hardening first in
`docs/proposals/PROPOSAL_DURABLE_CLAIM_PRIMITIVE_2026-05-13.md:169` and
`docs/proposals/PROPOSAL_DURABLE_CLAIM_PRIMITIVE_2026-05-13.md:384`.

## Tests To Add Or Change

Phase 1 runtime-context workflow tests:

- Change existing `startRuntime` integration coverage to run through
  `FiregridRuntimeHostWithWorkflowLive`, not only `FiregridRuntimeHostLive`.
  The current launch test provides `FiregridRuntimeHostLive` at
  `packages/runtime/src/runtime-host/start-runtime.test.ts:85`.
- Assert `WorkflowEngineTable.executions` has the deterministic
  `RuntimeContextWorkflow.executionId({ contextId })` row.
- Add concurrent duplicate `startRuntime({ contextId })` calls against the same
  namespace. Prefer two worker ids if the test can cheaply compose two engine
  layers. Assert one `runRuntimeContext` activity side effect, one activity
  claim, and shared terminal exit evidence.
- Add replay-after-completion coverage: a second `startRuntime(contextId)`
  returns the stored workflow result and does not allocate a second attempt or
  start a second process.
- Add an explicit execution-id expectation to document whether the execution
  table key is the upstream deterministic hash or a future raw-context-id API.

HostWorkflow child initiation tests:

- Add a workflow-engine adapter test where a parent workflow starts a child
  with `{ discard: true }`, then immediately records/returns before a
  non-suspended child activity is allowed to complete. This should fail before
  fixing `engine-runtime.ts:176`.
- Add a multi-child host-style test: parent initiates child A and child B;
  child A blocks in a long activity, but child B's execution row still appears.
- Add duplicate child initiation/resume coverage with the same payload and
  idempotency key: one execution row and one child activity claim.

Activity-claim hardening tests:

- Add a fault-injection or fake-table test for claim append/materialization
  failure. The activity body must not run when the claim row cannot be
  observed.
- Strengthen the existing raced-activity test at
  `packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts:492`
  so the losing worker suspends/observes rather than locally executing after a
  missing materialization window.

## Recommended Sequence

1. Fix and test Durable Streams `discard` semantics first. This unblocks future
   `HostWorkflow` without broadening the public API.
2. For Phase 1, use `RuntimeContextWorkflow.idempotencyKey` plus
   `RuntimeContextWorkflow.executionId({ contextId })`; do not pass
   `{ executionId }` to public `Workflow.execute` unless a narrow API is
   intentionally added.
3. Move the current `startRuntime` side-effect body into the
   `runRuntimeContext` activity and make `startRuntime` call
   `RuntimeContextWorkflow.execute({ contextId })` without discard so Phase 2
   sync run can block naturally.
4. Add duplicate `startRuntime` tests before merging Phase 1.
5. Harden activity claims internally with materialization acknowledgement and
   no local fallback before treating activity claims as the broad runtime
   side-effect fence.
