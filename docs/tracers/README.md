# Firegrid Tracer Bullets

This folder captures narrow end-to-end tracer bullets for Firegrid's durable
agent substrate.

A tracer bullet is not a component demo. It starts at a real product-facing
intent and ends at the target observable outcome, crossing every architectural
boundary needed to prove the path. Each bullet should stay small enough to
delete or reshape, but complete enough to expose whether the system design is
actually coherent.

Tracer completion requires a production composition surface. Scenario and test
code are adjacent proof: they configure the production surface, run it, and
assert durable outcomes. They do not own the only working Layer graph, stream
topology, or provider wiring for the tracer path. This is governed by
`firegrid-platform-invariants.PRODUCTION_SURFACE.*`.

Scenario-level end-to-end coverage is mandatory for every implemented tracer.
Package/unit tests can prove internal contracts, but they do not complete a
tracer unless a scenario also invokes the production surface and observes the
durable outcome across the tracer's architectural boundary.
Contract tests in package test files are useful for edge cases and typed
interfaces, but scenario tests must stay as high fidelity and production-like as
the local environment allows. If a real dependency can be run locally through
Docker, a local process, or a production package surface, the scenario should
use it rather than a mock. Skips are acceptable only for missing external
runtime capabilities such as Docker or credentials, and the skipped scenario
must make that dependency explicit.

## Bullets

- [001: Black-Box Agent Output To Runtime Events](./001-black-box-agent-output-to-durable-state.md)
- [002: Runtime Output Events To Session State](./002-runtime-events-to-session-state.md)
- [003: Runtime Events To Permission Workflow](./003-runtime-events-to-permission-workflow.md)
- [004: ACP Stdio Runtime Output To Materialize Session](./004-claude-code-runtime-output-to-materialize-session.md)
- [005: Durable Streams Substrate Extraction](./005-durable-streams-substrate-extraction.md)
- [006: Runtime Host Root And Launch Boundary](./006-runtime-host-root-and-launch-boundary.md)
- [007: Sandbox Slot Extraction](./007-sandbox-slot-extraction.md)
- [008: Materialization Strategy Interface](./008-materialization-strategy-interface.md)
- [009: Required-Action Workflow](./009-required-action-workflow.md)
- [010: Workflow-Backed Tools](./010-workflow-backed-tools.md)
- [011: Projection Target Schema Ownership](./011-projection-target-schema-ownership.md)
- [012: Agent Ingress Prompt Stream](./012-agent-ingress-prompt-stream.md)
- [013: Reactive Workflow Operators](./013-reactive-workflow-operators.md)
- [016: Session Plane Input Control Surface](./016-session-plane-input-control-surface.md)
- [017: Effect Durable Operators](./017-effect-durable-operators.md)
- [018: Cluster-Shaped Workflow Activity Ownership](./018-cluster-shaped-workflow-activity-ownership.md)
- [019: Workflow-Driven Runtime Next Wave](./019-workflow-driven-runtime-next-wave.md)
- [020: Verified Webhook Ingest To Durable Facts](./020-verified-webhook-ingest-to-durable-facts.md)

## Handoff

- [2026-05-08 Firegrid Durable Agent Tracers](./HANDOFF_FIREGRID_DURABLE_AGENT_TRACERS_2026-05-08.md)

## Architecture Decisions

- [Durable Streams As Runtime Truth, Durable State As Projection](../proposals/ADR_STREAMS_AS_RUNTIME_TRUTH_STATE_AS_PROJECTION.md)
- [Runtime Control Plane And Data Plane Boundary](../proposals/ADR_RUNTIME_CONTROL_PLANE_AND_DATA_PLANE_BOUNDARY.md)
- [Firegrid Runtime Package Has No Production Root](../proposals/SDD_FIREGRID_RUNTIME_PACKAGE_HAS_NO_PRODUCTION_ROOT.md)

## Sequence

The current workflow-driven runtime sequence is captured in
[019: Workflow-Driven Runtime Next Wave](./019-workflow-driven-runtime-next-wave.md).
Use that document for near-term dispatch and parallelization. The historical
sequence below records how the early tracer program evolved and should not be
read as the current implementation order.

