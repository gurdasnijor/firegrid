# SDD: Workflow-Driven Runtime Planes

Date: 2026-05-13

Status: Proposal, docs-only. This SDD is a candidate simplification of
`SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`, not an implementation
authorization.

Blocked by:

- DurableTable hardening currently in progress.
- A focused review of whether the existing workflow activity-claim mechanism
  can be the single execution fence for runtime-host side effects.

Related:

- `SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`
- `PROPOSAL_DURABLE_CLAIM_PRIMITIVE_2026-05-13.md`
- `SDD_FIREGRID_DURABLE_TOOLS.md`
- `docs/reviews/REVIEW_POST_DURABLETABLE_CLEANUP_FOLLOWUPS_2026-05-13.md`
- `workflow-engine-durable-state.feature.yaml`
- `firegrid-durable-tools.feature.yaml`

## Thesis

Firegrid should prefer **workflow execution** as the runtime coordination plane
when the work already has durable orchestration semantics.

Instead of introducing a separate runtime-host dispatcher with its own
context-ownership mutex, model host supervision and runtime-context lifecycle
as durable workflows:

```txt
HostWorkflow(hostId)
  observes eligible RuntimeContext rows
  starts or resumes RuntimeContextWorkflow(contextId)

RuntimeContextWorkflow(contextId)
  owns the lifecycle of one runtime context
  performs side effects through workflow activities
  records user-visible runs, output, ingress, and terminal evidence
```

The load-bearing claim is: **workflow activity claims are already the
one-host-at-a-time side-effect fence**. If the runtime-context lifecycle is
modeled as workflow activities, then separate `DurableKeyedMutex<contextId>`
ownership may be unnecessary for the normal context-execution path.

## Why Revisit The Dispatcher/Mux Proposal

The dispatcher SDD correctly identified a real bug class: multiple hosts can
observe the same context row and start live side effects. Its proposed fix was
a durable context-ownership primitive (`DurableKeyedMutex<contextId>`).

That may still be necessary for non-workflow side effects. But Firegrid now has
a DurableTable-backed workflow engine whose activity-claim path already exists
to prevent duplicate activity execution across workers. If every live runtime
side effect is inside a workflow activity, then the workflow engine can be the
coordination boundary:

```txt
many hosts may resume the same workflow
only the host that wins the activity claim performs the activity side effect
losing hosts suspend / observe progress
```

That is a simpler model than building a second ownership subsystem beside the
workflow engine.

## Plane Model

This SDD separates durable planes by responsibility.

| Plane | Durable owner | What it means | What it must not do |
|---|---|---|---|
| Host plane | `HostWorkflow(hostId)` plus optional host evidence rows | Supervises a host process, advertises capability, observes eligible contexts, starts/resumes child context workflows | Own product-specific session semantics or perform side effects outside workflow activities |
| Runtime context plane | `RuntimeContextWorkflow(contextId)` | Durable lifecycle of one launched runtime context | Depend on app-local watchers or in-memory sets for correctness |
| Session plane | product/app workflow or child context workflow | Product-level conversation/session state, waits, tool decisions, child spawns | Recreate host dispatch or provider delivery policy |
| Ingress plane | `RuntimeIngressTable` plus workflow activity/wait integration | User prompts and provider input intents | Emit bytes before durable claim/workflow activity coordination |
| Output plane | `RuntimeOutputTable` | User-visible runtime events/logs/output facts | Act as execution authority |
| Workflow engine plane | `WorkflowEngineTable` | Orchestration state, deferreds, clocks, activity claims | Become a public substrate package or app-owned control plane |

The design principle is:

```txt
tables record intent/evidence
workflows own orchestration
activities own live side effects
activity claims fence side effects
```

## Proposed Workflow Hierarchy

### `HostWorkflow(hostId)`

One long-running workflow per physical host or host process identity.

Responsibilities:

- record host start/readiness evidence if needed;
- watch or wait for eligible `RuntimeControlPlaneTable.contexts` rows;
- apply host capability filters;
- start/resume `RuntimeContextWorkflow(contextId)` for eligible contexts;
- enforce per-host local capacity with ordinary in-memory `Semaphore` if
  needed;
