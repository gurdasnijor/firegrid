# SDD: HostKernelWorkflow-Mediated Control Plane Slice

Status: validation slice implemented - prune decision pending
Bead: `tf-c8cy`
Blocks: `tf-8aw5`, `tf-rqyh`

## §0 Architecture Correction

**Gurdas architecture correction, 2026-05-21, PR #602:** the prior Option A
route-wiring direction is superseded. The bug in both prior options was the
assumption that a host-plane router should own durable control-row appends.
That makes the router grow an internal control plane and blurs the boundary
between public route contracts and runtime-owned workflow state.

Guiding rule: **if code starts accumulating claims, polling, request rows,
completions, retries, lifecycle transitions, or exclusive ownership over
runtime state — that IS a control plane, and in Firegrid it must be modeled as
a WORKFLOW, not as router bodies.**

The corrected model is:

- the host-plane router is an edge / system-call boundary;
- create/load, start, prompt, cancel, close, and resume signal a long-running
  `HostKernelWorkflow` through a workflow signal/mailbox contract;
- `HostKernelWorkflow` owns exclusive control over its `RuntimeContextWorkflow`
  children and serializes lifecycle/control decisions;
- `SessionLifecycleChannel` remains observation-only;
- `inputIntents`, `contextRequests`, `startRequests`, `lifecycleRequests`,
  `controlRequestClaims`, and `controlRequestCompletions` are kernel-private
  workflow/mailbox or migration-tail state, not public protocol durable state;
- `@firegrid/protocol` owns public route/channel request and response
  contracts only; kernel/runtime packages own private durable row schemas and
  workflow state.

## Validation Slice Built

The slice adds a runtime-kernel prototype, exported through
`@firegrid/runtime/kernel`, not the root runtime barrel:

- `HostKernelWorkflow`: one long-running workflow per host identity.
- `HostKernelControlPlane`: the injected runtime authority used by host-control
  channels to signal workflow-owned intents.
- `HostKernelControlPlaneLive`: the validation signal service that appends
  intents to workflow-native durable deferred mailbox slots.
- Intent family: `CreateLoad`, `Start`, `Prompt`, `Cancel`.
- Child ownership: `Start` executes `RuntimeContextWorkflowNative`; `Prompt`
  appends the runtime input deferred for that child; `Cancel` interrupts the
  child workflow and writes public terminal run evidence.
- `packages/runtime/src/channels/host-control-routes.ts`: create/load and
  start channel bindings now decode public route payloads and dispatch typed
  intents into `HostKernelControlPlane` when that injected signal authority is
  installed; that injected path does not append `contextRequests` or
  `startRequests`.

The route proof is deliberately narrow. It covers the public channel-router
edge for create/load and start with `HostKernelControlPlane` injected, while
prompt/cancel still remain under the broader follow-up boundary work. Legacy
request-row bindings remain as a migration tail for compositions that have not
installed HostKernel yet; deleting that fallback is gated below.

## Native Evidence

Test:
`packages/runtime/test/workflow-engine/host-kernel-workflow.test.ts`
and `packages/runtime/test/channels/host-control-router.test.ts`

Command:

```bash
pnpm --filter @firegrid/runtime exec vitest run test/workflow-engine/host-kernel-workflow.test.ts
pnpm --filter @firegrid/runtime exec vitest run test/channels/host-control-router.test.ts
```

Result: both pass.

The test asserts native durable artifacts, not a bespoke evidence harness:

- four `firegrid.host-kernel` mailbox deferred rows for create/load, start,
  prompt, and cancel;
- four host-kernel workflow activity rows, proving serialized intent handling;
- one host-kernel workflow execution and one child
  `RuntimeContextWorkflowNative` execution;
- one runtime context row materialized by the kernel create/load decision;
- public run rows `started` then `exited` with cancel evidence
  `exitCode: 130`, `signal: "SIGTERM"`;
- one child runtime input deferred row for prompt delivery;
- no `contextRequests`, `startRequests`, `lifecycleRequests`,
  `controlRequestClaims`, or `controlRequestCompletions` rows written by the
  slice;
- captured spans for `firegrid.host_kernel.intent.signal`,
  `firegrid.host_kernel.workflow.intent.apply`,
  `firegrid.host_kernel.child.start`, and `firegrid.host_kernel.child.cancel`.
