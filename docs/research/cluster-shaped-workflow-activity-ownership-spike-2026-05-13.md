# Cluster-Shaped Workflow Activity Ownership Spike

Date: 2026-05-13

Scope: read-first spike for tracer 018, anchored in
`docs/tracers/018-cluster-shaped-workflow-activity-ownership.md`.

Relevant ACIDs:

- `workflow-engine-durable-state.ENGINE.4`
- `workflow-engine-durable-state.ENGINE.5`
- `workflow-engine-durable-state.RUNTIME_BOUNDARY.5`
- `workflow-engine-durable-state.RUNTIME_BOUNDARY.6`
- `workflow-engine-durable-state.VALIDATION.6`
- `firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.4`
- `firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.1`
- `firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.2`
- `firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.3`
- `firegrid-workflow-driven-runtime.VALIDATION.1`

## Executive Recommendation

Do not implement tracer 018 directly on the current `DurableTable` API.

Firegrid can likely replace the separate `activityClaims` row family with a
ClusterWorkflowEngine-style primary-keyed activity request/result model, but it
needs one spec-approved DurableTable primitive first: a primary-keyed
insert-or-observe operation with `Success | Duplicate` semantics modeled after
Cluster `MessageStorage.saveRequest`.

The next PR should be docs/spec first:

1. Amend `workflow-engine-durable-state.feature.yaml` so activity ownership is
   expressed as a persisted activity request/result row rather than a separate
   claim row.
2. Add a DurableTable ACID for primary-keyed insert-or-observe semantics.
3. Only then implement the primitive and migrate the workflow engine.

Do not build `DurableSemaphore`, `DurableKeyedMutex`, a generic dispatcher,
`executeByName`, a workflow registry, or per-message workflow activities for
stdin.

## Cluster Guarantees

`repos/effect/packages/cluster/src/ClusterWorkflowEngine.ts` does not write a
separate workflow activity claim row.

Its shape is:

- each workflow execution is a cluster entity;
- workflow `run` is a persisted RPC with primary key `""`;
- each activity attempt is a persisted RPC with primary key
  `${activityName}/${attempt}`;
- durable storage maps that semantic primary key to one request id;
- duplicate submissions observe the original request id and any prior reply;
- replies are durable activity results.

The load-bearing definitions are:

- `ActivityRpc` uses `primaryKey: ({ attempt, name }) =>
  activityPrimaryKey(name, attempt)` in
  `repos/effect/packages/cluster/src/ClusterWorkflowEngine.ts:536`.
- `activityPrimaryKey` is `${activity}/${attempt}` in
  `repos/effect/packages/cluster/src/ClusterWorkflowEngine.ts:609`.
- `MessageStorage.saveRequest` returns `SaveResult.Success |
  SaveResult.Duplicate` in
  `repos/effect/packages/cluster/src/MessageStorage.ts:151`.
- `SaveResult.Duplicate` carries `originalId` and `lastReceivedReply` in
  `repos/effect/packages/cluster/src/MessageStorage.ts:188`.
- `requestIdForPrimaryKey` recovers an existing durable request id in
  `repos/effect/packages/cluster/src/MessageStorage.ts:79`.

The important abstraction is not a mutex. It is a persisted request keyed by a
semantic primary key, with duplicate visibility and durable result lookup.

## Current Firegrid Difference

Current Firegrid workflow activity ownership has a separate claim row family:

- `WorkflowActivityRowSchema` stores only activity result data and requires
  `result` at `packages/runtime/src/workflow-engine/internal/table.ts:28`.
- `WorkflowActivityClaimRowSchema` separately stores activity ownership at
  `packages/runtime/src/workflow-engine/internal/table.ts:37`.
- `workflowEngineSchemas.activityClaims` keeps that row family in the runtime
  table at `packages/runtime/src/workflow-engine/internal/table.ts:70`.

The runtime path is:

1. compute `activityKey = executionId/activityName/attempt`;
2. write an `activityClaims` row through a raw Durable Streams producer;
3. poll `table.activityClaims.get(...)`;
4. if the observed claim has the local worker id, run the activity body;
5. write a separate `activities` result row.

The relevant code is:

