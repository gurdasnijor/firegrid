# Tool-surface audit (tf-636o)

- **Date:** 2026-06-02
- **Scope:** root `package.json` scripts, `scripts/`, the tiny-firegrid sim runner + corpus, and the tooling docs.
- **Method:** every surface inspected against current `main` — referenced file/target existence, actual run where safe, and `grep` for live consumers. Classifications cite evidence.
- **Bead:** tf-636o (also lands the arch-graph advisory + stale-script retirement + TOOLING.md rewrite).

## TL;DR

Nothing in the root `package.json` is *broken* after this PR (one regression — `verify` calling the now-deleted `lint:host-sdk-imports` — was introduced and fixed here). The real rot is **redundancy and stale analysis tooling**:

- **Three "run the gates" surfaces** (`check`, `verify`, `preflight`) that had drifted. `preflight` is canonical; `verify` is now a thin alias (this PR); `check` is a different (build-inclusive) chain — keep but documented.
- **Six `firegrid*` entrypoints** duplicated the unified `firegrid <sub>` bin (#830). The feature spec that named `firegrid:host` canonical was itself **stale** (predated #830) — corrected this PR, and the redundant scripts collapsed into `firegrid` + `firegrid:env`.
- **Removed this PR:** `effect:check` (orphan), `bootstrap` (trivial alias), `analysis:leaf` (+ its dead ast-grep `run-leaf-inventory.sh`).
- **`runtime-corpus.sh` (runtime-shrink-loop corpus) was earlier-phase tooling** — broken (manifest referenced deleted sims) and wired to no gate; **retired this PR** along with `runtime-flow-map.py` + `docs/architecture/corpus/`.
- A few **orphan/stale scripts**: `effect:check`, `analysis:leaf`.

## A. Root `package.json` scripts (44)

| Script | Status | Evidence / action |
|---|---|---|
| `bootstrap` | ❌ removed this PR | was `= pnpm install` (trivial alias, no consumers). |
| `build` / `test` / `typecheck` | ✅ works | turbo passthrough. |
| `check` | ⚠️ overlaps | `check:specs+check:docs+lint+effect:diagnostics+turbo run build check` — a 3rd gate chain, but uniquely includes `build`. Keep; doc its relation to `preflight`. |
| `check:specs` / `check:docs` | ✅ works | `tooling.mjs`. |
| `effect:check` | ❌ removed this PR | `effect-language-service check`; orphan (no consumers), redundant with the gated `effect:diagnostics`. |
| `effect:diagnostics(:baseline)` | ✅ works | gated in CI + preflight. |
| `effect:patch` / `effect:unpatch` | ✅ works | opt-in devtools. |
| `firegrid` | ✅ works | unified `@effect/cli` bin (`bin/firegrid.ts`) with `run`/`acp`/`host`/`start` subcommands (#830). |
| `firegrid:run`/`:acp`/`:host`/`:start`/`:host:env` | ❌ collapsed this PR | duplicated the unified `firegrid <sub>` bin (#830). The feature spec that named `firegrid:host` "the single host launch command" was itself **STALE** (it predated #830, which re-introduced the unified CLI — verified: `firegrid.ts` `withSubcommands(run/acp/host/start)`). Collapsed into `firegrid` + `firegrid:env` (the `.env`-loading variant); README + `runtime-env-boundary.md` repointed and the stale `firegrid-runtime-process` spec corrected. |
| `format` | ✅ works | `eslint . --fix`. |
| `publish:oss` | ✅ works | `scripts/publish-oss.sh`. |
| `lint` | ✅ works | **edited this PR** — dropped the deleted `effect-native-production-cutover-check.mjs` + `test-layout-check.mjs`; now `eslint + runtime-public-surface-check + tiny-firegrid-layout-check`. |
| `lint:test-layout` / `lint:host-sdk-imports(:baseline)` | ❌ removed | scripts retired this PR (stale/vacuous gates). |
| `lint:dead(:baseline)` / `lint:dup(:baseline)` / `lint:deps` / `lint:effect-quality(:baseline)` | ✅ works | all referenced scripts present. |
| `preflight` | ✅ canonical | `tooling/src/preflight.ts` — the complete, parallel gate (11 gates). The real review bar. |
| `verify` | ✅ fixed | **was** a serial subset that drifted (missing `effect:diagnostics` + `trace:seams:ukv`) **and** broke this PR by calling deleted `lint:host-sdk-imports`. Now `= pnpm run preflight` (drift-proof alias). |
| `arch:deps*` (8) | ✅ works | `tooling.mjs arch deps <t>` (`all`/`detail` are aggregate targets). **Output is now git-ignored** (this PR) — the committed graphs were retired for the advisory PR comment. `arch:graphs:check` removed. |
| `toy:coverage(:check)` | ✅ works | `tiny-config-prod-coverage.sh`. |
| `trace:seams` / `trace:seams:ukv` | ✅ works | `trace-seam-coverage.ts` / tiny-firegrid filter. |
| `analysis:leaf` | ❌ removed this PR | ran `tooling/analysis/run-leaf-inventory.sh`, which invokes **ast-grep** (retired; `tooling/ast-grep/` gone) → dead. Script + alias deleted. |

**Done this PR:** removed `effect:check`, `bootstrap`, `analysis:leaf` (+ dead `run-leaf-inventory.sh`), and collapsed the `firegrid:<sub>` family into the unified `firegrid` + `firegrid:env` — after verifying the feature spec that appeared to "protect" `firegrid:host` was itself stale (predated #830's unified CLI). Repointed README + `runtime-env-boundary.md` and corrected the `firegrid-runtime-process` spec. `check` vs `preflight` is documented in TOOLING.md.

## B. `scripts/` (23 files after this PR's 12 deletions)

| Group | Files | Status |
|---|---|---|
| Gate/quality (wired) | `tooling.mjs`, `runtime-public-surface-check.mjs`, `tiny-firegrid-layout-check.mjs`, `knip-{check,update}-baseline.mjs`, `jscpd-{check,update}-baseline.mjs`, `effect-quality-metrics-{check,baseline}.mjs`, `trace-seam-coverage.ts`, `tiny-config-prod-coverage.sh` | ✅ live (lint/preflight/CI) |
| Lane/coordination | `cmux-dispatch.sh`, `cmux-broadcast.sh`, `lane-sweep.sh`, `dispatch-gap.sh`, `task-{enter,exit,reap}.sh` | ✅ live (worktree flow) |
| Setup/publish | `install-git-hooks.sh` (+ `git-hooks/`), `publish-oss.sh` (+ `oss/`) | ✅ live |
| Earlier-phase analysis | `runtime-corpus.sh`, `runtime-flow-map.py` (+ `docs/architecture/corpus/`) | ❌ **RETIRED this PR** — runtime-shrink-loop tooling from an earlier phase; not wired to any gate/CI; manifest referenced deleted sims. |
| ACP trace analysis | `acp-trace-health.py` (+ `scripts/fixtures/acp-trace-health/`) | ✅ KEEP — still useful (maintainer-confirmed): standalone ACP-trace health/analysis CLI. |
| Retired this PR | `arch-graphs-check.sh`, `beads-sync*.sh`, `state-watch*.sh`, `install-*-cron.sh`, `signoff-queue.sh`, `phase1-workflow-core-paths-gate.sh`, `effect-native-production-cutover-check.mjs`, `test-layout-check.mjs`, `host-sdk-runtime-import-baseline.mjs`, `runtime-corpus.sh`, `runtime-flow-map.py` | ❌ deleted |

## C. tiny-firegrid sim runner — FIXED this PR

The runner *used to* discover sims by eagerly importing **every**
`simulations/<id>/index.ts` at startup, so one sim's unresolved import crashed
discovery for *every* sim — e.g. in a stale-`node_modules` checkout (no
`pnpm install` since #832/#833 added the `effect-durable-streams` workspace dep),
`verified-webhook-wait/host.ts`'s import killed `simulate run <any-id>`. It also
carried a hardcoded `hiddenFolders` denylist (a band-aid for non-conforming
folders that crashed the walk) and a recursive nested-folder walk (sims are
strictly one level deep), plus raw `node:fs/promises`.

**Rewritten (`runner/list.ts` + `runner/runtime.ts`):**
- `selectedSimulation(id)` imports **only the requested sim** — running one sim
  never loads (and so never trips over) any other.
- `listSimulations` loads each sim with **per-sim isolation** (`Effect.tryPromise`
  so a failing import is a typed, catchable error): a broken sim is skipped with a
  warning, not fatal.
- Dropped the stale `hiddenFolders` denylist (all 4 folders were already deleted)
  and the dead recursion; discovery is now a flat directory listing.
- Migrated `node:fs`/`node:path`/`node:url` → `@effect/platform` `FileSystem` +
  `Path` services (already provided by the CLI's `NodeContext.layer`).

(Still run `pnpm install` after merging `main` so the workspace symlinks exist —
but a stale dep can no longer sink unrelated sims.)

## D. Corpus (`runtime-corpus.sh` + `docs/architecture/corpus/`) — RETIRED

This was the **runtime-shrink-loop** corpus tooling from an earlier phase, not
current tooling. It was already broken (two of four `in_gate` scenarios —
`wait-pre-attach-roundtrip`, `delegation-proof-cap4` — no longer exist, so
`regen|check` hard-failed `UnknownSimulation`), and it is wired to no gate/CI.
**Retired this PR:** `scripts/runtime-corpus.sh`, `scripts/runtime-flow-map.py`
(its only consumer), and the `docs/architecture/corpus/` data dir
(`manifest.json` + `README.md`). The runtime-shrink *analysis docs*
(`docs/architecture/runtime-shrink-loop.md`, `runtime-dynamics-map.md`,
`runtime-shape-falsification.md`) are left as dated historical records.

## E. Tooling docs

- `docs/TOOLING.md` — **rewritten this PR.** Was badly stale: documented `pnpm verify` as "canonical" (it's a `preflight` alias now), the committed `docs/dependency-graph*.mmd` + `arch:deps:flamecast` (deleted/nonexistent), "five CI jobs" (miscount), and `apps/*` (deleted).
- `docs/contributing/quality-gates.md`, `effect-quality-metrics.md`, `acai-walkthrough.md`, `AGENTS.md` — reference `pnpm run verify`; still valid (it aliases preflight) but should name `preflight` as canonical. Lightly updated this PR where load-bearing.
- `docs/static-analysis-catalog.md`, `decisions.md`, `beads-operating-guide.md` — cleaned of retired-script references this PR (see the script-retirement work).

## Recommended beads (follow-ups, non-blocking)

1. ~~Resilient sim discovery~~ — **DONE this PR** (§C): per-sim isolation + lazy single-sim load + `@effect/platform` FileSystem/Path. Remaining (optional): migrate the read-side runner utilities (`show.ts`, `trace.ts`, `telemetry.ts` — incl. `execSync` git → `@effect/platform` `Command`, `perf.ts`, `phase1-gate.ts`) off raw `node:fs/path/child_process` for consistency.
