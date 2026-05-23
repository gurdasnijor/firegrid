# Runtime Physical Target Tree

Status: dispatchable architecture aid
Date: 2026-05-22
Owner: Firegrid Architecture

This document pins the target physical shape for `packages/runtime/src/`.
It operationalizes the canonical pipeline from
`docs/cannon/architecture/runtime-design-constraints.md` and
`docs/cannon/architecture/runtime-pipeline-type-boundaries.md`:

```text
events -> DurableTable(events) -> transforms(rows) -> keyed subscribers(rows)
```

The directory tree is the data flow. The ordering is logical, but directory
names are semantic. Do **not** encode ordering numbers or subscriber shape
letters into physical folder names.

This is a runtime-package target. It does not replace
`docs/architecture/host-sdk-runtime-boundary.md`: host-sdk remains the outer
host composition and public host facade. The `composition/` folder below is
runtime-local topology wiring and CI topology checks, not an excuse for
host-sdk to import mixed runtime barrels or workflow-era host internals.

## Target Tree

```text
packages/runtime/src/
│
├── README.md                         # pipeline diagram + folder pointers
│
├── events/                           # 1. WHAT crosses boundaries
│   ├── README.md                     # event vocabulary; no I/O, state, behavior
│   ├── agent-input.ts                # AgentInputEvent union + schema
│   ├── agent-output.ts               # AgentOutputEvent union + schema
│   ├── runtime-ingress.ts            # RuntimeIngressInputRow schema
│   ├── runtime-output.ts             # RuntimeEventRow / RuntimeLogLineRow schemas
│   └── runtime-context-state.ts      # RuntimeContextEventState schema
│
├── tables/                           # 2. WHERE durable state lives
│   ├── README.md                     # DurableTable definitions; one table family per file
│   ├── runtime-control-plane.ts      # RuntimeControlPlaneTable
│   ├── runtime-output.ts             # RuntimeOutputTable
│   └── runtime-context-state.ts      # RuntimeContextStateStore
│
├── producers/                        # 3. WHO appends rows from live boundaries
│   ├── README.md                     # Shape A only: scoped live work, no owned state
│   ├── sandbox/
│   │   ├── byte-stream.ts            # AgentByteStream
│   │   ├── local-process.ts          # LocalProcessSandboxProvider
│   │   ├── effect-ai.ts              # EffectAiSandboxProvider
│   │   └── SandboxProvider.ts        # provider contract
│   ├── codecs/
│   │   ├── contract.ts               # AgentSession live codec boundary
│   │   ├── acp/
│   │   └── stdio-jsonl/
│   └── ingress-writers/
│       ├── per-context-output.ts     # AgentSession.outputs -> RuntimeOutputTable.events
│       └── runtime-input-append.ts   # external input -> input intent rows
│
├── transforms/                       # 4. HOW rows shape into facts/actions; PURE
│   ├── README.md                     # no Effect, no R channel, no I/O
│   ├── decode-ingress-row.ts         # agentInputEventFromRuntimeIngressRow
│   ├── decode-output-row.ts          # runtimeAgentOutputObservationFromRow
│   ├── field-equals.ts               # evaluateFieldEquals + FieldEqualsTrigger
│   └── runtime-context-transition.ts # transitionInputEvent / transitionOutputEvent
│
├── channels/                         # 5. WIRE-EDGE capability boundary
│   ├── README.md                     # Ingress/Egress/Callable/Bidirectional channel rules
│   ├── host-control/
│   ├── session/
│   ├── routes/                       # channel registrations -> route projections
│   └── router.ts                     # HostPlaneChannelRouter / RuntimeChannelRouter
│
├── subscribers/                      # 6. WHO reacts; Shape B / C / D
│   ├── README.md                     # shape table + R-channel rules
│   ├── projections/                  # Shape B: read-only, no state
│   ├── runtime-context/              # Shape C: stateful per-event RuntimeContext handler
│   │   ├── README.md
│   │   ├── handler.ts
│   │   ├── state-ops.ts
│   │   └── action-dispatch.ts
│   ├── runtime-context-session/      # Shape C: codec-session command sink
│   │   ├── README.md
│   │   └── handler.ts
│   ├── tool-dispatch/                # Shape D: Activity memoization justified
│   │   ├── README.md
│   │   └── workflow.ts
│   ├── wait-router/                  # Shape D: durable wait/timeout justified
│   │   ├── README.md
│   │   └── workflow.ts
│   ├── scheduled-prompt/             # Shape D: DurableClock justified
│   │   ├── README.md
│   │   └── workflow.ts
│   └── runtime-control/              # Shape D: host-control request workflows
│       ├── README.md
│       └── workflows.ts
│
├── composition/                      # 7. runtime-local topology wiring
│   ├── README.md                     # Layer graph; topology = Layer.mergeAll
│   ├── host-live.ts                  # runtime-owned layer graph for host-sdk to install
│   └── topology-checks.ts            # CI: shape, ownership, cycle checks
│
└── _archive/                         # wrong-shape code pending deletion
    └── workflow-engine/
        └── DEPRECATED.md             # names deletion bead/wave
```