- periodically heartbeat or retire host evidence if product requirements need
  liveness visibility.

Non-responsibilities:

- directly starting sandbox processes;
- claiming context ownership with a separate mutex;
- writing runtime output except through child context workflow activities;
- embedding product session logic.

### `RuntimeContextWorkflow(contextId)`

One workflow execution per runtime context.

Responsibilities:

- read the context row by `contextId`;
- record run started/exited/failed rows;
- start the provider process through a workflow activity;
- deliver ingress to the provider through workflow activities or durable waits;
- collect process output and write `RuntimeOutputTable` rows;
- complete when the runtime context reaches a terminal state;
- resume safely after host restart.

The workflow execution id should be the context id:

```txt
executionId = contextId
workflowName = firegrid.runtimeContext
```

This gives the durable workflow engine one stable key for the context's
orchestration history.

### Session / Tool Workflows

Product sessions can either:

- live inside the runtime-context workflow when the session is exactly one
  context; or
- become child workflows spawned by the runtime-context workflow when the
  product needs durable fan-out, child agents, `schedule_me`, or long-running
  tool orchestration.

The session plane should not create another host ownership model. It should use
workflow child execution, `wait_for`, `DurableClock`, and activities.

## Durability Semantics By Plane

### Host Semantics

- Host process startup is not itself durable; host workflow state is durable.
- Restarting the same host identity resumes `HostWorkflow(hostId)`.
- Multiple hosts may observe the same context intent.
- The host workflow is allowed to duplicate **resume requests**, because
  duplicate resume requests are not side effects.
- Live side effects must happen only inside workflow activities.

### Runtime Context Semantics

- A context row is intent, not authority.
- `RuntimeContextWorkflow(contextId)` is the durable authority to progress that
  context's lifecycle.
- Duplicate calls to start/resume the context workflow are acceptable.
- Activity claims decide which host performs each live step.
- Run/output rows are durable evidence of progress, not the coordination lock.

### Session Semantics

- Sessions are workflow state or app-owned DurableTable evidence, depending on
  whether the product needs workflow suspension.
- `wait_for`, `sleep`, `spawn`, `spawn_all`, `schedule_me`, and `execute`
  should be workflow-facing APIs.
- A session/tool side effect is a workflow activity unless a concrete product
  case proves it cannot be.

### Ingress Semantics

- User input rows are durable intent.
- Provider byte emission is a live side effect and should be coordinated by the
  context workflow.
- The current `RuntimeIngressTable.deliveries` AtMostOnce claim remains a
  valid v0 bridge, but the preferred long-term model is "context workflow
  observes ingress and delivers input as an activity."

### Output Semantics

- Output rows are evidence.
- Output writes do not grant ownership or coordination authority.
- Output table queries drive UI and client snapshots.

## What This Simplifies

If accepted, this model removes or defers several pieces of the current
dispatcher/mutex direction.

### Likely Removed From The Normal Context Path

- `DurableKeyedMutex<contextId>` as the primary context ownership primitive.
- Runtime-host `claims` / `claimOutcomes` row families.
- App-local `Set<contextId>` correctness fences.
- A dispatcher whose primary job is "claim context, then call `startRuntime`."
- General-purpose `insertIfAbsent` pressure from context ownership alone.

### Still Potentially Needed

- A hardened workflow activity-claim implementation.
- Host evidence rows for observability, liveness, scheduling, and capacity.
- `DurableClaim<K>` or `insertIfAbsent` for non-workflow side effects if a real
  call site remains outside workflow activities.
- A lightweight host workflow runner in the root/product composition.
- A fire-and-forget workflow initiation API, because the host workflow must
  start/resume child workflows without awaiting their completion.

## Effect On Existing Code

### `packages/runtime/src/workflow-engine/internal/engine-runtime.ts`

The activity-claim path remains load-bearing. The desired simplification is not
to bypass it, but to make more runtime side effects flow through it.

Near-term hardening may still be required:

- isolate or remove the raw `effect-durable-streams` producer path;
- remove polling around activity-claim materialization;
- replace wall-clock calls with `Clock` where appropriate;
- expose a narrow "initiate/resume without join" workflow operation if the host
  workflow needs it.

### `packages/runtime/src/runtime-host`

