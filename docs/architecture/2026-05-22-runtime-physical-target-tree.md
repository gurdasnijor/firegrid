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

The directory tree is the data flow. Read it top to bottom and you have read
the runtime pipeline.

This is a runtime-package target. It does not replace
`docs/architecture/host-sdk-runtime-boundary.md`: host-sdk remains the outer
host composition and public host facade. The `7-composition/` folder below is
runtime-local topology wiring and CI topology checks, not an excuse for
host-sdk to import mixed runtime barrels or workflow-era host internals.

## Target Tree

```text
packages/runtime/src/
│
├── README.md                         # pipeline diagram + folder pointers
│
├── 1-events/                         # WHAT crosses boundaries
│   ├── README.md                     # event vocabulary; no I/O, state, behavior
│   ├── agent-input.ts                # AgentInputEvent union + schema
│   ├── agent-output.ts               # AgentOutputEvent union + schema
│   ├── runtime-ingress.ts            # RuntimeIngressInputRow schema
│   ├── runtime-output.ts             # RuntimeEventRow / RuntimeLogLineRow schemas
│   └── runtime-context-state.ts      # RuntimeContextEventState schema
│
├── 2-tables/                         # WHERE durable state lives
│   ├── README.md                     # DurableTable definitions; one table family per file
│   ├── runtime-control-plane.ts      # RuntimeControlPlaneTable
│   ├── runtime-output.ts             # RuntimeOutputTable
│   └── runtime-context-state.ts      # RuntimeContextStateStore
│
├── 3-producers/                      # WHO appends rows from live boundaries
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
├── 4-transforms/                     # HOW rows shape into facts/actions; PURE
│   ├── README.md                     # no Effect, no R channel, no I/O
│   ├── decode-ingress-row.ts         # agentInputEventFromRuntimeIngressRow
│   ├── decode-output-row.ts          # runtimeAgentOutputObservationFromRow
│   ├── field-equals.ts               # evaluateFieldEquals + FieldEqualsTrigger
│   └── runtime-context-transition.ts # transitionInputEvent / transitionOutputEvent
│
├── 5-channels/                       # WIRE-EDGE capability boundary
│   ├── README.md                     # Ingress/Egress/Callable/Bidirectional channel rules
│   ├── host-control/
│   ├── session/
│   ├── routes/                       # channel registrations -> route projections
│   └── router.ts                     # HostPlaneChannelRouter / RuntimeChannelRouter
│
├── 6-subscribers/                    # WHO reacts; Shape B / C / D
│   ├── README.md                     # shape table + R-channel rules
│   ├── B-projections/                # read-only, no state
│   ├── C-runtime-context/            # stateful per-event RuntimeContext handler
│   │   ├── README.md
│   │   ├── handler.ts
│   │   ├── state-ops.ts
│   │   └── action-dispatch.ts
│   ├── C-runtime-context-session/    # codec-session command sink, no workflow machinery
│   │   ├── README.md
│   │   └── handler.ts
│   ├── D-tool-dispatch/              # workflow-shaped; Activity memoization justified
│   │   ├── README.md
│   │   └── workflow.ts
│   ├── D-wait-router/                # workflow-shaped; durable wait/timeout justified
│   │   ├── README.md
│   │   └── workflow.ts
│   ├── D-scheduled-prompt/           # workflow-shaped; DurableClock justified
│   │   ├── README.md
│   │   └── workflow.ts
│   └── D-runtime-control/            # workflow-shaped host-control request workflows
│       ├── README.md
│       └── workflows.ts
│
├── 7-composition/                    # runtime-local topology wiring
│   ├── README.md                     # Layer graph; topology = Layer.mergeAll
│   ├── host-live.ts                  # runtime-owned layer graph for host-sdk to install
│   └── topology-checks.ts            # CI: shape, ownership, cycle checks
│
└── _archive/                         # wrong-shape code pending deletion
    └── workflow-engine/
        └── DEPRECATED.md             # names deletion bead/wave
```

## Dependency Direction

The numbered prefix is the allowed import direction.

- `1-events/` imports protocol schemas and base libraries only. It does not
  import runtime state, Effects, Layers, channels, subscribers, or workflow
  machinery.
- `2-tables/` imports `1-events/` and protocol row schemas. It owns
  DurableTable-backed state and event tables.
- `3-producers/` imports `1-events/` and `2-tables/`. It owns live scoped
  producers and table append authority.
