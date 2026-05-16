# Coordinator Handoff: Host SDK Execution Phase

Date: 2026-05-16
Repo: `/Users/gnijor/gurdasnijor/firegrid`
Working branch: `codex/host-sdk-sdd`
Branch head when refreshed: `3102b1e0f`
`origin/main` when refreshed: `fc27b9576`

## Objective

Move Firegrid from "runtime internals are the app integration surface" to the
SDK plane split defined by the Host SDK SDD:

- `@firegrid/client-sdk` owns the session plane.
- `@firegrid/host-sdk` owns host composition, provider installation, MCP, and
  host-side execution authority wiring.
- `@firegrid/cli` owns command binding.
- `@firegrid/runtime` remains the execution substrate and must not import SDK
  packages.

The next team should treat this as an execution handoff, not a design reset.
The design is now specific enough to start implementation once PR #280 lands.

## Canonical Inputs

Start with these files, in order:

1. `docs/handoffs/coordinator-handoff.md`
2. `docs/handoffs/TEAM_INDEX.md`
3. `docs/sdds/SDD_FIREGRID_HOST_SDK.md`
4. `features/firegrid/firegrid-host-sdk.feature.yaml`
5. `docs/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
6. `features/firegrid/firegrid-schema-projection-contract.feature.yaml`
7. `packages/runtime/ARCHITECTURE.md`
8. `packages/runtime/src/agent-event-pipeline/README.md`
9. `docs/research/output-path-pipeline-model.md`

The canonical SDK SDD is `docs/sdds/SDD_FIREGRID_HOST_SDK.md`.
`docs/sdds/SDD_FIREGRID_HOST_SDK_REVISED.md` is source material only; do not
review or implement from it.

Use the Acai process. Specs are the source of truth. Preserve stable ACIDs and
reference full ACIDs in implementation tests or important code comments.

## Current State

PR #280 is the active docs/spec PR for the SDK plane split:

```txt
https://github.com/gurdasnijor/firegrid/pull/280
branch: codex/host-sdk-sdd
head:   3102b1e0f docs: record runtime capability projection helper pattern
base:   origin/main fc27b9576
```

It updates:

- `docs/sdds/SDD_FIREGRID_HOST_SDK.md`
- `features/firegrid/firegrid-host-sdk.feature.yaml`

Validation already passed on the touched docs/specs:

```sh
pnpm run check:specs
pnpm run check:docs
git diff --check -- docs/sdds/SDD_FIREGRID_HOST_SDK.md features/firegrid/firegrid-host-sdk.feature.yaml
```

Unrelated local generated dependency graph files may still be dirty in the
coordinator checkout. Do not stage or repair them unless explicitly assigned.

## Decisions To Preserve

- `sessions.createOrLoad` stays. Do not rename it to `launch`.
- `externalKey` stays as the caller-owned durable convergence key. Do not
  introduce a second `idempotencyKey` spelling.
- `local.jsonl(...)` stays as the helper that produces
  `PublicLaunchRuntimeIntent`. Do not introduce a second `Agent.localProcess`
  spelling.
- Runtime config intent belongs to the session plane. Host configuration owns
  provider availability and environment exposure policy.
- `@firegrid/host-sdk` and `@firegrid/client-sdk` are sibling projections over
  `@firegrid/protocol`; host-sdk must not import client-sdk.
- Browser/session code must not import runtime, host-sdk, Node modules, Effect
  AI, MCP, or platform-node.
- Host SDK core must not import concrete provider packages such as Linear,
  GitHub, Slack, or agent providers. Product apps or CLI roots install those
  adapters explicitly.
- `FiregridOperationEntry` and `defineFiregridOperation` are deleted in the
  transactional binding cutover. Bindings read plain `{ input, output }`
  schema groups and Effect Schema annotations.
- Runtime tool routing depends on a runtime-owned `RuntimeToolUseExecutor`
  capability. Runtime must not import host-sdk agent-tool bindings.
- Runtime durable authority projection helpers, if implemented, are optional
  cleanup and must not block PR 1 or PR 2.

## Execution Lanes

### Lane A: PR 1 RuntimeToolUseExecutor Seam

Purpose: land the one structural inversion before moving files.

ACIDs:

- `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.1`
- `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.2`
- `firegrid-host-sdk.TOOL_EXECUTOR_SEAM.3`
- `firegrid-host-sdk.SEQUENCING.10`
- `firegrid-host-sdk.PACKAGE_GRAPH.6`

Scope:

- Add `RuntimeToolUseExecutor` under
  `packages/runtime/src/agent-event-pipeline/subscribers/`.
- Rewrite `tool-router.ts` to consume that tag instead of importing
  `toolUseToEffect` directly.
- Add a temporary live executor layer in runtime host substrate that delegates
  to the current `toolUseToEffect`.
- Provide that layer from the current host composition.
- Keep behavior identical. No package moves in this PR.

Primary files to inspect:

- `packages/runtime/src/agent-event-pipeline/subscribers/tool-router.ts`
- `packages/runtime/src/agent-tools/tool-use-to-effect.ts`
- `packages/runtime/src/host/runtime-substrate.ts`
- `packages/runtime/src/host/layers.ts`
- `packages/runtime/test/**/tool*.test.ts`

Validation:

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

### Lane B: PR 2 Transactional SDK Plane Cutover

Purpose: make the package boundary visible everywhere in one coherent diff.

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

Scope:

- Delete production use of `FiregridOperationEntry` and
  `defineFiregridOperation`.
- Replace operation catalogs with plain grouped schema values:
  `{ input, output }`.
- Create `packages/client-sdk`, `packages/host-sdk`, and `packages/cli`.
- Move binding files and execution files to their target packages in the same
  PR. Do not publish empty re-export shells as a long-lived intermediate.
- Add dependency-cruiser, boundary tests, and/or semgrep rules for the package
  graph.
- Update product/scenario consumers after the package graph is correct.
- Preserve current session, typed wait, permission, and CLI behavior.

Primary files to inspect:

- `packages/protocol/src/operations/schema.ts`
- `packages/protocol/src/session-facade/operations.ts`
- `packages/protocol/src/agent-tools/schema.ts`
- `packages/client/src/firegrid.ts`
- `packages/client/test/firegrid.boundary.test.ts`
- `packages/runtime/src/agent-tools/**`
- `packages/runtime/src/host/**`
- `src/run.ts`
- `.dependency-cruiser.cjs`
- `package.json`
- `pnpm-workspace.yaml`

Validation: run `pnpm run verify`. If the diff is very large, also run focused
package tests before the full verify sweep.

### Lane C: Output-Path Pipeline Research

Purpose: run a parallel read-only research lane so runtime authority cleanup is
based on data, not inference.

Source document:

- `docs/research/output-path-pipeline-model.md`

Scope:

- Enumerate every consumer of output/ingress/control-plane/durable-tool
  authority tags.
- Trace layer provision graphs and redundant provision sites.
- Trace the codec output path and compare Sink vs direct append semantics.
- Reconcile findings with the Host SDK plane split.

Constraints:

- No code edits.
- Do not propose fixes until the consumer enumeration is complete.
- Do not block PR 1 or PR 2 unless the research uncovers a direct contradiction
  in the SDK SDD.

Deliverable:

- A research result document or patch to
  `docs/research/output-path-pipeline-model.md` containing the requested
  tables and findings.

### Lane D: Factory Follow-Through

Purpose: keep factory aligned with the SDK plane split without letting factory
drive package boundaries.

Inputs:

- `docs/sdds/SDD_FIREGRID_FACTORY_PLATFORM_FIT.md`
- `docs/sdds/SDD_FIREGRID_DARK_FACTORY_APP.md`
- `docs/sdds/SDD_FIREGRID_FACTORY_RUN_PROCESS.md`

Rules:

- Do not build new factory work on old runtime host imports.
- Keep product facts, prompts, providers, and projections app-owned.
- Use client-sdk session primitives and host-sdk host composition once the SDK
  packages exist.
- Do not reintroduce `SourceCollections`, arbitrary runtime wait-source names,
  or TypeScript planner-to-implementer orchestration chains.

## Coordination Rules

- Do not send cmux updates from the coordinator session to itself.
- Worker lanes should send review-shaped updates only: branch, PR, validation,
  blockers, and exact scope.
- PR 1 and the output-path research can run in parallel.
- PR 2 should wait for PR 1, but a planning lane can enumerate moves and static
  rules while PR 1 is in review.
- Do not stage generated dependency graphs unless the assigned work is graph
  regeneration.
- Do not stage `docs/sdds/SDD_FIREGRID_HOST_SDK_REVISED.md`; it is scratch
  source material.

## Fresh-Session Bootstrap Checklist

1. Run `git status --short --branch`.
2. Confirm PR #280 has merged or explicitly decide to branch from
   `codex/host-sdk-sdd`.
3. Read `docs/sdds/SDD_FIREGRID_HOST_SDK.md` and
   `features/firegrid/firegrid-host-sdk.feature.yaml`.
4. For PR 1, list the exact ACIDs above in the task note before editing.
5. Use `rg` to inspect current `tool-router.ts` and `toolUseToEffect`
   dependencies before patching.
6. Keep the PR 1 diff behavior-preserving.
7. Run the focused validation and open a PR.
8. Only after PR 1 is merged, start the transactional package cutover.

## Validation Commands

Docs/spec lanes:

```sh
pnpm run check:specs
pnpm run check:docs
git diff --check
```

Runtime or SDK package lanes:

```sh
pnpm run verify
```

Focused PR 1 runtime lane:

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