## Logical Order And Import Direction

The pipeline order is:

```text
events < tables < producers / transforms / channels < subscribers < composition
```

That order is semantic and enforceable; it is not encoded with numeric folder
names.

- `events/` imports protocol schemas and base libraries only. It does not
  import runtime state, Effects, Layers, channels, subscribers, or workflow
  machinery.
- `tables/` imports `events/` and protocol row schemas. It owns
  DurableTable-backed state and event tables.
- `producers/` imports `events/` and `tables/`. It owns live scoped producers
  and table append authority.
- `transforms/` imports `events/` only. Every exported transform is pure; no
  `Effect`, `Layer`, `Context.Tag`, `Workflow.make`, `Activity.make`, or
  `DurableDeferred`.
- `channels/` imports `events/` and `tables/` as needed to implement channel
  bindings and route projections. It does not own subscriber logic.
- `subscribers/` imports lower-order folders. Shape D subscribers may import
  workflow machinery only inside their own subfolders with a README
  justification.
- `composition/` imports the lower-order folders to build the runtime layer
  graph. It does not define business logic, durable row schemas, or transition
  behavior.

Imports from an earlier folder to a later folder are structure violations. For
example, `transforms/` must not import `subscribers/`, and `events/` must not
import `tables/`.

## Shape Rule

Subscriber shape is recorded in `subscribers/README.md` and each subscriber
folder README. It is not encoded in folder names.

```text
subscribers/projections/              Shape B: read-only projection consumer
subscribers/runtime-context/          Shape C: stateful keyed subscriber
subscribers/runtime-context-session/  Shape C: session-command sink
subscribers/tool-dispatch/            Shape D: workflow-shaped
subscribers/wait-router/              Shape D: workflow-shaped
subscribers/scheduled-prompt/         Shape D: workflow-shaped
subscribers/runtime-control/          Shape D: workflow-shaped
```

Review rules:

- Shape B: no state store, no write authority.
- Shape C: state/read/write tags allowed; no `WorkflowEngine`, no
  `WorkflowInstance`, no `Activity.make`, no parked body.
- Shape D: workflow machinery is allowed only if the README names the
  load-bearing reason: Activity memoization, durable timer, cross-execution
  handoff, or restart-safe live side effect.

## Public Package Subpaths

The semantic source tree does not mean every source folder becomes a public
package API. External consumers, including host-sdk, import only explicitly
exported narrow semantic subpaths.

When a runtime capability must be consumed outside `packages/runtime/src/`, its
public subpath should align with the semantic tree, not with historical barrels
and not with ad hoc flat names.

Preferred new public subpath shape:

