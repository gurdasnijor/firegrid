# composition/

Logical pipeline position: **7** (highest). May import every other folder
(`events/`, `tables/`, `producers/`, `transforms/`, `channels/`,
`subscribers/`). Must not be imported by any other folder in this tree.

Source: `docs/architecture/2026-05-22-runtime-physical-target-tree.md`,
`docs/architecture/host-sdk-runtime-boundary.md`.

## Owns

Runtime-local topology wiring:

- `host-live.ts` — the runtime-owned Layer graph that host-sdk installs to
  bring up the runtime. Composes `producers/`, `tables/`, `channels/`, and
  `subscribers/` into a single `Layer`. Reserved public subpath:
  `@firegrid/runtime/composition/host-live`.
- `topology-checks.ts` — CI checks that enforce the structural rules below.

This folder is the **only** place in `packages/runtime/src/` that legitimately
wires lower-order folders together. No business logic, no durable row
schemas, no transition behavior lives here.

This folder is NOT the host composition package. `packages/host-sdk/` remains
the outer host composition and public host facade. `composition/` is
runtime-internal layer plumbing; host-sdk installs the runtime layer through
the narrow public subpath above.

## May import

- every lower-order runtime folder
- `effect`, `effect/Layer`

## Must not import

- nothing in this tree imports `composition/` (highest-order rule)
- `_archive/` (target code never imports archived code)

## Topology checks (Wave 2 implementation)

`topology-checks.ts` should grow CI checks for:

- no Shape C subscriber `R` channel mentions `WorkflowEngine` or
  `WorkflowInstance` (Shape declared in each `subscribers/<name>/README.md`)
- no `transforms/` export whose type includes `Effect.Effect`
- no two subscribers owning the same state store tag
- no read/write feedback cycle for the same table family unless explicitly
  approved as a durable operator
- every Shape D folder has a README with a workflow-machinery justification
- no target code imports `_archive/`
- host-sdk imports runtime only through narrow target subpaths (mirrors the
  Semgrep gate; double-enforced)

## Scaffold status

Empty. Wave 2 lands `host-live.ts` (runtime layer graph) and
`topology-checks.ts` (CI enforcement). For this wave, the host-sdk import
gate runs as Semgrep rules under the existing `lint:semgrep` gate; the AST
checks come in when `topology-checks.ts` is implemented.
