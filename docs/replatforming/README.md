# Flamecast Replatforming on Firegrid

Status: execution packet

This folder is the dispatch packet for moving Flamecast durable agent-runtime
mechanics onto Firegrid. It exists to keep the architecture, ownership
boundary, execution plan, and review guardrails readable without turning any
one SDD into a catch-all document.

Authoritative implementation requirements live in Acai feature specs under the
repo-root `features/<product>/` tree. These docs cite ACIDs and explain how the
specs compose.

## Read Order

1. `SDD.md`: durable rationale, platform shape, and staged build path.
2. `OWNERSHIP.md`: launch contract and ownership matrix.
3. `DECISIONS.md`: stable planning decisions and ACID references.
4. `GUARDRAILS.md`: hard review stops and dispatch rules.
5. `litmus/LT-02-local-runtime-session-loop.md`: first product-shaped proof.
6. `litmus/LT-01-local-to-remote-shift.md`: later handoff proof.
7. `RISKS.md`: risk register and mitigation hooks.
8. `litmus/harness.md`: validation harness expectations.

## Spec Authority

The first spec stack has landed:

- `firegrid-platform-invariants.*`
- `flamecast-product-contract.*`
- `firegrid-agent-runtime-substrate.*`
- `firegrid-observability.*`
- `firegrid-projection-query.*`
- `firegrid-client-projection-api.*`
- `firegrid-durable-subscriber-webhooks.*`
- `firegrid-runtime-presence.*`
- `firegrid-execution-plane-resources.*`
- `firegrid-runtime-ownership-transfer.*`
- `firegrid-scheduling-tool-bindings.*`
- `firegrid-claimed-intent-transport.*`

Implementation PRs should cite the smallest relevant ACID set. Do not invent a
parallel requirement ID system in implementation plans, tests, or review notes.

## Current State

The planning/spec stack is landed. We are no longer dispatching broad SDD or
feature-spec authoring for the core lanes listed above.

Shipped implementation proofs:

- LT-02 `apps/flamecast` chassis: browser UI plus separate local Node runtime
  process, deterministic local adapter, app-owned `Operation` and
  `EventStream`, durable replay on refresh, and runtime restart recovery.
- Firegrid observability MVP: Effect-native substrate spans for client
  operations, EventStreams, and runtime handler execution.
- Firegrid projection query MVP: browser-safe
  `@firegrid/client/projection-query` facade with `liveQuery(...)`,
  descriptor-scoped read access, Schema-backed cursor/errors, and explicit
  low-level escape hatches.

Active implementation PR:

- `#120` durable channel subscriber primitives. This is the current blocking
  core Firegrid lane. Finish and merge it before dispatching another durable
  delivery/subscriber lane.

## Dispatch Priority

The product-shaped proof is now LT-02 in `apps/flamecast`; do not replace it
with substrate-only smoke scripts. Use the chassis as the integration target:

```text
Flamecast UI starts a session
  -> app-owned Firegrid operation/event/wait descriptors
  -> local Node runtime built on @firegrid/runtime + Firegrid.composeRuntime
  -> normalized session events and follow-up messages
  -> Flamecast UI remains the control surface
```

Next execution order:

1. Finish `#120` durable channel subscriber primitives.
2. Implement runtime presence MVP:
   - durable runtime/host/node public presence descriptor;
   - runtime publisher Layer for startup, readiness, heartbeat, and retirement;
   - projection/query selection by readiness, freshness, topology, and public
     metadata;
   - tests proving presence is advisory discovery, not a command bus, host
     mesh, credential directory, or leader-election primitive.
3. Wire runtime presence into the LT-02 chassis so the UI can select or display
   a local runtime-backed provider through durable public presence.
4. Implement claimed-intent transport for follow-up/prompt-like work:
   intent -> claim -> side effect -> terminal, with Flamecast prompt/session
   semantics staying outside Firegrid core.
5. Return to execution-plane resources and ownership transfer only after the
   local-runtime session loop and runtime presence path are stable.

Avoid:

- new smoke-only scripts that bypass `apps/flamecast`;
- Flamecast-only RPC facades;
- direct `@firegrid/substrate/kernel` imports in app code;
- raw `durable.run` or fake terminal rows;
- product vocabulary in Firegrid packages.

## Proposal Archive

The old monolithic proposal at
`docs/proposals/SDD_FLAMECAST_REPLATFORMING_ON_FIREGRID.md` is superseded and
now points here.
