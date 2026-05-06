# Flamecast Replatforming on Firegrid

Status: draft

This folder is the build-facing packet for moving Flamecast durable
agent-runtime mechanics onto Firegrid.

Authoritative implementation requirements live in Acai feature specs under the
repo-root `features/<product>/` tree. These docs explain the rationale,
ownership boundary, decisions, risks, review guardrails, and litmus tests. They
should cite ACIDs once feature specs exist rather than restating requirements.

## Files

- `SDD.md`: durable rationale and platform shape.
- `OWNERSHIP.md`: launch contract and concern ownership.
- `DECISIONS.md`: architecture decisions that specs and PRs should cite.
- `RISKS.md`: risk register for replatforming and smoke work.
- `GUARDRAILS.md`: review-time hard rules and enforcement notes.
- `litmus/LT-01-local-to-remote-shift.md`: local-to-remote agent shift
  scenario.
- `litmus/LT-02-local-runtime-session-loop.md`: Flamecast UI to local
  `@firegrid/runtime` session loop scenario.
- `litmus/harness.md`: validation harness expectations.

## Spec Authority

Use root-level Acai specs:

```text
features/firegrid/
features/flamecast/
```

The first spec should be `features/firegrid/firegrid-platform-invariants.feature.yaml`.
It should encode shared boundary, locality, security, and anti-scope rules.
Lane specs should cite those invariant ACIDs in their own constraints.

## Current Proposal Source

This packet is derived from:

- `docs/proposals/SDD_FLAMECAST_REPLATFORMING_ON_FIREGRID.md`
- `docs/proposals/SDD_FIREGRID_PROJECTION_QUERY.md`
- `docs/proposals/SDD_FIREGRID_OBSERVABILITY.md`
- `docs/proposals/SDD_DURABLE_WEBHOOK_SUBSCRIBERS.md`
- `docs/sdds/SDD_DURABLE_AGENT_SUBSTRATE.md`
