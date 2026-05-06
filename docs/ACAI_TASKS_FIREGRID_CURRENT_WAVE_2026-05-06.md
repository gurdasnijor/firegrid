# Firegrid Current Wave Acai Tasks - 2026-05-06

This is the current handoff map for the Fireline / Firepixel readiness wave.
It supersedes the priority order in
`docs/ACAI_TASKS_FIREGRID_REMEDIATION_2026-05-05.md` for new dispatches, while
that older document remains useful provenance for the remediation ACIDs and
review findings it captured.

Do not run `acai push --all` without explicit approval.

## Current Foundation

The foundation-readiness evidence on `main` says Firegrid is ready for
Fireline-shaped and Firepixel-shaped systems. Since this handoff was created,
FP7, FL1-FL3, C2-C4, and LAB0-LAB2 have landed:

- `docs/REVIEW_FIREGRID_FOUNDATION_READINESS_2026-05-06.md`
- `docs/SDD_FIREGRID_FIRELINE_READINESS.md`
- `docs/SDD_FIREGRID_FIREPIXEL_FOUNDATION.md`
- `docs/SDD_FIREGRID_RUNTIME_COMPOSITION_ERGONOMICS.md`
- `docs/SDD_FIREGRID_CLIENT_API.md`

The settled boundaries for this wave are:

- Fireline and Firepixel vocabulary stays app-owned. Firegrid must not add
  product-specific substrate row families.
- EventStream remains the descriptor-scoped event replay surface.
- EventPlane is the stateful caller-owned row family and projection surface
  (`client-event-plane-registration.BOUNDARY.6`).
- App handlers use `RunWait` for durable wait primitives, not
  `@firegrid/substrate/kernel`, Choreography, or `DurableWaitsLive`
  (`run-wait-primitives.RUN_WAIT_API.6`,
  `firegrid-runtime-process.SCENARIOS.16`).
- Runtime entrypoints call `run({ connection, runtime })` with explicitly
  composed handlers, subscribers, `RunWait.layer(...)`, EventPlane layers,
  trigger matchers, and app adapter Layers. Stock subscribers are not implicit
  (`firegrid-runtime-process.RUNTIME_RUN_API.6`).
- `Firegrid.composeRuntime({ subscribers, handlers, provide })` is the landed
  helper for readable app-owned runtime graphs. FL1-FL3 adopted it across
  scenario receiver runtime entrypoints without adding implicit subscribers.
- `@firegrid/client` now has a landed public API boundary from C2, a
  runbook/smoke path from C3, and browser/surface hardening from C4; LAB0-LAB2
  have landed the lab-side client seam/readiness path through
  `FiregridClient`.

## Sequence

1. Further Fireline / Firepixel integration work.
   Future work can build product-specific adapters, providers, transports,
   prompts, permissions, and UX on top of the foundation. It must keep product
   vocabulary app-owned and use the public EventPlane, RunWait, runtime
   composition, and client/lab boundaries.

## Current Follow-Up Queue

### FP7 / FL1-FL3 - Runtime Composition Helper And Adoption

Status: landed on `main`.

Source of truth:

- `docs/SDD_FIREGRID_RUNTIME_COMPOSITION_ERGONOMICS.md`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.1-.6`
- `firegrid-runtime-process.RUNTIME_RUN_API.6`
- `firegrid-runtime-process.RUNTIME_RUN_API.11`
- `firegrid-runtime-process.EFFECT_PLATFORM.6`

The helper is only an ergonomic wrapper around ordinary Effect Layers. FL1-FL3
prove it across scenario receiver runtime entrypoints while preserving explicit
subscriber, handler, `RunWait.layer(...)`, EventPlane layer, trigger matcher,
and app adapter Layer lists.

### C1 / C2 / C3 / C4 / LAB0 / LAB1 / LAB2

Status: C1, C2, C3, C4, and LAB0-LAB2 are landed.

Use the landed C1/C2/C3/C4 spec, implementation, runbook, and browser-boundary
evidence for client API details. LAB2 migrated the LAB0/LAB1 seam/readiness
path through the public client boundary rather than reaching around it. The
current architecture evidence is captured by:

- `client-event-plane-registration.EVENT_PLANE_DEFINITION.5`
- `client-event-plane-registration.PROJECTION_API.7`
- `client-event-plane-registration.FIREPIXEL_PROFILE.1-.5`
- `firegrid-client-api.STREAM_CONFIGURATION.1`
- `firegrid-client-api.AUTHORITY_BOUNDARY.5`
- `firegrid-client-api.LAB_COMPATIBILITY.1`
- `firegrid-client-api.LAB_COMPATIBILITY.4`
- `firegrid-runtime-process.SCENARIOS.13-.21`
- `firegrid-runtime-process.RUNTIME_RUN_API.11`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.1-.6`
- `run-wait-primitives.RUN_WAIT_API.8`
- `durable-waits-and-scheduling.WAIT_FOR.9`

## Do Not Re-Litigate

These decisions are settled for the current wave unless a new spec changes
them:

- EventPlane is the current stateful higher-layer row/projection surface.
- EventStream is still valid for descriptor-scoped event replay and one-shot
  scenario rows.
- `RunWait.for(...)` is the handler suspension API; projection-match subscriber
  Layers belong in runtime composition.
- Tool invocation, permission, prompt, adapter, provider, sandbox, ACP, MCP,
  Claude, and Codex semantics are app-owned EventPlane or adapter concerns.
- Firegrid owns operation dispatch, durable wait authoring, projection-match
  completion resolution, ready-work claims, and terminal run authority.
