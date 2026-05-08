# Firegrid Tracer Bullets

This folder captures narrow end-to-end tracer bullets for Firegrid's durable
agent substrate.

A tracer bullet is not a component demo. It starts at a real product-facing
intent and ends at the target observable outcome, crossing every architectural
boundary needed to prove the path. Each bullet should stay small enough to
delete or reshape, but complete enough to expose whether the system design is
actually coherent.

## Bullets

- [001: Black-Box Agent Output To Provider-Wire Journal](./001-black-box-agent-output-to-durable-state.md)
- [002: Provider-Wire Journal To Session State](./002-provider-wire-journal-to-session-state.md)
- [003: Provider-Wire Journal To Permission Workflow](./003-provider-wire-journal-to-permission-workflow.md)

## Handoff

- [2026-05-08 Firegrid Durable Agent Tracers](./HANDOFF_FIREGRID_DURABLE_AGENT_TRACERS_2026-05-08.md)

## Sequence

```txt
Prerequisite
  thin client launch surface
    -> launch({ runtime: providerHelper(...) })
    -> no caller-provided launch id, planes, bindings, journal, or streams
    -> append normalized launch intent row only

Prerequisite
  sandbox provider contract
    -> create/get_or_create/find
    -> execute/stream/upload/download/destroy
    -> stream(command) yields non-durable live process chunks

001
  launch(...)
    -> durable workflow
    -> sandbox command stream
    -> durable provider-wire journal

002
  durable provider-wire journal
    -> downstream materializer
    -> State Protocol session-state stream

003
  durable provider-wire journal
    -> downstream permission workflow
    -> durable permission request / approval wait / input response
```

The prerequisites establish the thin launch producer and live sandbox boundary.
The first bullet proves event production by consuming a sandbox's non-durable
command stream and journaling it durably. The second and third bullets prove
that downstream consumers can independently interpret the same durable journal
without coupling agent launch to session materialization or permission handling.

Tracer 002 and tracer 003 are intentionally directional. They should be
re-scoped after tracer 001 is implemented and reviewed. Each fired tracer should
teach enough about the substrate and ergonomics to sharpen the next one.

## Rules

- Start from durable user intent, not from an internal helper.
- End at durable, application-observable state.
- Treat live resources such as process handles, sockets, pipes, and PIDs as
  disposable.
- Keep provider wire formats opaque until a projector or materializer maps them.
- Prefer one real provider/process over broad mocks.
- Do not add HTTP/RPC launch surfaces. The stream is the invocation boundary.
