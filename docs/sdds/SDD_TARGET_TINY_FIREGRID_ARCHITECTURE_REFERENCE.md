# SDD: Target Tiny-Firegrid Architecture Reference

Status: draft architecture
Bead: `tf-3w1e`
Created: 2026-05-21
Owner: Firegrid Architecture
Extends:
- `SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`
- `SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md`
- `docs/cannon/architecture/transactional-cutover-rule.md`
- `features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`

## Problem

The production code is carrying several historical architectures at once. That
makes every brownfield improvement do two jobs:

1. discover the target architecture;
2. migrate old runtime, host-sdk, protocol, table, and route machinery toward
   that target without breaking production.

That coupling is now slowing the architecture work. The current host-control
surface shows the failure mode: a simple lifecycle state machine over a host or
session resource has grown into separate request-row families, claim rows,
completion rows, route bodies, dispatchers, and helper APIs. Each new operation
risks adding another table, another daemon arm, and another public-ish durable
row shape.

Firegrid needs an executable reference implementation that answers the target
composition questions in clean room:

- how production client/edge APIs dispatch through a channel router;
- how route bodies signal workflows without depending on workflow internals;
- how a host/kernel workflow launches and owns child session workflows;
- how child workflows receive prompt/cancel/close/resume signals;
- how resource state is represented without one table per CRUD operation;
- how edge completion receipts are derived from route metadata and terminal
  evidence.

This reference belongs in `packages/tiny-firegrid/`, because the transactional
cutover rule explicitly allows partial evidence and prototype shapes there. It
must not become a parallel Firegrid API.

## Decision

Build a **target tiny-firegrid architecture reference**: an API-compatible,
clean-room implementation of the desired Firegrid host/runtime shape.

The reference uses production contracts at every external seam:

- production protocol schemas, channel targets, route descriptor types, and
  completion metadata;
- production client/session APIs for drivers;
- production edge wire shapes for ACP/MCP-style dispatch where exercised;
- production `FiregridHost`-shaped host output where the tiny runner requires
  a host layer.

The reference replaces only the implementation behind those contracts:

```text
production client / edge surface
  -> production protocol route + channel contract
  -> tiny host-plane channel router
  -> tiny kernel signal service
  -> tiny HostKernelWorkflow resource state machine
  -> tiny child SessionWorkflow instances
  -> production-shaped observations, receipts, and trace evidence
```

The goal is not to rewrite Firegrid in tiny-firegrid. The goal is to create a
small, readable, executable architecture specimen that production migrations can
compare against.

## Non-Goals

This SDD does not:

- replace production `packages/runtime` or `packages/host-sdk`;
- fork production public APIs into `toyCreateSession`, `toyPrompt`, or similar;
- validate provider integrations, real ACP agents, auth, or sandbox policy;
- introduce a second public channel/router abstraction;
- require production packages to cut over before the reference proves the
  shape.

## Clean-Room Boundary

The reference may import production **contracts**:

- `@firegrid/protocol` schemas, route targets, channel descriptors, and receipt
  shapes;
- public type-only host/client surface types needed by the tiny runner;
- generic durable substrate libraries such as `effect-durable-operators` and
  `@effect/workflow`;
- Effect and test/runner utilities.

The reference must not import production **implementation modules** as the
behavior under test:

- no production host-control route bodies;
- no production control-request dispatcher;
- no production runtime-context workflow implementation;
- no production host-sdk command helpers;
- no production control-plane DurableTable families as the state model;
- no production kernel barrels as a dependency shortcut.

If the reference needs a production type for compatibility, prefer a narrow
type import or a small local adapter that proves the same public shape. If it
needs production behavior, the reference is no longer clean-room enough to
answer the target architecture question.

## State Model

The reference treats workflows as state machines over durable resources.

For a session-like resource, the durable model is:

```text
SessionResource {
  sessionId
  hostId
  status: "empty" | "created" | "starting" | "running" | "cancelling" |
          "closed" | "exited" | "failed"
  currentRunId?
  revision
  updatedAt
}

SessionEvidence {
  id
  sessionId
  revision
  kind
  payload
  recordedAt
}
```

The workflow owns transitions of `status` and `revision`. Evidence rows explain
what happened, but they are not a second control plane.

This is the core rule:

> A new operation should normally be a transition on an existing resource
> record, not a new request table plus a new claim table plus a new completion
> table.

Acceptable durable shapes:

- one resource table per durable aggregate such as host, session, run, or
  channel mailbox;
- append-only evidence/event rows for observation, receipts, trace correlation,
  and audit;
- workflow-engine state for idempotent workflow execution, activities,
  deferred signals, and durable sleeps;
