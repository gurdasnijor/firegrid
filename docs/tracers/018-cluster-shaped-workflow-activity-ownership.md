# 018: Cluster-Shaped Workflow Activity Ownership

## Objective

Prove that Firegrid's Durable Streams workflow engine can deliver
ClusterWorkflowEngine-style activity ownership without a separate
`activityClaims` ownership table.

The load-bearing claim is:

```txt
duplicate workflow activity attempts
  -> converge on one durable activity request key
  -> one host runs the external side effect
  -> racing hosts observe the same durable result or suspend
  -> no worker guesses that it won
```

This tracer should produce a production-shaped scenario proving those
properties through the Firegrid workflow engine adapter, not only a package
unit test of an internal helper.

## Why This Is Load Bearing

`RuntimeContextWorkflow` now uses one `runRuntimeContext` workflow activity per
runtime attempt. That activity owns the external runtime side effects: starting
the opaque execution target, bridging retained input rows into stdin/input,
observing stdout/stderr/exit, and writing durable output evidence.

If workflow activity ownership is weak, every higher-level runtime plane is
weak:

- duplicate `startRuntime(contextId)` calls can duplicate a process start;
- a future `HostWorkflow` can race itself or another host;
- synchronous `firegrid:run` can appear durable while depending on local timing;
- future tool/session workflows can inherit the same side-effect ambiguity.

The current code gets part of the guarantee from a deterministic raw Durable
Streams append, but then falls back to polling and local guessing. The
ClusterWorkflowEngine model in `repos/effect/packages/cluster/src` shows a
cleaner target: the durable primary-keyed request is the ownership record.

## Cluster Reference Model

`repos/effect/packages/cluster/src/ClusterWorkflowEngine.ts` does not write a
separate activity-claim row.

Instead:

- each workflow execution is an entity;
- the workflow run RPC is persisted with primary key `""`;
- each activity attempt RPC is persisted with primary key
  `${activityName}/${attempt}`;
- `MessageStorage.saveRequest` returns `Success` or `Duplicate`;
- `requestIdForPrimaryKey` recovers the existing durable request id;
- replies are durable results;
- `EntityManager` rejects concurrent processing of the same request id with
  `AlreadyProcessingMessage`.

The important abstraction is not a mutex. It is a persisted request keyed by a
semantic primary key, with duplicate visibility and durable result lookup.

## Current Ground Truth

Current Firegrid workflow activity ownership lives in:

```txt
packages/runtime/src/workflow-engine/internal/engine-runtime.ts
packages/runtime/src/workflow-engine/internal/table.ts
packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts
```

The current path:

```txt
activityKey = executionId/activityName/attempt
  -> write activityClaims row through raw DurableStream producer
  -> poll table.activityClaims.get(...)
  -> if claim.workerId === local worker, run activity body
  -> write activity result row
```

Known defects this tracer is meant to eliminate or make unnecessary:

- fixed `Effect.sleep("10 millis")` materialization polling;
- local-winner fallback when the claim row cannot be observed;
- a separate `activityClaims` table that duplicates activity request identity;
- hand-built producer-id conventions in the workflow engine call site.

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

Update specs first if the implementation needs a new durable table operation
or a changed workflow-engine state model.

## Target Shape

The preferred target shape mirrors the cluster workflow engine:

```txt
activity request key = executionId/activityName/attempt

insert-or-observe durable activity request by key
  -> if completed result exists, return result
  -> if in-flight request is owned elsewhere, return Workflow.Suspended
  -> if local worker durably owns request, run activity body
  -> write durable activity result
```

This may require a small DurableTable capability, but the capability must be
named and reviewed as a persisted primary-keyed request primitive, not as a
generic convenience wrapper around upsert.

Acceptable outcomes for this tracer:

1. a working implementation that deletes or bypasses `activityClaims` and proves
   the cluster-shaped ownership path; or
2. a short design note proving the missing substrate operation, with exact API
   shape and tests required before implementation.

Do not spend the tracer polishing the existing `activityClaims` polling loop
unless it is only a temporary safety patch on the way to the cluster-shaped
model.

## Scenario Proofs

The outcome should be one or more scenario-level tests under
`scenarios/firegrid/` or an equivalent production-surface scenario package.

The scenario must use production composition, not a hidden test-only engine
facade:

```txt
Firegrid.launch or a production RuntimeControlPlaneTable context row
  -> startRuntime(contextId) / RuntimeContextWorkflow
  -> FiregridRuntimeHostLive or FiregridRuntimeHostWithWorkflowLive
  -> real local-process provider
  -> durable RuntimeOutputTable / WorkflowEngineTable observations
```

Required proofs:

1. **Duplicate start is single side effect.** Two concurrent
   `startRuntime({ contextId })` calls against the same namespace produce one
   process start marker, one workflow execution result, one started/exited run
   attempt, and one set of output rows.
2. **Replay after completion is read-only.** A second `startRuntime(contextId)`
   after terminal completion returns the stored workflow result and does not
   start another process.
3. **Competing workers converge.** Two workflow engine workers with distinct
   worker identities racing the same activity key produce one activity body
   execution. The loser observes/suspends rather than running the body.
4. **No unobserved local winner.** Fault injection or a narrow test seam proves
   that if ownership cannot be observed durably, the activity body does not
   execute.

Package tests may cover edge cases, but they do not complete this tracer
without a scenario proving the production runtime path.

## Non-Goals

- Do not implement `DurableSemaphore`, `DurablePartitionedSemaphore`, or
  `DurableKeyedMutex`.
- Do not introduce a public workflow-name registry or `executeByName`.
- Do not model per-message runtime input delivery as one workflow activity per
  input row.
- Do not build a generic dispatcher.
- Do not add a new top-level package.
- Do not make `effect-durable-streams` bigger.

## Write Scope

Likely implementation scope:

```txt
packages/runtime/src/workflow-engine/internal/**
packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.test.ts
packages/effect-durable-operators/src/DurableTable.ts        # only if a spec-approved primitive is required
features/firegrid/workflow-engine-durable-state.feature.yaml  # if state model changes
features/firegrid/firegrid-workflow-driven-runtime.feature.yaml
scenarios/firegrid/src/**
```

Avoid unrelated runtime host refactors. `RuntimeContextWorkflow` can be a
customer of the improved engine, but this tracer owns workflow-engine activity
ownership, not HostWorkflow or context eligibility.

## Relationship To Parallel Work

This tracer should not block:

- synchronous `firegrid:run` cleanup;
- context eligibility spec work;
- documentation of HostWorkflow phases.

It should block:

- a production HostWorkflow that fans out retained contexts across workers;
- treating workflow activity claims as the broad runtime side-effect fence in
  multi-host scenarios;
- any `DurableClaim` or `insertIfAbsent` proposal that claims to solve workflow
  activity ownership without first comparing against the cluster-shaped request
  model.

If this tracer proves the cluster-shaped model, it should supersede the
`activityClaims` row family for workflow activity ownership.