- `4-transforms/` imports `1-events/` only. Every exported transform is pure;
  no `Effect`, `Layer`, `Context.Tag`, `Workflow.make`, `Activity.make`, or
  `DurableDeferred`.
- `5-channels/` imports `1-events/` and `2-tables/` as needed to implement
  channel bindings and route projections. It does not own subscriber logic.
- `6-subscribers/` imports lower-numbered folders. Shape D subscribers may
  import workflow machinery only inside `D-*` directories with a README
  justification.
- `7-composition/` imports the lower-numbered folders to build the runtime
  layer graph. It does not define business logic, durable row schemas, or
  transition behavior.

Imports from a lower-numbered folder to a higher-numbered folder are a
structure violation. The tree should make dependency cycles visible before the
typechecker does.

## Shape Prefix Rule

Inside `6-subscribers/`, the shape letter is part of the contract:

```text
B-*  read-only projection consumer
C-*  stateful keyed subscriber; no WorkflowEngine in R
D-*  workflow-shaped subscriber; WorkflowEngine allowed only with justification
```

A new subscriber's PR title should include the shape. Reviewers then know what
to check:

- `B-*`: no state store, no write authority.
- `C-*`: state/read/write tags allowed; no `WorkflowEngine`, no
  `WorkflowInstance`, no `Activity.make`, no parked body.
- `D-*`: workflow machinery is allowed only if the README names the load-bearing
  reason: Activity memoization, durable timer, cross-execution handoff, or
  restart-safe live side effect.

## Channels And Routes

`5-channels/` is the runtime wire-edge capability boundary:

- channel folders define typed `IngressChannel`, `EgressChannel`,
  `CallableChannel`, or `BidirectionalChannel` services;
- `routes/` projects typed channel registrations to router routes;
- `router.ts` owns wire-edge dispatch, schema parsing, direction/verb checks,
  and route invocation.

Channels are not subscribers. Subscribers consume channel tags through their
`R` channel.

## Composition Boundary

`7-composition/` is runtime-local topology wiring. It is where the runtime
Layer graph is assembled from lower-numbered runtime parts.

Host-sdk remains the host composition package. It may install runtime-owned
layers through narrow target subpaths, but it must not import mixed runtime
barrels such as `@firegrid/runtime/kernel` or reach into `_archive/`.

If host-sdk needs a runtime capability that is only available through a mixed
barrel today, first add a narrow target subpath under runtime. Do not import
the mixed barrel from host-sdk to keep a cutover moving.

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

Each numbered folder has a `README.md` with:

1. what the folder owns;
2. which lower-numbered folders it may import;
3. what it must not do;
4. one `DO` and one `DO NOT` example for the most common drift.

The READMEs are operational guards. They are not explanatory prose to be kept
separate from implementation.

## Topology Checks

`7-composition/topology-checks.ts` should grow CI checks for:

- no `C-*` subscriber `R` channel mentioning `WorkflowEngine` or
  `WorkflowInstance`;
- no `4-transforms/` export whose type includes `Effect.Effect`;
- no two subscribers owning the same state store tag;
- no read/write feedback cycle for the same table family unless explicitly
  approved as a durable operator;
- every `D-*` folder has a README with a workflow-machinery justification;
- no target code imports `_archive/`;
- host-sdk imports runtime only through narrow target subpaths.

These can start as Semgrep/AST checks. They do not require new runtime
abstractions.

## Wave 1 Application

For the current Shape C cutover:

- `RuntimeContextInputFacts` moves under `2-tables/` or `3-producers/`
  depending on whether the file defines the table service or append authority.
- `RuntimeContextStateStore` moves under `2-tables/runtime-context-state.ts`.
- `transitionInputEvent` and `transitionOutputEvent` move under
  `4-transforms/runtime-context-transition.ts`.
- `handleRuntimeContextEvent` moves under
  `6-subscribers/C-runtime-context/handler.ts`.
- the session-command sink moves under
  `6-subscribers/C-runtime-context-session/handler.ts`.
- `ToolCallWorkflow`, `WaitForWorkflow`, and `ScheduledPromptWorkflow` move or
  remain only as `D-*` subscribers with README justification.
- `RuntimeContextWorkflowNative`, `runtime-input-deferred`, and body-driver
  helpers move to `_archive/` only if they cannot be deleted immediately.

The preferred greenfield endpoint is deletion, not indefinite archival. `_archive/`
is a staging area for deletion, not a compatibility layer.
