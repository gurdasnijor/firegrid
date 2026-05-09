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

## Bullets

- [001: Black-Box Agent Output To Runtime Events](./001-black-box-agent-output-to-durable-state.md)
- [002: Runtime Output Events To Session State](./002-runtime-events-to-session-state.md)
- [003: Runtime Events To Permission Workflow](./003-runtime-events-to-permission-workflow.md)
- [004: ACP Stdio Runtime Output To Materialize Session](./004-claude-code-runtime-output-to-materialize-session.md)

## Handoff

- [2026-05-08 Firegrid Durable Agent Tracers](./HANDOFF_FIREGRID_DURABLE_AGENT_TRACERS_2026-05-08.md)

## Architecture Decisions

- [Durable Streams As Runtime Truth, Durable State As Projection](../proposals/ADR_STREAMS_AS_RUNTIME_TRUTH_STATE_AS_PROJECTION.md)
- [Runtime Control Plane And Data Plane Boundary](../proposals/ADR_RUNTIME_CONTROL_PLANE_AND_DATA_PLANE_BOUNDARY.md)
- [Firegrid Runtime Package Has No Production Root](../proposals/SDD_FIREGRID_RUNTIME_PACKAGE_HAS_NO_PRODUCTION_ROOT.md)

## Sequence

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
```

The prerequisites establish the thin launch producer and live sandbox boundary.
The first bullet proves event production by consuming a sandbox's non-durable
command stream and journaling it durably. The second and third bullets prove
that downstream consumers can independently interpret the same durable journal
without coupling agent launch to session materialization or permission handling.
The fourth bullet proves a parallel query-engine path for endpoint demos without
changing Durable Streams authority.

Tracer 002 and tracer 003 are intentionally directional. They should be
re-scoped after tracer 001 is implemented and reviewed. Each fired tracer should
teach enough about the substrate and ergonomics to sharpen the next one.

## Rules

- Start from durable user intent, not from an internal helper.
- Land a production package or app surface for the path before calling a tracer
  implemented.
- Keep scenario wiring thin: scenarios invoke production surfaces instead of
  becoming hidden composition roots.
- End at durable, application-observable state.
- Treat live resources such as process handles, sockets, pipes, and PIDs as
  disposable.
- Keep runtime event payloads opaque until a projector or materializer maps them.
- Prefer one real provider/process over broad mocks.
- Do not add HTTP/RPC launch surfaces. The stream is the invocation boundary.
