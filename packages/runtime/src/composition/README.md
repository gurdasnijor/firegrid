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

## Topology checks

CI invariants for the runtime tree are enforced **externally**, not by an
in-tree `topology-checks.ts` module. The current enforcement surfaces:

| Check | Where |
| --- | --- |
| Required target surfaces exist + READMEs, no numeric prefixes, no stale paths. | `scripts/runtime-public-surface-check.mjs` |
| `kernel/` / `workflow-engine/` legacy roots stay empty. | `scripts/legacy-runtime-roots-scoreboard.mjs` |
| Per-tier import direction (`events → tables → producers/transforms/channels → subscribers → composition`); no `_archive/` imports from target code. | `.dependency-cruiser.cjs` |
| Shape D workflow-machinery justification; host-sdk reaches runtime only through narrow target subpaths. | `.semgrep.yml` |

A future `composition/topology-checks.ts` may grow AST-level checks that
duplicate or extend these (e.g., no transform export whose type includes
`Effect.Effect`, no two subscribers owning the same state-store tag) — see #756.
Until then this folder contains Layer wiring only.