- explicit queue rows only when the operation is truly a queue with claim/ack
  or work-stealing semantics.

Rejected reference shapes:

- `contextRequests`, `startRequests`, `lifecycleRequests`,
  `controlRequestClaims`, and `controlRequestCompletions` as the default way to
  express lifecycle transitions;
- one DurableTable family per route verb;
- public protocol row families for kernel-private state;
- route bodies that implement ownership by scanning tables or writing terminal
  completion rows directly.

## Router And Workflow Injection

The channel router is the edge/system-call boundary. It decodes wire payloads,
checks target/verb validity, emits dispatch spans, and calls route
implementations.

Route implementations depend on a **kernel signal service**, not on workflow
definitions or workflow-engine tables:

```ts
interface TinyKernelControl {
  readonly signal: (
    hostId: string,
    intent: TinyKernelIntent,
  ) => Effect.Effect<TinyKernelAck, TinyKernelSignalError>
}
```

The signal service is a leaf contract. It contains schemas and a `Context.Tag`,
but no workflow implementation. The workflow-backed Live implementation lives
below it and may use `Workflow.execute`, `DurableDeferred`, workflow-engine
tables, or a future engine signal API.

This keeps the dependency direction clean:

```text
tiny router routes
  -> tiny kernel signal contract
  -/-> HostKernelWorkflow implementation
  -/-> WorkflowEngineTable

tiny HostKernelWorkflow implementation
  -> tiny kernel signal contract
  -> workflow engine / durable substrate
```

The reference should prove that the route layer can be tested with a fake
`TinyKernelControl` and that the workflow layer can be tested without importing
the router.

## Dispatch Flow

The minimum dispatch flow is:

```text
edge/client request
  -> router.dispatch.call/send(target, unknown)
  -> Schema.decodeUnknown(route request schema)
  -> route maps request to TinyKernelIntent
  -> TinyKernelControl.signal(hostId, intent)
  -> HostKernelWorkflow mailbox receives intent
  -> HostKernelWorkflow applies one state transition
  -> optional child SessionWorkflow execute/signal
  -> resource record + evidence rows update
  -> route returns production-shaped receipt/response
```

The router returns receipts from route metadata plus terminal or accepted
evidence. Callers do not pass `sync`, `awaitMode`, or `isComplete` flags.

## HostKernelWorkflow

The reference `HostKernelWorkflow` is one workflow per host identity. It owns:

- host singleton identity for the reference host;
- session resource create/load;
- start transitions and child session workflow execution;
- prompt delivery to the child workflow;
- cancel, close, and resume transitions;
- duplicate request identity;
- terminal evidence projection.

It does not own:

- edge decoding;
- protocol schema definitions;
- transport-specific ACP/MCP response encoding;
- provider-specific process execution;
- public table family definitions.

Duplicate identity is workflow-owned. Replaying the same route request with the
same idempotency key must resolve to the existing resource revision or evidence
instead of enqueueing another operation.

## Child SessionWorkflow

The reference child workflow is intentionally small. It proves ownership and
signal routing, not real provider execution.

Responsibilities:

- start once for a session id;
- consume prompt signals through the kernel/workflow signal path;
- append production-shaped agent-output or session-output evidence;
- respond to cancel/close/resume from the parent workflow;
- expose enough evidence for `session.wait.*` or channel observation to see the
  result.

The child workflow may use deterministic fake agent behavior. That is allowed
because this SDD is about architecture wiring, not model/provider quality.

## API Compatibility Requirement

The reference is useful only if callers cannot tell it is a toy from the public
API shape.

Required compatibility:

- drivers use production `@firegrid/client-sdk` session methods where the tiny
  runner supports them;
- edge probes use production route targets and production request/response
  schemas;
- route descriptors use production channel router metadata types;
- observation and terminal receipts decode through production schemas or
  production-compatible schemas;
- host layer output is assignable to the production public host surface needed
  by the tiny runner.

Rejected compatibility shortcuts:

- simulation-only client methods;
- alternate target names;
- direct workflow handles in driver code;
- direct DurableTable handles in driver code;
- route implementations that expose tiny-only receipt shapes.

## Reference Layout

The reference layout must mirror the desired production package boundaries. It
is not organized as "one simulation with helper files." The simulation is only
a thin runner adapter around an architecture-shaped miniature package graph.

Recommended layout inside tiny-firegrid:

```text
packages/tiny-firegrid/src/simulations/target-architecture-reference/
  index.ts                         # simulation registration only

  protocol/
    channels.ts                    # production channel targets/schemas re-exported or aliased
    routes.ts                      # production route descriptor/receipt contracts
    observations.ts                # production-shaped observation schemas

  runtime/
    resources/
      session-resource.ts          # tiny durable aggregate records
      session-evidence.ts          # append-only evidence rows
    channels/
      host-control-routes.ts       # route bodies; depends on kernel contract only
      router-live.ts               # runtime dispatch interpreter / spans
    kernel/
      control-plane.ts             # signal contract: schemas + Context.Tag only
      control-plane-live.ts        # workflow-backed signal implementation
      host-kernel-workflow.ts      # parent workflow state machine
      session-workflow.ts          # child workflow state machine
    observation/
      session-observation.ts       # resource/evidence -> public observation projection

  host-sdk/
    host-live.ts                   # host topology: runtime + router + edges
    edges/
      in-memory-edge.ts            # tiny edge adapter over production route contracts

  client-sdk/
    client-live.ts                 # only if the production client cannot target the tiny host directly

  simulation/
    driver.ts                      # tiny runner adapter, not architecture
    artifacts.ts                   # native artifact readers/assertion helpers
```

The folder names are deliberate. They should make the target production split
visible:

| Tiny reference folder | Production boundary it represents |
| --- | --- |
| `protocol/` | `@firegrid/protocol`: schemas, targets, route contracts, receipts, observation views |
| `runtime/resources/` | runtime/kernel-private durable state and evidence |
| `runtime/channels/` | `@firegrid/runtime/channels`: route implementations and dispatch interpreter |
| `runtime/kernel/` | `@firegrid/runtime/kernel`: workflow-owned lifecycle/control state |
| `runtime/observation/` | runtime-owned projection from internal evidence to public observations |
| `host-sdk/` | `@firegrid/host-sdk`: topology, config, drivers, and edge installation |
| `client-sdk/` | `@firegrid/client-sdk`: optional transport adapter only, not semantic contracts |
| `simulation/` | tiny-firegrid runner glue only |

`protocol/` imports production schemas and names local aliases only where the
production package does not yet expose the desired neutral contract. If a local
alias is needed, it is a finding against the production contract surface.

`runtime/resources/` owns the tiny resource/evidence tables. It should remain
small enough to read in one sitting and must not grow request/claim/completion
table families per operation.

`runtime/channels/host-control-routes.ts` builds route descriptors and route
bodies. It imports `runtime/kernel/control-plane.ts` but not workflow
implementations, workflow-engine tables, or `runtime/kernel/index.ts`-style
barrels.

`runtime/kernel/control-plane.ts` is the leaf signal contract. It defines
schemas, the `Context.Tag`, and service interface only.

`runtime/kernel/control-plane-live.ts` is the workflow-backed implementation of
that contract. It may depend on `host-kernel-workflow.ts`,
`session-workflow.ts`, and workflow substrate.

`runtime/kernel/host-kernel-workflow.ts` and
`runtime/kernel/session-workflow.ts` own workflow bodies. They do not import
router files or edge adapters.

`host-sdk/host-live.ts` composes the tiny host layer, selected router, runtime
kernel implementation, and edge adapters. It should look like the target
production host-sdk composition, not like a runtime owner.

`simulation/driver.ts` drives the public surface and records no verdict
language. It exists to run the reference through tiny-firegrid; it is not part
of the target host/runtime architecture.

## Validation Plan

The first implementation should prove these facts with native tiny-firegrid
artifacts:

1. `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.1` - the driver
   enters through production-compatible client or edge contracts.
2. `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.2` - static
   imports show the reference does not depend on production host-sdk/runtime
   implementation modules for behavior.
3. `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.3` - route tests
   use a fake kernel signal service, proving router-to-workflow decoupling.
4. `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.4` - durable
   artifacts contain resource/evidence records and workflow state, not
   per-operation request/claim/completion table families.
5. `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.5` - a run proves
   create/load, start, prompt, cancel, and one of close/resume with duplicate
   request identity and child workflow ownership.

Trace expectations:

- `firegrid.channel.dispatch` spans with target, verb, and direction;
- `firegrid.tiny_reference.kernel.signal` spans;
- `firegrid.tiny_reference.host_workflow.transition` spans;
- `firegrid.tiny_reference.child_workflow.*` spans;
- no spans that imply production dispatcher/request-row bridges are involved.

## Migration Use

The reference is not a production replacement by itself. It becomes the review
oracle for production migration PRs.

When a production PR touches host-control routes, kernel workflows, channel
router dispatch, or control-plane row families, reviewers should ask:

- Does this production change move closer to the reference dependency graph?
- Does it reduce request/claim/completion table sprawl?
- Does route code depend only on the signal contract?
- Does workflow code own lifecycle transitions?
- Is the public API still the production API used by the reference driver?

If the answer is no, the PR must explain why production needs a bridge that the
reference deliberately avoided.