```txt
Prerequisite
  thin client launch surface
    -> launch({ runtime: providerHelper(...) })
    -> no caller-provided runtime context id, planes, bindings, journal, or streams
    -> append normalized runtime context row only

Prerequisite
  sandbox provider contract
    -> create/get_or_create/find
    -> execute/stream/upload/download/destroy
    -> stream(command) yields non-durable live process chunks

001
  launch(...)
    -> durable workflow
    -> sandbox command stream
    -> durable runtime output data-plane events

002
  durable runtime output data-plane events
    -> downstream materializer
    -> State Protocol session-state stream

003
  durable runtime output data-plane events
    -> downstream permission workflow
    -> durable permission request / approval wait / input response

004 (parallel)
  launch real ACP stdio agent, starting with claude-acp
    -> durable runtime output data-plane events
    -> Materialize webhook source
    -> SQL session materialized view
    -> SELECT/SUBSCRIBE endpoint query path

005
  extract Durable Streams substrate concerns
    -> @firegrid/durable-streams owns direct @durable-streams/* imports
    -> runtime consumes workflow/log/producer/state helpers through Effect services
    -> tracer 001 and 002 keep passing through production surfaces

006
  define runtime host root vs client launch request
    -> host root chooses substrate/materialization/provider registry
    -> client launch describes one agent request only
    -> current runtime context flow runs through production root

007
  extract sandbox launch slot
    -> sandbox core owns streamCommand(...) contract
    -> local process becomes the first provider
    -> tracer 001 keeps proving command stream journaling

008
  define materialization strategy interface
    -> runtime host selects materialization backend
    -> tracer 002 runs through common strategy API
    -> state-protocol/raw-fold/materialize strategy shape is tested

009
  implement required-action workflow
    -> runtime emits permission/required-action request event
    -> workflow waits durably for resolution event or timeout
    -> approval/rejection resumes through Effect workflow machinery

010
  expose workflow-backed tools
    -> sleep/wait_for/schedule_me/spawn use durable workflow semantics
    -> spawn(agent, prompt) calls the same launch surface clients use
    -> agent tool layer can consume Firegrid runtime capabilities

011
  define projection target schema ownership
    -> projection target owns schemas, encoders, folds, and query adapters
    -> materialization strategies stop hardcoding session schemas
    -> State Protocol/raw-fold strategies can run non-session projections

012
  define durable agent prompt ingress
    -> initial and follow-up prompts append provider-neutral durable input facts
    -> runtime adapters translate durable ingress to stdin/ACP/provider protocols
    -> delivery progress is durable and runtime output remains a separate journal

013
  define reactive workflow operators
    -> durable facts/time/projection predicates trigger Effect workflows
    -> required actions become the first consumer of the generic operator substrate
    -> tools and ingress subscribers stop needing bespoke workflow launch paths

016
  define session-plane input control surface
    -> request_session / launch and send_input / prompt become the only stable
       session-plane control operations
    -> runtime_ingress remains transitional physical vocabulary for session
       input / prompt request facts
    -> client/app input reaches a real provider through host-owned dispatchers,
       with durable progress and no workflow-specific endpoint

017
  define generic Effect durable operators
    -> table/projection/consumer operators compose effect-durable-streams,
       @durable-streams/state, and Effect primitives
    -> application-level requested-minus-progress folds move behind a generic
       DurableConsumer checkpoint service
    -> Firegrid runtime input becomes a consumer proof, not the package shape
```

The prerequisites establish the thin launch producer and live sandbox boundary.
The first bullet proves event production by consuming a sandbox's non-durable
command stream and journaling it durably. The second and third bullets prove
that downstream consumers can independently interpret the same durable journal
without coupling agent launch to session materialization or permission handling.
The fourth bullet proves a parallel query-engine path for endpoint demos without
changing Durable Streams authority.
The fifth, sixth, eighth, eleventh, and thirteenth bullets are architecture
tracers: they validate substrate, host-root, strategy, projection-target, and
reactive-operator seams before the repo commits to broader package extraction.

Tracer 007 onward should be refined with feedback from the preceding tracer.
Each fired tracer should teach enough about the substrate and ergonomics to
sharpen the next one.

## Rules

- Start from durable user intent, not from an internal helper.
- Land a production package or app surface for the path before calling a tracer
  implemented.
- Add a scenario-level end-to-end proof for every implemented tracer; package
  tests alone are never enough.
- Keep scenario wiring thin: scenarios invoke production surfaces instead of
  becoming hidden composition roots.
- End at durable, application-observable state.
- Treat live resources such as process handles, sockets, pipes, and PIDs as
  disposable.
- Keep runtime event payloads opaque until a projector or materializer maps them.
- Prefer one real provider/process over broad mocks.
- Do not add HTTP/RPC launch surfaces. The stream is the invocation boundary.

## Parallel Dispatch Guardrails

When multiple tracers run at once, each tracer owns only its documented write
scope. Shared architecture artifacts are integration-owned, not tracer-owned:

```txt
docs/dependency-graph*.mmd
docs/architecture/current-architecture-alignment-review.md
```

Tracer branches should not touch those files unless the tracer is explicitly an
architecture-graph or architecture-review update. Regenerate graphs in a single
integration pass after feature tracers merge.

Parallel tracers should prefer additive production surfaces over edits to a
shared root. If a tracer needs `packages/runtime/src/runtime-host/**`, the
handoff must state exactly which host surface it owns and which other tracer
must avoid that file.
