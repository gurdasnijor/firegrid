# Architecture Handoff Folder

Date: 2026-05-20
Purpose: coordinator-ready breakdown of the private-beta architecture gap.

This folder consolidates Gary's architecture assessment and the companion
architect review into dispatchable cross-cutting concerns. It does not replace
the canonical docs in `docs/cannon/`; it is the planning layer for turning the
canonical target into the next few waves of work.

## Read Order

1. `docs/cannon/architecture/host-sdk-runtime-boundary.md`
2. `docs/cannon/architecture/current-convergence-assessment-2026-05-20.md`
3. `docs/handoffs/sprint-to-private-beta/architecture/01-convergence-scoreboard.md`
4. `docs/handoffs/sprint-to-private-beta/architecture/02-surface-hygiene-gates.md`
5. `docs/handoffs/sprint-to-private-beta/architecture/03-projection-contracts.md`
6. `docs/handoffs/sprint-to-private-beta/architecture/04-runtime-boundary-workstreams.md`
7. `docs/handoffs/sprint-to-private-beta/architecture/05-simulation-observability.md`
8. `docs/handoffs/sprint-to-private-beta/architecture/06-next-wave-sequencing.md`

Primary source assessments:

- `../02-GARY_ARCHITECTURE_ASSESSMENT.md`
- `../02b-COMPANION_ARCHITECTURE_ASSESSMENT.md`
- `../03-GARY_NEXT_SESSION_HANDOFF.md`

## Executive Read

Firegrid is close on substrate-boundary convergence, but the public surface is
not equally clean yet.

Recommended score split:

- **Substrate boundary:** about 90-93% converged.
- **Surface hygiene:** about 75-80% converged.

That split matters. The runtime/host-sdk substrate firewall is almost closed,
but private beta users interact with package exports, examples, simulations,
README snippets, span names, client helpers, CLI commands, and channel bindings.
Those surfaces can re-teach old substrate paths even after the substrate move is
mostly complete.

## Dominant Principle

The canonical package model is:

```text
protocol contracts
  -> projection/binding packages
  -> runtime-owned substrate
  -> durable streams/tables/workflow engine
```

Channels are the agent/application semantic surface for `wait_for`, `send`, and
`call`. They are not a universal replacement for launch, prompt, start, close,
permission-response, or other session/control operations. Those operations are
protocol/session projections over the same lower substrate.

Host SDK is a composition boundary, not a substrate owner.

## Private-Beta Acceptance Shape

Private beta is plausible when:

- the 8-file host-sdk substrate carveout list is zero or down to one named
  compatibility shim with no runtime behavior;
- host-sdk/client-sdk barrels no longer export substrate internals as public API;
- package READMEs, tiny-firegrid methodology, and examples no longer teach
  substrate imports;
- protocol is the source of truth for shared operation, observation, channel,
  and error schemas;
- one deterministic data-plane tour demonstrates the public client/session
  projection without host/runtime imports in the driver;
- span names used by docs, tests, dashboards, or perf gates have a baseline
  stability contract;
- external-trigger work follows schema-first sequencing.

