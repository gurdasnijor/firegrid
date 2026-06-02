# Firegrid Host SDK Execution Handoff Index

Date: 2026-05-16
Branch at refresh: `codex/host-sdk-sdd`

This folder is now the bootstrap packet for the team executing the SDK plane
split. The previous factory-production handoff is superseded by the Host SDK
execution handoff because factory should build on the new public planes rather
than old runtime internals.

## Start Here

1. `docs/handoffs/coordinator-handoff.md`
   - Execution lanes, current PR state, validation, and coordination rules.
2. `docs/sdds/SDD_FIREGRID_HOST_SDK.md`
   - Canonical SDK plane split SDD.
3. `features/firegrid/firegrid-host-sdk.feature.yaml`
   - Source-of-truth ACIDs for the SDK split.
4. `docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
   - Operation projection contract that governs client/tool/CLI bindings.
5. `features/firegrid/firegrid-schema-projection-contract.feature.yaml`
   - Source-of-truth ACIDs for schema projection.
6. `docs/research/output-path-pipeline-model.md`
   - Parallel read-only research lane for runtime output authority shape.
7. `packages/runtime/ARCHITECTURE.md`
   - Current post-reconciliation runtime layout and public surfaces.
8. `packages/runtime/src/agent-event-pipeline/README.md`
   - Agent event-pipeline boundary model.
9. `docs/sdds/SDD_FIREGRID_FACTORY_PLATFORM_FIT.md`
   - How factory should fit after the SDK planes exist.

Do not implement from `docs/sdds/SDD_FIREGRID_HOST_SDK_REVISED.md`; it is
non-canonical source material already folded into the main SDD.

## Active Theme

The team is about to start execution, not continue broad exploration. The work
is split into:

| Lane | Purpose | Can Run Now? |
| --- | --- | --- |
| A | `RuntimeToolUseExecutor` seam in runtime | Yes, after PR #280 merges or by explicit branch-from-PR decision |
| B | Transactional SDK package cutover planning | Yes, read/planning only until Lane A lands |
| C | Output-path pipeline research | Yes, read-only parallel lane |
| D | Factory follow-through on public SDK planes | After SDK packages land |

## Open Design Commitments

Preserve these unless a new spec change explicitly supersedes them:

- `@firegrid/protocol` is the schema and operation catalog.
- `@firegrid/client-sdk` is the browser/edge-safe session plane.
- `@firegrid/host-sdk` is the host plane.
- `@firegrid/cli` is the command binding.
- `@firegrid/runtime` is execution substrate and must not import SDK packages.
- `@firegrid/host-sdk` and `@firegrid/client-sdk` are siblings. Host-sdk must
  not import client-sdk.
- Product apps may compose both SDK packages, but package boundaries must not
  depend on product apps for correctness.
- Operation metadata comes from Effect Schema annotations, not copied
  `FiregridOperationEntry` metadata.
- Agent-tool bindings move out of runtime only after the
  `RuntimeToolUseExecutor` seam exists.
- Runtime durable authority projection-helper cleanup is optional and should
  not block SDK execution.

## Lane A: RuntimeToolUseExecutor Seam

Read:

- `docs/sdds/SDD_FIREGRID_HOST_SDK.md`
- `features/firegrid/firegrid-host-sdk.feature.yaml`
- `packages/runtime/src/agent-event-pipeline/subscribers/tool-router.ts`
- `packages/runtime/src/agent-tools/tool-use-to-effect.ts`
- `packages/runtime/src/host/runtime-substrate.ts`

ACIDs:

- `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.1`
- `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.2`
- `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.3`
- `firegrid-host-sdk.SEQUENCING.10`
- `firegrid-host-sdk.PACKAGE_GRAPH.6`

Goal: add the runtime-owned executor capability and route the existing tool
router through it without moving packages or changing behavior.

## Lane B: Transactional SDK Plane Cutover

Read:

- `docs/sdds/SDD_FIREGRID_HOST_SDK.md`
- `docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
- `packages/protocol/src/operations/schema.ts`
- `packages/protocol/src/session-facade/operations.ts`
- `packages/client/src/firegrid.ts`
- `src/run.ts`
- `.dependency-cruiser.cjs`

ACIDs:

- `firegrid-host-sdk.PROJECTION_BINDINGS.7`
- `firegrid-host-sdk.SEQUENCING.8`
- `firegrid-host-sdk.SEQUENCING.9`
- `firegrid-host-sdk.SEQUENCING.11`
- `firegrid-host-sdk.PACKAGE_GRAPH.2`
- `firegrid-host-sdk.PACKAGE_GRAPH.3`
- `firegrid-host-sdk.PACKAGE_GRAPH.4`
- `firegrid-host-sdk.PACKAGE_GRAPH.5`
- `firegrid-host-sdk.PACKAGE_GRAPH.7`
- `firegrid-host-sdk.PACKAGE_GRAPH.8`
- `firegrid-schema-projection-contract.BINDING_EXECUTION_SPLIT.2`

Goal: create the real SDK package boundaries and static rules in one coherent
cutover. Avoid long-lived packages that only re-export old mixed files.

## Lane C: Output-Path Pipeline Research

Read:

- `docs/research/output-path-pipeline-model.md`
- `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts`
- `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-appender.ts`
- `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts`
- `packages/runtime/src/authorities/runtime-control-plane-recorder.ts`
- `packages/runtime/src/durable-tools/internal/durable-wait-store.ts`

Goal: enumerate actual consumers and layer provision paths before any runtime
authority cleanup. This is read-only research and should not block Lane A or
Lane B unless it finds a direct contradiction with the SDD.

## Lane D: Factory Follow-Through

Read after the SDK packages exist:

- `docs/sdds/SDD_FIREGRID_FACTORY_PLATFORM_FIT.md`
- `docs/sdds/SDD_FIREGRID_DARK_FACTORY_APP.md`
- `docs/sdds/SDD_FIREGRID_FACTORY_RUN_PROCESS.md`
- `apps/factory/src/host.ts`
- `apps/factory/src/projections.ts`
- `apps/factory/src/projection-waits.ts`

Goal: build factory on the public session and host planes. Keep factory facts,
prompts, providers, and projections app-owned.

## Validation

Docs/spec lanes:

```sh
pnpm run check:specs
pnpm run check:docs
git diff --check
```

Runtime or SDK lanes:

```sh
pnpm run verify
```

Focused runtime seam lane:

```sh
pnpm --filter @firegrid/runtime typecheck
pnpm --filter @firegrid/runtime test
pnpm run lint
pnpm run lint:deps
pnpm run lint:dead
pnpm run lint:semgrep:test
pnpm run lint:semgrep
pnpm run check:specs
pnpm run check:docs
git diff --check
```

## Repository Hygiene

- Do not stage generated dependency graphs unless assigned graph work.
- Do not stage `docs/sdds/SDD_FIREGRID_HOST_SDK_REVISED.md`.
- Do not edit `repos/**`.
- Use `rg` for searches.
- Use `apply_patch` for manual edits.
- Remove stale worktrees after PRs merge.