- raw producer append in
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:43`;
- 10 ms polling loop in
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:73`;
- local-winner fallback in
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:102`;
- claim acquisition inside `activityExecute` in
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:219`;
- separate loser suspension check in
  `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:234`.

That differs from Cluster because ownership is not the durable activity request
itself. Firegrid currently has one row for ownership and another row for the
activity result.

## DurableTable Assessment

Current `DurableTable` cannot express Cluster-style insert-or-observe safely
enough for production activity ownership.

What exists today:

- collection facades expose `insert`, `upsert`, `delete`, `get`, `query`, and
  `subscribe` in `packages/effect-durable-operators/src/DurableTable.ts:120`;
- `insert(row)` returns `Effect<void, DurableTableError>`;
- generated `insert` uses a random txid in
  `packages/effect-durable-operators/src/DurableTable.ts:380`;
- generated writes wait for local materialization before completing in
  `packages/effect-durable-operators/src/DurableTable.ts:388`;
- duplicate insert rejection is covered by
  `packages/effect-durable-operators/test/durable-table.test.ts:280`.

That is useful, but it is not Cluster `saveRequest`.

For activity ownership, the workflow engine needs to know one of three facts
atomically enough to decide whether it may perform an external side effect:

1. this worker inserted the request and owns the first execution attempt;
2. another request already exists, and its result is available;
3. another request already exists, but no result is available, so this worker
   must suspend/observe instead of running the side effect.

Current `insert` only gives success or failure. It does not return the existing
row, original request identity, or prior result. A local `get` then
`insert/upsert` is not an implementation because two independent workers can
make side-effect decisions from stale local views.

## Minimal Primitive

Add one narrow per-collection method to `DurableTable`, after a spec amendment:

```ts
type InsertOrObserveResult<Row> =
  | { readonly _tag: "Inserted"; readonly row: Row }
  | { readonly _tag: "Duplicate"; readonly row: Row }

insertOrObserve(row): Effect.Effect<
  InsertOrObserveResult<Row>,
  DurableTableError
>
```

Required semantics:

- derive the durable fence from the encoded collection primary key;
- do not use a random txid as the ownership identity;
- the duplicate/conflict result is visible to the caller;
- duplicate returns the currently materialized existing row;
- success and duplicate both complete only after the caller can observe the row
  in the local DurableTable view;
- implementation must not be local `get` followed by `insert` or `upsert`.

This is the DurableTable analogue of Cluster `MessageStorage.saveRequest`:

- `Success` means this caller created the durable request;
- `Duplicate` means the semantic primary key already maps to an existing
  request/result.

Naming note: `insertOrObserve` is clearer than `insertIfAbsent` for the
workflow-engine use case because the duplicate path must return enough
observed state to choose between replaying a result and suspending behind an
in-flight owner.

## Workflow Engine Target Shape

If the primitive exists, change `WorkflowActivityRow` from result-only to
request/result:

```ts
{
  activityKey: string
  executionId: string
  activityName: string
  attempt: number
  workerId: string
  requestedAtMs: number
  result?: unknown
}
```

Then `activityExecute` becomes:

```txt
activityKey = executionId/activityName/attempt

read activities[activityKey]
  if result exists -> return revived result

insertOrObserve activity request row
  Inserted -> local worker owns the request; run activity body; write result
  Duplicate with result -> return revived result
  Duplicate without result -> return Workflow.Suspended
```

No worker guesses that it won. The durable request row is the ownership record.

## Scenario Proofs For Tracer 018

Tracer 018 should add a scenario-level test under `scenarios/firegrid/`, not
only a package-internal workflow engine test.

The scenario should use production composition:

- `Firegrid.launch` or a production `RuntimeControlPlaneTable` context row;
- `startRuntime(contextId)` / `RuntimeContextWorkflow`;
- `FiregridRuntimeHostLive` or `FiregridRuntimeHostWithWorkflowLive`;
- real local-process provider;
- durable `RuntimeOutputTable` and `WorkflowEngineTable` observations.

Required proofs:

1. **Duplicate start is one side effect.** Two concurrent
   `startRuntime({ contextId })` calls against the same namespace produce one
   process start marker, one workflow result, one started/exited run attempt,
   and one set of output rows.
