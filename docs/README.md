# Firegrid Docs

This directory holds Firegrid design documents, generated architecture
evidence, review packets, research notes, and historical context. Use this
index to avoid mixing current architecture with older substrate/lab-era plans.

The Acai feature files in `../features/firegrid/` are the formal contract. Code
and tests reference stable ACIDs from those feature files; design docs explain
the intent and trade-offs behind those requirements.

## Current Direction

Read these first for the current shape of Firegrid:

| Area | Document | Primary Specs |
| --- | --- | --- |
| Durable launch runtime operator | `proposals/SDD_FIREGRID_DURABLE_LAUNCH_RUNTIME_OPERATOR.md` | `firegrid-durable-launch-runtime-operator`, `workflow-engine-durable-state` |
| Product-neutral agent runtime substrate | `proposals/SDD_FIREGRID_AGENT_RUNTIME_SUBSTRATE.md` | `firegrid-agent-runtime-substrate`, `firegrid-platform-invariants` |
| Effect Workflow backed by Durable Streams State | `research/workflow-engine-integration.md` | `workflow-engine-durable-state` |
| Flamecast clean-room tracer over Firegrid | `proposals/SDD_FLAMECAST_FIREGRID_LAUNCH_TRACER.md` | `firegrid-durable-launch-runtime-operator` |
| Flamecast replatforming research | `replatforming/README.md` | n/a |
| Tooling, verification, and generated dependency evidence | `TOOLING.md` | `firegrid-remediation-hardening`, `firegrid-architecture-boundary`, `firegrid-package-migration` |

The current implementation shape is:

- `packages/protocol` — browser-safe launch schemas and Durable Streams State
  schema.
- `packages/client` — browser/app-facing launch client; must not import runtime
  code.
- `packages/runtime` — server-side durable workflow engine and durable launch
  runtime implementation.
- `apps/flamecast` — clean-room tracer app that exercises Firegrid without
  copying legacy Flamecast architecture.

## Generated Architecture Evidence

Generated artifacts are committed under `docs/` and refreshed with:

```sh
pnpm run arch:deps
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
