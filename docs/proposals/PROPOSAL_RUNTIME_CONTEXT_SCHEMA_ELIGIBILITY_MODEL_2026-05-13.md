# Proposal: Runtime Context Schema Eligibility Model

Date: 2026-05-13

Status: Architecture/spec spike, docs-only. No implementation authorization.

Related:

- `SDD_FIREGRID_WORKFLOW_DRIVEN_RUNTIME_PLANES.md`
- `SDD_FIREGRID_DURABLE_LAUNCH_RUNTIME_OPERATOR.md`
- `firegrid-workflow-driven-runtime.feature.yaml`
- `firegrid-durable-launch-runtime-operator.feature.yaml`

## Summary

`HostWorkflow` needs an explicit control-plane signal for eligible runtime work
before it can safely observe retained `RuntimeContext` rows.

The current `RuntimeContext` row is durable identity plus launch intent only:

```ts
{
  contextId: string
  createdAt: string
  createdBy?: string
  runtime: RuntimeContextIntent
}
```

That shape is enough for `startRuntime(contextId)` and synchronous run paths that
already know which context to execute. It is not enough for a future
`HostWorkflow` that replays retained rows and asks "what new work should I
start?"

Recommendation: add a minimal lifecycle/eligibility projection to
`RuntimeContext` in `@firegrid/protocol/launch`. Keep `RuntimeRunEvent` rows as
the authoritative run evidence.

## Context

`firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.1` says a future
`HostWorkflow` observes explicit eligible runtime-context work and starts or
resumes `RuntimeContextWorkflow` executions without performing runtime side
effects directly.

`firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.3` blocks that behavior
until the control-plane model can distinguish eligible work from already
observed retained context evidence.

The workflow-driven runtime SDD already identifies the missing field:
`RuntimeContext` has no status, and `createdBy` is not enough to express "next
unclaimed context" without repeatedly matching the same retained row.

The current Flamecast toy host compensates by folding run rows and keeping an
in-memory `Set<contextId>`. That is acceptable as temporary app code, but it is
not a correctness model for `HostWorkflow`.

## Current Durable Facts

`RuntimeContext` is the durable intent and identity row. Browser/client launch
creates it, sync run will create it, and runtime workflows read it.

`RuntimeRunEvent` rows are per-attempt evidence. They can say an attempt was
`started`, `exited`, or `failed`, and they carry terminal details such as
`exitCode`, `signal`, or `message`.

`RuntimeOutputTable` rows are user-visible output evidence. They must not become
execution authority.

`RuntimeIngressTable` rows are input intent and per-input delivery evidence.
They must not become host dispatch or context ownership state.

## Missing State

Before `HostWorkflow` exists, the control plane needs durable answers to these
questions:

1. Is this context newly eligible for a host to initiate?
2. Has a host or caller already initiated/resumed the context workflow?
3. Is there evidence that the current attempt is running?
4. Is the context terminal for the current lifecycle?
5. Can retained row replay avoid treating old context identity rows as fresh
   work?

Run rows can answer questions 3 and 4 after an attempt starts. They cannot
answer question 2, because there is a real pre-run window between observing a
context row and writing `started` evidence.

That pre-run window is why context-level eligibility is needed even though run
started/exited evidence already exists.

## Options

### Field On `RuntimeContext`

Add a small status projection to the existing context row.

Benefits:

- lowest blast radius;
- one row family remains the durable intent and identity surface;
- browser/client launch and sync run can write the same initial shape;
- `HostWorkflow` can query retained rows with a simple context predicate;
- terminal run details stay in `RuntimeRunEvent`.

Costs:

- the context row becomes mutable projection state, not just immutable launch
  intent;
- status repair must be defined from run evidence if a workflow updates run rows
  but fails before updating the context projection.

This is the recommended v0 path.

### Derive Eligibility From `RuntimeRunEvent`

Make `HostWorkflow` fold context rows and run rows to infer eligibility.

Benefits:

- no context row schema change;
- run events remain the only lifecycle facts.

Costs:

- no durable "already observed but no run has started" state;
- cross-table negative queries become part of host dispatch;
- retained context replay can repeatedly rediscover the same old identity rows;
- browser/client snapshots already fold run rows, but that fold is observation,
  not dispatch authority.

This is not recommended for `HostWorkflow`.

### Separate `RuntimeWorkRequest` Row

Introduce a distinct work-intent row family, for example
`RuntimeWorkRequest` or `RuntimeContextIntent`.

Benefits:

- clean separation between immutable context identity and mutable work queue
  state;
- could support future non-context work types.

Costs:

