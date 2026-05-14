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
5. `PRD_ALIGNMENT_ROADMAP_AUDIT.md`: Slice 2-safe roadmap work from the PRD
   alignment audit.
6. `litmus/LT-02-local-runtime-session-loop.md`: first product-shaped proof.
7. `litmus/LT-01-local-to-remote-shift.md`: later handoff proof.
8. `RISKS.md`: risk register and mitigation hooks.
9. `litmus/harness.md`: validation harness expectations.

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

Active implementation PRs:

- `#198` host-context authority. This is the active authority lane; avoid
  dispatching roadmap work that changes runtime context ownership, prompt
  routing, or MCP context authority until those slices land.
- `#202` Effect AI in-process provider. This validates local/in-process
  provider behavior and should not be duplicated by the remote provider
  substrate lane.
- `#203` PRD alignment roadmap audit. This is docs-only coordinator guidance
  for Slice 2-safe follow-up work.

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

Current execution order:

1. Finish host-context authority slices before work that depends on
   `RuntimeContext.host`, prompt append routing, or MCP route/session authority.
2. Finish the Effect AI in-process provider lane for local/in-process provider
   coverage.
3. Use `PRD_ALIGNMENT_ROADMAP_AUDIT.md` to dispatch independent follow-up work
   that stays Slice 2-safe: remote provider substrate validation, app-owned
   PermissionWait examples, env-backed secret resolution, ordering/provenance
   contract tests, and reconciliation harnesses.
4. Return to runtime presence, claimed-intent transport, execution-plane
   resources, and ownership-transfer work only when their dependencies are
   explicit and they do not collide with active host-context authority changes.

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