- host-control router dispatch for create/load and start calls the injected
  kernel signal authority rather than protocol request-row factories.

Typecheck:

```bash
pnpm --filter @firegrid/runtime typecheck
```

Result: pass.

## Comparison To Today's Dispatcher Path

Today's path is row-dispatcher mediated:

```text
public/channel/helper append
  -> RuntimeControlPlaneTable.{contextRequests,startRequests,lifecycleRequests}
  -> control-request-dispatcher
  -> RuntimeContextProvisionWorkflow / RuntimeStartWorkflow / RuntimeLifecycleWorkflow
  -> claim/completion rows
  -> side effects on RuntimeContextWorkflowRuntime
```

The slice path is workflow-mediated:

```text
edge/system-call intent
  -> HostKernelControlPlane.signal
  -> HostKernelWorkflow mailbox deferred
  -> serialized HostKernelWorkflow decision activity
  -> RuntimeContextWorkflow child execute / input deferred / interrupt
  -> public context + run observation rows
```

The comparison is clean for the covered kernel create/load, start, prompt, and
cancel happy path, and for router -> kernel dispatch of create/load and start
when HostKernel is injected: the kernel workflow produces native workflow and
public observation evidence without the dispatcher request-row/claim/completion
families, and those two public routes can bypass control request rows from
route bodies.

The comparison is not yet complete for multi-host failover, retries after host
death, duplicate edge request identity across process restart, close/resume, or
public router contract acks.

## Explicit Gate Before Any Deletion

No deletion of the current dispatcher/request-row path is allowed until a
follow-up proof covers all of these gates:

- router -> workflow dispatch: prompt, cancel, close, and resume routes still
  need the same decode/authorize/dispatch-only proof now shown for create/load
  and start;
- restart replay: a restarted host resumes `HostKernelWorkflow` and recovers
  accepted-but-unprocessed mailbox state;
- duplicate/concurrent signal gate: duplicate and concurrently delivered
  request identities produce one serialized kernel decision, not duplicate
  child lifecycle effects;
- host singleton / failover: one host-kernel owner is active for a host
  authority scope, with explicit behavior for stale ownership and takeover;
- close / resume: the signal contract covers more than cancel;
- protocol control-row relocation: public protocol exports are reduced to
  route/channel contracts while any remaining row state moves under
  kernel-private ownership;
- workflow signal abstraction: `HostKernelWorkflow` is driven by an injected
  signal/mailbox or channel-router-style kernel service, not by workflow bodies
  directly depending on low-level durable table mechanics.

These gates are prune preconditions, not work for this PR.

## Prune Plan If The Gate Passes

Prune candidates after follow-up coverage:

- `runtime/control-plane/control-request-dispatcher.ts`;
- `RuntimeContextProvisionWorkflow`, `RuntimeStartWorkflow`, and
  `RuntimeLifecycleWorkflow`;
- `contextRequests`, `startRequests`, `lifecycleRequests`,
  `controlRequestClaims`, and `controlRequestCompletions` durable row families,
  or move any still-needed row shape under kernel-private mailbox state;
- direct lifecycle append helpers such as `appendCommittedLifecycleRequest`;
- host-control route bodies that write durable control rows;
- `RuntimeInputIntentDispatcherLive` and the public `inputIntents` row bridge,
  once prompt/input is fully mailbox/workflow-native rather than migration-tail
  bridge state.

Deletion order should be: prove parity for one route family, route edges to the
kernel signal, delete the corresponding request-row writer, then delete the
dispatcher arm and row family. Do not delete all row bridges before the kernel
has replacement coverage for restart/failover and idempotency.

## Current Verdict

Clean for the narrow validation slice. `HostKernelWorkflow` can be the
exclusive lifecycle/control owner for a small set of `RuntimeContextWorkflow`
children using native workflow durable artifacts and public observation rows,
and the channel router can dispatch create/load and start into the injected
kernel signal authority without route-owned control request rows.

Not yet clean enough for broad deletion. The next proof must add router
decode/authorize/dispatch-intent for the remaining control intents, duplicate
request id semantics, restart replay, and close/resume coverage. `tf-8aw5` and
`tf-rqyh` remain blocked on that HostKernelWorkflow signal boundary rather than
on direct lifecycle-route wiring.
