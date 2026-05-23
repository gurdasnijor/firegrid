# composition/

Logical pipeline position: **7** (highest). May import every other folder
(`events/`, `tables/`, `producers/`, `transforms/`, `channels/`,
`subscribers/`) **for Layer assembly only**. Must not be imported by any
other folder in this tree.

The import permission is strictly to read Layer/`Context.Tag` exports and
compose them into the runtime Layer graph. It is **not** permission to call
producer/codec/handler/transition functions directly, to write durable rows,
to drive sessions, or to execute workflow bodies. Behavior runs through the
composed Layer; `composition/` only wires it.

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
schemas, no transition behavior, no codec/session driving, no workflow
bodies, no table read/write calls live here.

A file in `composition/` should consist of `Layer.succeed` / `Layer.effect`
/ `Layer.scoped` / `Layer.merge` / `Layer.provide` calls and the matching
type-level wiring. If a file in `composition/` is calling a producer's
append function, a subscriber's handler, or invoking a transition directly,
that behavior belongs in the corresponding lower-order folder; `composition/`
just installs the Layer that supplies the capability.

This folder is NOT the host composition package. `packages/host-sdk/` remains
the outer host composition and public host facade. `composition/` is
runtime-internal layer plumbing; host-sdk installs the runtime layer through
the narrow public subpath above.

## May import

- every lower-order runtime folder, but **only for Layer/`Context.Tag`
  composition** (read service tags and Layer factories; combine them)
- `effect`, `effect/Layer`

## Must not import / must not do

- nothing in this tree imports `composition/` (highest-order rule)
- `_archive/` (target code never imports archived code)
- direct execution of producer append functions, codec/session driving,
  subscriber handler invocation, transition calls, table reads/writes, or
  workflow body execution — those are owned by the lower-order folders and
  reached through the composed Layer at runtime, never invoked inline here

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