- larger public protocol surface;
- duplicates context identity and launch intent;
- complicates browser/client launch and sync run;
- weakens `firegrid-workflow-driven-runtime.BOUNDARIES.1`, which says
  `RuntimeContext` remains the durable intent and identity record.

This may be useful later, but it is too much for v0.

## Recommended Row Shape

Add this protocol-owned projection to `RuntimeContext`:

```ts
type RuntimeContextStatus =
  | "requested"
  | "starting"
  | "running"
  | "exited"
  | "failed"

interface RuntimeContext {
  contextId: string
  createdAt: string
  createdBy?: string
  runtime: RuntimeContextIntent
  status: RuntimeContextStatus
  statusUpdatedAt: string
  activityAttempt?: number
}
```

Status meanings:

| Status | Meaning | HostWorkflow treatment |
| --- | --- | --- |
| `requested` | A caller created a runtime context that is eligible to initiate. | New work. |
| `starting` | A workflow initiation or resume was durably requested, but no started run evidence is visible yet. | Resume candidate, not fresh work. |
| `running` | Started run evidence exists for `activityAttempt`. | Resume/observe candidate, not fresh work. |
| `exited` | Terminal exited evidence exists for `activityAttempt`. | Terminal retained evidence. |
| `failed` | Terminal failed evidence exists for `activityAttempt`. | Terminal retained evidence. |

`activityAttempt` is only a pointer to the current or terminal attempt. The
authoritative per-attempt facts remain in `RuntimeRunEvent`.

## Transition Rules

1. Client launch and synchronous `firegrid run -- ...` insert a context row with
   `status = "requested"` and `statusUpdatedAt = createdAt`.
2. `HostWorkflow` or direct `startRuntime(contextId)` starts or resumes
   `RuntimeContextWorkflow(contextId)`.
3. After durable workflow initiation succeeds, the caller or workflow updates
   the context to `starting`.
4. `RuntimeContextWorkflow` writes the run `started` row, then updates context
   status to `running` with the selected `activityAttempt`.
5. `RuntimeContextWorkflow` writes terminal run evidence first, then updates
   context status to `exited` or `failed` with the terminal `activityAttempt`.
6. If a context-status update is missed, run rows remain the repair source.
   Reconciliation may rebuild the status projection from the latest run
   evidence.

Duplicate workflow resume requests are acceptable. The workflow execution id and
activity claims remain the side-effect fence; context status is not a lock.

## Package Ownership

The schema belongs in `packages/protocol/src/launch/schema.ts` and
`packages/protocol/src/launch/table.ts`.

Reasons:

- browser/client launch creates `RuntimeContext` rows;
- synchronous run should create the same row shape;
- `HostWorkflow` needs to observe the same rows;
- snapshots already expose context/run status to clients;
- durable protocol rows should not be runtime-private when browser/client code
  must encode them.

Runtime-private helpers may own transition mechanics, but not the durable schema.

## Spec Recommendations

Apply these as follow-up ACID edits before implementation.

For `firegrid-workflow-driven-runtime.feature.yaml`:

- Add a context eligibility component before `PHASE_5_HOST_WORKFLOW`:
  `RuntimeContext` rows include a protocol-owned lifecycle status projection
  with `requested`, `starting`, `running`, `exited`, and `failed`.
- Add: client launch and synchronous run create `requested` context rows.
- Add: `RuntimeContextWorkflow` advances context status only after durable
  workflow/run evidence exists.
- Add: `HostWorkflow` treats only `requested` as new work;
  `starting`/`running` are resume candidates; terminal statuses are retained
  evidence and not eligible work.
- Edit `BOUNDARIES.1` to explicitly allow a lifecycle projection on
  `RuntimeContext` while still rejecting a new v0 runtime work-record family.

For `firegrid-durable-launch-runtime-operator.feature.yaml`:

- Edit `LAUNCH_ROWS.4` to mention that context lifecycle projections include
  minimal context status while run rows remain separate per-attempt evidence.
- Edit `LAUNCH_ROWS.7` so normalized internal context rows include initial
  `status = "requested"`.
- Consider superseding `RUNTIME_HOST.7` after workflow-driven runtime Phase 1
  and Phase 3 land, because max-attempt allocation under a single-writer
  contract is not the target workflow/activity-claim authority model.

## Non-Goals

- Do not introduce a context ownership mutex for the normal runtime-context
  path.
- Do not make `RuntimeRunEvent` the host dispatch queue.
- Do not introduce `RuntimeWorkRequest` for v0 unless a future spec needs a
  separate public work-record family.
- Do not store terminal process details on `RuntimeContext`; keep them in
  `RuntimeRunEvent`.