`startRuntime(contextId)` should stop being the public execution-authority
operation. It should become either:

- an internal activity called by `RuntimeContextWorkflow`; or
- a small compatibility wrapper that starts/resumes
  `RuntimeContextWorkflow(contextId)`.

### `apps/flamecast/src/runtime/host.ts`

The Flamecast toy host watcher should be temporary. In the target model it
either:

- starts `HostWorkflow(hostId)` and does nothing else; or
- disappears in favor of a root host runner that any app can configure.

### Durable Tools

`wait_for` becomes more important, not less. The host workflow and runtime
context workflow need durable waits over table changes. But `wait_for` should
resolve existing workflow executions; it should not become a separate
workflow-dispatch service.

## Open Design Questions

1. **HostWorkflow identity.** Is it one workflow per physical host/process
   (`host:${hostId}`), one per namespace (`namespace:${namespace}:host`), or
   both? Recommendation for v0: one per physical host/process, because local
   provider capabilities and process capacity are host-specific.
2. **Child workflow initiation.** What exact workflow-engine API starts or
   resumes `RuntimeContextWorkflow(contextId)` without joining it? The current
   `execute(..., { discard: true })` behavior should be checked; it must not
   serialize host dispatch behind child completion.
3. **Workflow activity claim hardening.** Can the current raw activity-claim
   path be internalized without adding public `DurableTable.insertIfAbsent`?
   If yes, do that before adding a generic table conditional write.
4. **Ingress delivery.** Does provider stdin delivery become a context workflow
   activity immediately, or does the current `RuntimeIngressTable.deliveries`
   bridge stay until after the host workflow is running?
5. **Session boundary.** Which product session state is just UI/queryable
   DurableTable evidence, and which state needs workflow suspension?
6. **Host liveness.** What is the minimal host evidence needed before
   multi-host scheduling? Heartbeats may be observability-only at first if
   workflow activity claims already fence side effects.

## Validation Bar

This model should not proceed to implementation unless it clarifies the
durability semantics across all planes. A successful implementation plan must
be able to prove:

1. Two hosts can observe the same context row without duplicate process-start
   side effects.
2. Restarting a host resumes host workflow supervision without replaying live
   side effects.
3. Restarting a context workflow resumes from durable workflow state and table
   evidence.
4. Runtime output and run rows remain user-visible evidence, not coordination
   locks.
5. Ingress bytes are emitted only after durable workflow/activity coordination.
6. `wait_for`/clock behavior works inside both host and context workflows.
7. Product session workflows compose with runtime context workflows without
   creating a third dispatch plane.

## Candidate Rollout

1. **Architecture review only.** Decide whether this SDD supersedes the
   context-ownership parts of
   `SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`.
2. **Workflow-engine review.** Audit `engine-runtime.ts` for what is required
   to support host/context workflow hierarchy, especially fire-and-forget child
   workflow initiation.
3. **DurableTable hardening.** Finish the current Phase 0 DurableTable
   hardening before any new table write primitive.
4. **Host workflow spike.** Implement a narrow `HostWorkflow(hostId)` that
   observes contexts and initiates `RuntimeContextWorkflow(contextId)` with no
   app-local side effects.
5. **Context workflow spike.** Move local-process start/run/output into
   workflow activities. Prove duplicate host resume does not duplicate process
   start.
6. **Ingress migration.** Route prompt/input delivery through the context
   workflow or explicitly document the retained `deliveries` bridge.
7. **Flamecast cleanup.** Delete app-local host watcher correctness logic and
   consume the product host runner.
8. **Revisit claims/mutexes.** Add `DurableClaim`, `DurableKeyedMutex`, or
   `insertIfAbsent` only for side effects that remain outside workflow
   activities and have concrete call sites.

## Non-Goals

- This SDD does not remove DurableTable.
- This SDD does not remove the workflow engine.
- This SDD does not authorize a generic workflow-name registry or public
  `executeByName` API.
- This SDD does not introduce a new top-level package.
- This SDD does not claim exactly-once external side effects; external systems
  still need idempotency or target-side fencing where appropriate.
- This SDD does not implement `DurableClaim`, `DurableKeyedMutex`, or
  `DurableTable.insertIfAbsent`.

