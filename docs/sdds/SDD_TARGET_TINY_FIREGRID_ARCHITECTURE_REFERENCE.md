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
- how channel route bodies lower to workflows without exposing workflow
  internals;
- how a host/kernel workflow launches and owns child session workflows;
- how child workflows receive prompt/cancel/close/resume inputs;
- how resource state is represented without one table per CRUD operation;
- how edge completion receipts are derived from route metadata and resource
  state.

This reference belongs in `packages/tiny-firegrid/`, because the transactional
cutover rule explicitly allows partial evidence and prototype shapes there. It
must not become a parallel Firegrid API.

## Decision

Build a **target tiny-firegrid architecture reference**: an API-compatible,
clean-room implementation of the desired Firegrid host/runtime shape.

The reference uses production contracts at every external seam:

- production protocol schemas, channel targets, route descriptor types,
  channel read payloads, and completion metadata;
- production client/session APIs for drivers;
- production edge wire shapes for ACP/MCP-style dispatch where exercised;
- production `FiregridHost`-shaped host output where the tiny runner requires
  a host layer.

The reference replaces only the implementation behind those contracts:

```text
production client / edge surface
  -> production protocol route + channel contract
  -> tiny host-plane channel router
  -> tiny channel route implementation
  -> tiny workflow-owned durable resource state machine
  -> tiny child workflow instances
  -> production-shaped channel reads, receipts, and trace evidence
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

## Minimum Primitives

The reference should be built from the few primitives Firegrid already agreed
on. Do not add new conceptual layers unless the implementation proves they are
unavoidable.

### Durable Resource

A typed durable record with identity, status, revision, and domain fields. This
is the state. Examples: host, session, run, channel mailbox. A resource should
not split into separate request, claim, and completion table families just
because it has multiple operations.

### Workflow

The state machine that owns transitions for a durable resource. It receives an
operation through a channel route lowering, reads the current resource state,
applies one transition, and may start child workflows or activities.

### Channel

The semantic API boundary. Callers and edge adapters interact through channel
verbs:

- `call` for durable request/response handshakes;
- `send` for durable append or fire-and-continue behavior;
- `wait_for` for semantic reads over ingress channels.

Channels hide DurableTable handles, output tables, workflow handles,
deferred rows, and low-level stream coordinates. A channel route may lower to
any runtime-owned mechanism named by the host-plane router SDD: a workflow
mailbox/signal, a durable row bridge, a future engine primitive, or a direct
in-process service in a single-host test. That lowering is private to the
runtime implementation.

### Router

The edge dispatch boundary over channels. It decodes, validates, authorizes,
and traces `target + verb + payload`, then invokes the matching channel route.
It does not own lifecycle, claims, retries, completion, child workflow
ownership, or durable resource state.

### Activity / Adapter

The external side-effect boundary. Provider, process, ACP, MCP, sandbox, and
fake-agent behavior lives here. Activities/adapters do not own durable
lifecycle state; workflows do.

The target shape is:

```text
edge/client
  -> router
  -> channel route
  -> workflow-owned resource transition
  -> channel read/call observes semantic state
```

The anti-shape is:

```text
edge/client
  -> public request table
  -> claim table
  -> dispatcher
  -> completion table
  -> output/state helper
  -> semantic API
```

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

```

The workflow owns transitions of `status` and `revision`. Simulation evidence is
captured by OTel traces emitted by the tiny-firegrid runner, not by durable
scenario/e2e assertion rows.

This is the core rule:

> A new operation should normally be a transition on an existing resource
> record, not a new request table plus a new claim table plus a new completion
> table.

Acceptable durable shapes:

- one resource table per durable aggregate such as host, session, run, or
  channel mailbox;
- channel-visible read state only through production-shaped channel payloads;
- workflow-engine state for idempotent workflow execution, activities,
  private deferred completions, and durable sleeps;
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

## Channels, Router, And Workflows

The channel router is the edge/system-call boundary. It decodes wire payloads,
checks target/verb validity, emits dispatch spans, and calls route
implementations.

Route implementations are channel implementations. They are allowed to lower a
channel verb into workflow-owned resource transitions, but the lowering
mechanism stays below the channel/router boundary. Do not promote
`signal`, `mailbox`, `deferred`, request-row, or workflow-engine vocabulary into
the semantic API.

```text
tiny router
  -> tiny channel route implementation
  -> tiny workflow-owned resource transition
  -/-> public DurableTable handles
  -/-> public workflow handles
  -/-> public request/claim/completion rows
```

The reference should prove that route behavior can be tested through production
channel contracts and that workflow behavior can be tested as resource state
transitions without importing edge adapters.

## Dispatch Flow

The minimum dispatch flow is:

