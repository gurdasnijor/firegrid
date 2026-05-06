# Firegrid Current Wave Acai Tasks - 2026-05-06

This is the current handoff map for the Fireline / Firepixel readiness wave.
It supersedes the priority order in
`docs/ACAI_TASKS_FIREGRID_REMEDIATION_2026-05-05.md` for new dispatches, while
that older document remains useful provenance for the remediation ACIDs and
review findings it captured.

Do not run `acai push --all` without explicit approval.

## Current Foundation

The foundation-readiness evidence on `main` says Firegrid is ready for
Fireline-shaped and Firepixel-shaped systems:

- `docs/REVIEW_FIREGRID_FOUNDATION_READINESS_2026-05-06.md`
- `docs/SDD_FIREGRID_FIRELINE_READINESS.md`
- `docs/SDD_FIREGRID_FIREPIXEL_FOUNDATION.md`
- `docs/SDD_FIREGRID_RUNTIME_COMPOSITION_ERGONOMICS.md`

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

## Sequence

1. FP7 runtime composition helper.
   Agent 1 owns the runtime helper implementation. Do not parallel-edit
   runtime helper APIs. The helper must preserve explicit handler, subscriber,
   provider, and app adapter lists (`firegrid-runtime-process.RUNTIME_COMPOSITION.1-.6`).

2. FL1 Fireline composition-helper spike.
   CA3 is queued for this only after FP7 lands on `main`. Scope is
   scenario-only Fireline receiver/test/docs. It should prove the helper
   reduces receiver boilerplate without changing semantics, while still naming
   the projection-match subscriber, `Firegrid.handler`, `RunWait.layer(...)`,
   `triggerMatchersLayer(...)`, and any app adapter Layer explicitly.

3. C1 client API SDD.
   Agent 2 owns this in PR #84. Avoid `docs/README.md`,
   `docs/SDD_FIREGRID_CLIENT_API.md`, and
   `features/firegrid/firegrid-client-api.feature.yaml` until that PR lands or
   the coordinator redirects ownership.

4. C2 client API implementation or hardening.
   This follows C1 after the client API shape is settled. Do not start C2 from
   the proposal-era EventPlane SDD alone; use the landed C1 spec and
   coordinator dispatch as the source of truth.

5. LAB1 lab integration.
   Lab work should follow the client API sequence rather than re-opening
   runtime/substrate architecture. LAB1 should consume the settled public
   client/runtime/EventPlane surfaces instead of importing kernel internals.

## Current Follow-Up Queue

### FP7 - Runtime Composition Helper

Status: active outside this CA3 worktree.

Source of truth:

- `docs/SDD_FIREGRID_RUNTIME_COMPOSITION_ERGONOMICS.md`
- `firegrid-runtime-process.RUNTIME_COMPOSITION.1-.6`
- `firegrid-runtime-process.RUNTIME_RUN_API.6`
- `firegrid-runtime-process.RUNTIME_RUN_API.11`
- `firegrid-runtime-process.EFFECT_PLATFORM.6`

Non-negotiable boundary: the helper is only an ergonomic wrapper around
ordinary Effect Layers. It must not install default subscribers, load modules
dynamically, own Durable Streams server lifecycle, or encode Fireline,
Firepixel, ACP, MCP, prompt, permission, provider, session, or tool semantics.

### FL1 - Fireline Composition Helper Spike

Status: queued for CA3 after FP7 lands.

Scope:

- Touch `scenarios/firegrid` Fireline receiver/test/docs only.
- Use the FP7 helper as actually exported on `main`.
- Preserve the existing Fireline happy-path semantics
  (`firegrid-runtime-process.SCENARIOS.13`) and rejection-path semantics
  (`firegrid-runtime-process.SCENARIOS.14`).
- Keep app-facing receiver code on `RunWait` and curated public imports
  (`firegrid-runtime-process.SCENARIOS.16`).

Guardrails:

- No runtime helper edits.
- No `@firegrid/client`.
- No `@firegrid/substrate/kernel`, Choreography, or `DurableWaitsLive` in
  app-facing scenario code.
- No implicit subscribers.
- No Fireline-native substrate row families.
- No baselines, dev-server launchers, fixtures, or test-support folders.

### C1 / C2 / LAB1

Status: C1 active with another owner; C2 and LAB1 are sequence placeholders,
not self-assigned work.

Use the landed C1 spec for client API details once it merges. Until then, do
not re-litigate the Fireline / Firepixel foundation from older proposal docs.
The current architecture evidence is already captured by:

- `client-event-plane-registration.EVENT_PLANE_DEFINITION.5`
- `client-event-plane-registration.PROJECTION_API.7`
- `client-event-plane-registration.FIREPIXEL_PROFILE.1-.5`
- `firegrid-runtime-process.SCENARIOS.13-.21`
- `firegrid-runtime-process.RUNTIME_RUN_API.11`
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

