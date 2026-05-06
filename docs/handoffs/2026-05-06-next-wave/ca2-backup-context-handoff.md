# CA2 Backup Context Handoff

Date: 2026-05-06
Owner: CA2 / surface:54
Scope: backup implementation context for the next Firegrid package-boundary and agent-runtime integration wave

## Role Summary

CA2 was primarily used as a focused Firegrid implementer and backup diagnostician. The strongest use pattern was narrow, spec-driven implementation in isolated worktrees, followed by CI-authoritative review routing and explicit cleanup after coordinator merge confirmation.

Recommended next-wave use:

- Use CA2 for narrow Firegrid public-surface hardening lanes.
- Use CA2 as a sidecar diagnostician when CI fails in a way that needs independent log/package/config analysis.
- Use CA2 for app-facing lab or client seam work when the guardrails are already specified.
- Do not use CA2 as the speculative product designer for broad adapter semantics unless a spec lane has already narrowed the boundary.

## Recent CA2 Context

Recent completed Firegrid lanes included:

- Runtime and substrate remediation slices, including runtime stream hot paths, state-machine simplification, shared infrastructure deduplication, source-grep cleanup, RunWait idempotent resume, receiver scenarios, and Firepixel/EventPlane scenario coverage.
- Client and lab public-surface slices, including client API SDD/implementation/runbook/smoke/browser-surface/example hardening and LAB4 operation `call` / `result` workbench.
- Read-only PKG1 red-CI diagnosis for PR #100.

The most recent CA2 diagnosis:

- PR #100 CI failed because the committed PR head changed `@firegrid/substrate` and `@firegrid/client` package exports to dist-only entries while CI typecheck/tests run before any package build in a fresh checkout.
- `packages/substrate typecheck` passed but did not create `dist`, then `packages/client typecheck` could not resolve `@firegrid/substrate/descriptors`, `@firegrid/substrate/id-gen`, or `@firegrid/substrate`.
- Lint and effect diagnostics failures were downstream unresolved-type fallout.
- Local PKG1 checks were not representative of PR head because the PKG1 worktree had uncommitted source-resolution fixes.
- CA2 did not edit or push in that sidecar lane.

## Local State

Observed at handoff time from `/Users/gnijor/gurdasnijor/firegrid`:

- Primary checkout: `main` at `7fe1dad`.
- Primary checkout is divergent from `origin/main` in this local clone (`ahead 270, behind 7` was reported by `git status`).
- `docs/handoffs/` is untracked in the local primary checkout and contains this next-wave handoff folder.
- `git worktree list` shows only the primary checkout.
- `git branch --list 'agent2/*'` returns no local CA2 branches.
- Completed CA2 worktrees and local branches have been removed.

Do not force-reset, rewrite, or clean the primary checkout unless the user explicitly asks. For any new implementation lane, start from the requested remote base in a fresh worktree under:

```text
/Users/gnijor/gurdasnijor/firegrid/.worktrees/<lane-slug>
```

## Working Protocol

Use the repo-local Acai workflow for behavior changes:

- Read the relevant SDD and feature YAML first.
- If behavior is not specified, stop and ask for a spec lane rather than implementing from vibes.
- Reference complete ACIDs in tests or important code comments.
- Do not renumber ACIDs.
- Run `check:docs` / `check:specs` when docs or specs change.
- Do not run broad local `pnpm verify` as routine handoff validation; CI remains authoritative. Use targeted local checks to debug concrete failures.

Implementation flow:

1. Fetch the requested base.
2. Create a dedicated worktree under `.worktrees/`.
3. Keep scope exactly to assigned files/packages.
4. Use targeted local checks.
5. Push branch and open PR.
6. Wait for GitHub CI green and merge state CLEAN.
7. Route review to the assigned review surface.
8. Do not merge.
9. After coordinator merge confirmation, remove worktree and delete local branch.
10. Confirm cleanup to coordinator.

## cmux Etiquette

Coordinator surface is `surface:33`.

Always submit messages with Enter. Use this exact pattern:

```sh
cmux send --workspace workspace:2 --surface surface:33 "[to-proxy-agent] <message>"
cmux send-key --workspace workspace:2 --surface surface:33 Enter
```

The same Enter rule applies to every other surface:

```sh
cmux send --workspace workspace:2 --surface surface:66 "<message>"
cmux send-key --workspace workspace:2 --surface surface:66 Enter
```

Good implementation updates include:

- Lane name.
- Repo.
- Worktree path.
- Branch.
- PR number and URL if opened.
- Head SHA.
- CI status.
- Merge state.
- Local targeted checks.
- Cleanup status after merge.

Good sidecar diagnosis updates include:

- The exact PR/head/CI run inspected.
- The first failing command in CI order.
- The minimal cause.
- Why local checks did or did not reproduce CI.
- Confirmation that no files were edited.

## How To Use CA2 Next Wave

High-fit assignments:

- Firegrid package-public-surface audits and narrow guard hardening.
- External consumer smoke diagnosis where packed artifacts, exports, TypeScript resolution, or Vite resolution are involved.
- Lab/client seam work that must preserve public API boundaries.
- Focused scenario validation using already-landed public APIs.
- Read-only backup review of CI failures before asking the owning implementer to patch.

Lower-fit assignments unless narrowed by spec:

- Broad new adapter package design.
- Provider lifecycle management.
- Registry or discovery systems.
- Browser UI beyond a clearly scoped lab/client seam.
- Cross-repo product semantics that have not been mapped to Firegrid public surfaces.

## Blocker And Stop Conditions

Stop and report instead of coding if:

- The only apparent solution imports `@firegrid/substrate/kernel`, runtime internals, raw durable writers, or control-plane helpers from app/client/product code.
- A lane needs terminal row authorship from outside Firegrid runtime handlers.
- A product scenario needs semantics that would add Fireline/Firepixel vocabulary as Firegrid-native row families.
- An external consumer can pass only by depending on workspace paths, sibling repo paths, checked-in tarballs, or unbuilt `dist` artifacts.
- CI failure appears caused by fresh-checkout ordering, package export conditions, build-before-test assumptions, or uncommitted local state.
- A requested change requires baseline edits and the lane did not explicitly authorize them.
- A broad local check is requested only as routine validation; ask whether targeted checks plus CI are sufficient.

## Guardrail Memory

Keep these boundaries active:

- No `@firegrid/client -> @firegrid/runtime` edge.
- No substrate kernel/control-plane leakage into client, lab UI, scenarios, or product code.
- No `RunWait` in browser/client/lab UI.
- No fake terminal state in lab or app-facing demos.
- No dynamic runtime module loading.
- No dev-server launcher workaround.
- No package source changes in docs-only handoff lanes.
- No pushing from sidecar diagnostic lanes unless explicitly redirected.

## Suggested First Read For Next CA2 Session

Start with:

1. `docs/handoffs/2026-05-06-next-wave/TEAM_INDEX.md`
2. `docs/handoffs/2026-05-06-next-wave/coordinator-handoff.md`
3. This file.
4. The role/lane-specific SDD or feature YAML for the assigned lane.

Then inspect current `origin/main` and create a fresh worktree only after an explicit dispatch.