2. **Replay after completion is read-only.** A second
   `startRuntime({ contextId })` after terminal completion returns the stored
   workflow result and does not append another process start marker.
3. **Competing workers converge.** Two workflow engine workers with distinct
   worker identities race the same activity key and produce one activity body
   execution. The loser observes/suspends rather than running the body.
4. **No unobserved local winner.** A package-level companion test with fault
   injection or a narrow test seam proves that if ownership cannot be observed
   durably, the activity body does not execute.
5. **No separate activityClaims.** Inspect `WorkflowEngineTable`: one activity
   request/result row exists for the activity attempt, and zero
   `activityClaims` rows exist.

Existing package-level coverage proves duplicate `startRuntime` does not
duplicate process start, but it still validates the current `activityClaims`
path and is not the tracer 018 production scenario:
`packages/runtime/src/runtime-host/start-runtime.test.ts:219`.

## Deletion And Simplification Map

If the cluster-shaped model works, the following code disappears or simplifies.

Delete from `packages/runtime/src/workflow-engine/internal/table.ts`:

- `WorkflowActivityClaimRowSchema`;
- `WorkflowActivityClaimRow` type export;
- `activityClaims` entry in `workflowEngineSchemas`.

Change in `WorkflowActivityRowSchema`:

- make `result` optional;
- add request/owner evidence fields such as `workerId` and `requestedAtMs`.

Delete from `packages/runtime/src/workflow-engine/internal/engine-runtime.ts`:

- `FetchHttpClient` import;
- `DurableStream` import;
- `WorkflowActivityClaimRow` import;
- `appendActivityClaimInsert`;
- `waitForActivityClaim`;
- `claimActivity`;
- the activity claim acquisition block inside `activityExecute`;
- the local-winner fallback;
- the claim loser comparison.

Replace that block with request/result row ownership through
`table.activities.insertOrObserve(...)`.

Update tests:

- replace assertions that `activityClaims` has one row in
  `packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts:530`;
- assert zero claim rows during the transition if the schema keeps the row
  family temporarily;
- assert one activity request/result row with the expected `activityKey`;
- keep the activity body run count assertions.

Once all call sites migrate, remove the `WorkflowActivityClaimRow` public type
exports from `packages/runtime/src/workflow-engine/index.ts` and
`packages/runtime/src/index.ts`.

## Recommended PR Sequence

1. **Spec amendment PR.**
   - Amend `features/firegrid/workflow-engine-durable-state.feature.yaml`.
   - Deprecate or rewrite claim-specific requirements:
     - `workflow-engine-durable-state.ENGINE.5`
     - `workflow-engine-durable-state.VALIDATION.6`
     - `workflow-engine-durable-state.RUNTIME_BOUNDARY.5`
     - `workflow-engine-durable-state.RUNTIME_BOUNDARY.6`
   - Add an ACID for primary-keyed activity request/result ownership.
   - Amend `features/firegrid/effect-durable-operators.feature.yaml` to allow a
     DurableTable primary-keyed insert-or-observe method.

2. **DurableTable primitive PR.**
   - Add `insertOrObserve(row)` to collection facades.
   - Implement it with a substrate-level primary-key fence and duplicate
     visibility.
   - Add tests with two independently acquired table layers racing the same
     primary key and proving `Inserted`/`Duplicate` behavior plus existing row
     visibility.

3. **Workflow engine migration PR.**
   - Change activity rows to request/result rows.
   - Rewrite `activityExecute` around `activities.insertOrObserve`.
   - Remove raw Durable Streams activity-claim append code.
   - Update `DurableStreamsWorkflowEngine.test.ts`.

4. **Tracer 018 scenario PR.**
   - Add `scenarios/firegrid/src/tracer-018.test.ts`.
   - Prove duplicate start, replay after completion, competing-worker
     convergence, and no `activityClaims`.

5. **Cleanup PR if needed.**
   - Remove any transitional claim exports or compatibility rows after scenario
     coverage is green.

This sequence should not block synchronous `firegrid:run` cleanup or context
eligibility spec work. It should block production HostWorkflow fanout and any
claim that workflow activity ownership is multi-host safe.