```text
edge/client request
  -> router.dispatch.call/send(target, unknown)
  -> Schema.decodeUnknown(route request schema)
  -> channel route lowers request to workflow-owned transition
  -> HostKernelWorkflow applies one resource state transition
  -> optional child SessionWorkflow execute or input delivery
  -> resource status/revision update
  -> channel read routes expose updated state where applicable
  -> route returns production-shaped receipt/response
```

The router returns receipts from route metadata plus terminal or accepted
resource state. Callers do not pass `sync`, `awaitMode`, or `isComplete` flags.

## HostKernelWorkflow

The reference `HostKernelWorkflow` is one workflow per host identity. It owns:

- host singleton identity for the reference host;
- session resource create/load;
- start transitions and child session workflow execution;
- prompt delivery to the child workflow through a channel route lowering;
- cancel, close, and resume transitions;
- duplicate request identity;
- terminal receipt state.

It does not own:

- edge decoding;
- protocol schema definitions;
- transport-specific ACP/MCP response encoding;
- provider-specific process execution;
- public table family definitions.

Duplicate identity is workflow-owned. Replaying the same route request with the
same idempotency key must resolve to the existing resource revision or receipt
instead of enqueueing another operation.

## Child SessionWorkflow

The reference child workflow is intentionally small. It proves ownership and
channel-to-workflow lowering, not real provider execution.

Responsibilities:

- start once for a session id;
- consume prompt inputs delivered by channel route lowering;
- record session-visible facts as resource state exposed only through channels;
- respond to cancel/close/resume from the parent workflow;
- expose enough state through ingress or callable channel routes for
  `session.wait.*`, `wait_for`, or snapshot-style calls to see the result.

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
- channel read payloads and terminal receipts decode through production schemas
  or production-compatible schemas;
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
    routes.ts                      # production route descriptor/receipt/read contracts

  runtime/
    resources/
      session-resource.ts          # tiny durable aggregate records
    channels/
      routes.ts                    # call/send/wait_for route implementations
      router-live.ts               # dispatch interpreter / spans
    workflows/
      host-workflow.ts             # parent resource state machine
      session-workflow.ts          # child resource state machine
    adapters/
      fake-session-adapter.ts      # external side-effect boundary for the sim
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
| `protocol/` | `@firegrid/protocol`: schemas, targets, route contracts, receipts, and channel read payloads |
| `runtime/resources/` | runtime/kernel-private durable resource state |
| `runtime/channels/` | `@firegrid/runtime/channels`: channel route implementations and dispatch interpreter |
| `runtime/workflows/` | `@firegrid/runtime/kernel` / workflow modules: workflow-owned lifecycle/control state |
| `runtime/adapters/` | runtime/host adapter boundary for external side effects |
| `host-sdk/` | `@firegrid/host-sdk`: topology, config, drivers, and edge installation |
| `client-sdk/` | `@firegrid/client-sdk`: optional transport adapter only, not semantic contracts |
| `simulation/` | tiny-firegrid runner glue only |

`protocol/` imports production schemas and names local aliases only where the
production package does not yet expose the desired neutral contract. If a local
alias is needed, it is a finding against the production contract surface.

`runtime/resources/` owns the tiny durable resource records. It should remain
small enough to read in one sitting and must not grow request/claim/completion
table families per operation. OTel spans are the simulation evidence; durable
resource tables are the modeled runtime state.

`runtime/channels/routes.ts` builds route descriptors and route bodies. It may
lower route calls into workflow-owned resource transitions, but it must not
expose workflow handles, DurableTable handles, output tables, request rows,
claim rows, or completion rows to callers.

Reads are also channels. Streaming reads are ingress channels (`wait_for` /
subscribe-style projections) and point-in-time reads are callable routes. The
reference should model the architectural signal from existing channel code:
durable/resource state is hidden behind a channel contract, and callers see
channel targets plus decoded payloads, not table handles or workflow internals.

`runtime/workflows/host-workflow.ts` and
`runtime/workflows/session-workflow.ts` own workflow bodies. They do not import
edge adapters and do not define public route contracts.

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
   exercise production channel contracts while proving route bodies hide
   workflow and DurableTable mechanics from callers.
4. `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.4` - durable
   artifacts contain resource records and workflow state, not per-operation
   request/claim/completion table families.
5. `firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.5` - a run proves
   create/load, start, prompt, cancel, and one of close/resume with duplicate
   request identity and child workflow ownership.

Trace expectations:

- `firegrid.channel.dispatch` spans with target, verb, and direction;
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
- Does route code expose only channel contracts and keep workflow lowering
  private?
- Does workflow code own lifecycle transitions?
- Is the public API still the production API used by the reference driver?

If the answer is no, the PR must explain why production needs a bridge that the
reference deliberately avoided.
