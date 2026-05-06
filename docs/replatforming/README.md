# Flamecast Replatforming on Firegrid

Status: build-facing draft packet

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

## Current Dispatch Priority

The next useful proof is not a substrate-only smoke script. It is LT-02:

```text
Flamecast UI starts a session
  -> app-owned Firegrid operation/event/wait descriptors
  -> local Node runtime built on @firegrid/runtime + Firegrid.composeRuntime
  -> normalized session events and follow-up messages
  -> Flamecast UI remains the control surface
```

Use `apps/flamecast` as the chassis target. Avoid throwaway examples and
standalone smoke scripts. If a public Firegrid API is missing, report that gap
directly rather than bypassing the substrate boundary.

## Proposal Archive

The old monolithic proposal at
`docs/proposals/SDD_FLAMECAST_REPLATFORMING_ON_FIREGRID.md` is superseded and
now points here.
