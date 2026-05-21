# Firegrid Docs

Doc-Class: dispatchable
Status: active

This directory holds Firegrid design documents, generated architecture
evidence, review packets, research notes, and historical context. Use this
index to avoid mixing current architecture with older substrate/lab-era plans.

Every doc here carries a class. Read
[`contributing/docs-taxonomy-and-lifecycle.md`](contributing/docs-taxonomy-and-lifecycle.md)
first: it defines `public-narrative` / `internal-contract` /
`historical-reference` / `dispatchable`, the lifecycle status words, and the
rule that **`cannon/README.md` is the dispatch allowlist** — anything not linked
there is `historical-reference` by default, even if it looks current.

The Acai feature files in `../features/firegrid/` are the formal contract. Code
and tests reference stable ACIDs from those feature files; design docs explain
the intent and trade-offs behind those requirements.

## Current Direction

**Start with [`cannon/README.md`](cannon/README.md).** The `docs/cannon/` tree
is the compact canonical source-of-truth set for the current host-sdk/runtime
boundary, agent body plan, one-substrate workflow engine, host-plane channel
router, durable sync/async semantics, private-beta convergence state, and active
next-step proposals. It is the dispatch allowlist: docs in `docs/sdds/`,
`docs/research/`, and `docs/proposals/` are `historical-reference` unless
promoted or linked from `docs/cannon/README.md`.

> The previous "read these first" table that lived here pointed at the durable
> launch runtime operator, workflow-driven runtime planes (`firegrid-durable-tools`),
> and per-edge launch tracer proposals as current direction. Those predate the
> deletion of `durable-tools` and the channel-router/ACP-edge cutover, so they
> are now `historical-reference`. Do not dispatch from them; use
> `cannon/README.md`. The files still exist under `docs/proposals/` and
> `docs/research/` as historical rationale.

Still-useful operational entry points (not architecture direction):

| Area | Document | Class |
| --- | --- | --- |
| Tooling, verification, and generated dependency evidence | [`TOOLING.md`](TOOLING.md) | dispatchable |
| Agent development recommendations | [`contributing/agent-development-recommendations-2026-05-13.md`](contributing/agent-development-recommendations-2026-05-13.md) | internal-contract |
| Docs taxonomy and lifecycle rule | [`contributing/docs-taxonomy-and-lifecycle.md`](contributing/docs-taxonomy-and-lifecycle.md) | internal-contract |
| Flamecast replatforming research | [`replatforming/README.md`](replatforming/README.md) | historical-reference |

Doc categories:

- Root and package READMEs describe current user-facing APIs.
- Runbooks give exact commands for operational validation and smoke tests.
- Proposals and SDDs explain design rationale and trade-offs.
- Tracers describe end-to-end proof paths and scenario evidence.
- Reviews and research notes are historical or investigative context unless a
  current-direction doc links to them.

The current implementation shape is:

- `packages/protocol` — browser-safe launch + channel schemas, channel
  contracts/Tags, and Durable Streams State schema.
- `packages/client` — browser/app-facing launch client; must not import runtime
  code.
- `packages/runtime` — server-side durable workflow engine, channel route
  implementations, and durable launch runtime implementation.
- `packages/host-sdk` — host-author composition; composes the host-plane channel
  router and edges. Must not own durable route bodies.
- `apps/flamecast` — clean-room tracer app that exercises Firegrid without
  copying legacy Flamecast architecture.

## Generated Architecture Evidence

Generated artifacts are committed under `docs/` and refreshed with:

```sh
pnpm run arch:deps
```

Run the detailed module-level graph set when reviewing import direction inside
packages or tracer apps:

```sh
pnpm run arch:deps:detail
```

Strict dependency-boundary enforcement runs with:

```sh
pnpm run lint:deps
```

Artifacts:

- `dependency-graph.mmd` — workspace-level dependency graph.
- `dependency-graph-client.mmd` — client package graph.
- `dependency-graph-protocol.mmd` — protocol package graph.
- `dependency-graph-runtime.mmd` — runtime package graph.
- `dependency-graph-flamecast.mmd` — Flamecast tracer app graph.
- `dependency-graph-detail.mmd` — workspace module-level graph.
- `dependency-graph-runtime-detail.mmd` — runtime module-level graph.
- `dependency-graph-runtime-control-data-detail.mmd` — runtime control/data module graph.
- `dependency-graph-flamecast-detail.mmd` — Flamecast module-level graph.

Do not hand-edit generated graph files. Regenerate them after intentional
package-shape or import-boundary changes.

## Historical Context

These documents can be useful background, but they predate the current durable
launch/runtime direction. If they conflict with the current-direction table
above, the current docs and Acai specs win.

- `sdds/SDD_FIREGRID_ARCHITECTURE_AND_INVOCATION_BOUNDARY.md`
- `sdds/SDD_DURABLE_AGENT_SUBSTRATE.md`
- `sdds/SDD_LAUNCHABLE_SUBSTRATE_HOST_AND_LAB.md`
- `sdds/SDD_FIREGRID_PACKAGE_STRUCTURE.md`
- `sdds/SDD_FIREGRID_EFFECT_QUALITY.md`
- `sdds/SDD_FIREGRID_RUNTIME_CLI_VALIDATION.md`
- `sdds/SDD_DURABLE_AGENT_RUNTIME_LAB.md`
- `reviews/*.md`
- `handoffs/**/*.md`

Historical docs may mention retired names such as `@firegrid/substrate`,
`@firegrid/lab`, `apps/lab`, `packages/substrate`, `pnpm run graph`,
`pnpm run arch:reports`, or Effect artifact inventory outputs. Treat those as
old evidence, not current implementation guidance.

## How To Read The Repo Now

1. Start with the current-direction document for the area you are touching.
2. Open the matching Acai feature file under `../features/firegrid/`.
3. Search code and tests for the full ACID references.
4. Use generated dependency graphs for ground-truth import shape.
5. Treat old review notes and historical SDDs as context only.