```text
@firegrid/runtime/tables/runtime-context-state
@firegrid/runtime/producers/runtime-context-input-facts
@firegrid/runtime/subscribers/runtime-context
@firegrid/runtime/subscribers/runtime-context-session
@firegrid/runtime/composition/host-live
```

Existing flat subpaths such as `@firegrid/runtime/runtime-output` may remain
until deliberately migrated, but new Shape C clean-room exports should prefer
the tree-aligned semantic shape above. Do not create public exports that expose
ordering numbers. Do not use `@firegrid/runtime/kernel` as a convenience
import for host-sdk or clean-room code.

## Channels And Routes

`channels/` is the runtime wire-edge capability boundary:

- channel folders define typed `IngressChannel`, `EgressChannel`,
  `CallableChannel`, or `BidirectionalChannel` services;
- `routes/` projects typed channel registrations to router routes;
- `router.ts` owns wire-edge dispatch, schema parsing, direction/verb checks,
  and route invocation.

Channels are not subscribers. Subscribers consume channel tags through their
`R` channel.

## Composition Boundary

`composition/` is runtime-local topology wiring. It is where the runtime Layer
graph is assembled from lower-order runtime parts.

Host-sdk remains the host composition package. It may install runtime-owned
layers through narrow target subpaths, but it must not import mixed runtime
barrels such as `@firegrid/runtime/kernel` or reach into `_archive/`.

If host-sdk needs a runtime capability that is only available through a mixed
barrel today, first add a narrow semantic target subpath under runtime. Do not
import the mixed barrel from host-sdk to keep a cutover moving.

## Archive Rule

`_archive/` is not a bridge surface. It is a time-boxed holding pen for
wrong-shape code while the greenfield cutover deletes it.

Files under `_archive/`:

- are not imported by target code;
- carry a `DEPRECATED.md` naming their deletion wave or bead;
- are not elaborated with new behavior;
- are removed mechanically once the target path lands.

If a target file imports `_archive/`, the clean-room cutover has failed.

## README Contract

Each top-level folder has a `README.md` with:

1. what the folder owns;
2. which earlier folders it may import;
3. what it must not do;
4. one `DO` and one `DO NOT` example for the most common drift.

The READMEs are operational guards. They are not explanatory prose to be kept
separate from implementation.

## Topology Checks

`composition/topology-checks.ts` should grow CI checks for:

- no Shape C subscriber `R` channel mentioning `WorkflowEngine` or
  `WorkflowInstance`;
- no `transforms/` export whose type includes `Effect.Effect`;
- no two subscribers owning the same state store tag;
- no read/write feedback cycle for the same table family unless explicitly
  approved as a durable operator;
- every Shape D folder has a README with a workflow-machinery justification;
- no target code imports `_archive/`;
- host-sdk imports runtime only through narrow target subpaths.

These can start as Semgrep/AST checks. They do not require new runtime
abstractions.

## Wave 1 Application

For the current Shape C cutover:

- `RuntimeContextInputFacts` is created under `tables/` or `producers/`
  depending on whether the file defines durable read/table state or append
  authority.
- `RuntimeContextStateStore` moves under `tables/runtime-context-state.ts`.
- `transitionInputEvent` and `transitionOutputEvent` move under
  `transforms/runtime-context-transition.ts`.
- `handleRuntimeContextEvent` moves under
  `subscribers/runtime-context/handler.ts`.
- the session-command sink moves under
  `subscribers/runtime-context-session/handler.ts`.
- `ToolCallWorkflow`, `WaitForWorkflow`, and `ScheduledPromptWorkflow` move or
  remain only under Shape D subscriber folders with README justification.
- `RuntimeContextWorkflowNative`, `runtime-input-deferred`, and body-driver
  helpers move to `_archive/` only if they cannot be deleted immediately.

The preferred greenfield endpoint is deletion, not indefinite archival.
`_archive/` is a staging area for deletion, not a compatibility layer.
