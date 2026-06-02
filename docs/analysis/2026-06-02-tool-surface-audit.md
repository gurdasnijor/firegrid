# Tool-surface audit (tf-636o)

- **Date:** 2026-06-02
- **Scope:** root `package.json` scripts, `scripts/`, the tiny-firegrid sim runner + corpus, and the tooling docs.
- **Method:** every surface inspected against current `main` — referenced file/target existence, actual run where safe, and `grep` for live consumers. Classifications cite evidence.
- **Bead:** tf-636o (also lands the arch-graph advisory + stale-script retirement + TOOLING.md rewrite).

## TL;DR

Nothing in the root `package.json` is *broken* after this PR (one regression — `verify` calling the now-deleted `lint:host-sdk-imports` — was introduced and fixed here). The real rot is **redundancy and stale analysis tooling**:

- **Three "run the gates" surfaces** (`check`, `verify`, `preflight`) that had drifted. `preflight` is canonical; `verify` is now a thin alias (this PR); `check` is a different (build-inclusive) chain — keep but documented.
- **Six `firegrid*` entrypoints** where the unified `firegrid` bin already exposes `run`/`acp`/`host`/`start` subcommands — the four `firegrid:<sub>` scripts are redundant.
- **`runtime-corpus.sh` (runtime-shrink-loop corpus) was earlier-phase tooling** — broken (manifest referenced deleted sims) and wired to no gate; **retired this PR** along with `runtime-flow-map.py` + `docs/architecture/corpus/`.
- A few **orphan/stale scripts**: `effect:check`, `analysis:leaf`.

## A. Root `package.json` scripts (44)

| Script | Status | Evidence / action |
|---|---|---|
| `bootstrap` | redundant | `= pnpm install`. Harmless alias; could drop. |
| `build` / `test` / `typecheck` | ✅ works | turbo passthrough. |
| `check` | ⚠️ overlaps | `check:specs+check:docs+lint+effect:diagnostics+turbo run build check` — a 3rd gate chain, but uniquely includes `build`. Keep; doc its relation to `preflight`. |
| `check:specs` / `check:docs` | ✅ works | `tooling.mjs`. |
| `effect:check` | 🔸 orphan | `effect-language-service check`; referenced **nowhere** but package.json. Redundant with `effect:diagnostics` (the gated one). Candidate to drop. |
| `effect:diagnostics(:baseline)` | ✅ works | gated in CI + preflight. |
| `effect:patch` / `effect:unpatch` | ✅ works | opt-in devtools. |
| `firegrid` | ✅ works | unified `@effect/cli` bin (`bin/firegrid.ts`) with `run`/`acp`/`host`/`start` subcommands (#830). |
| `firegrid:run` / `:acp` / `:host` / `:start` / `:host:env` | 🔸 redundant | duplicate the unified bin's subcommands (verified `firegrid.ts` defines all four). Keep only if used as muscle-memory shortcuts; otherwise collapse to `firegrid <sub>`. (`:host:env` adds `--env-file-if-exists` — the one with extra value.) |
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
| `analysis:leaf` | 🔸 stale | `tooling/analysis/run-leaf-inventory.sh` exists, but its only consumer reference is a **closed** ast-grep-era bead (tf-lt6); ast-grep is retired. Verify + likely drop. |

**Recommendation (root scripts):** collapse the 4 redundant `firegrid:<sub>` shortcuts (keep `firegrid` + `:host:env`), drop `effect:check` and `bootstrap`, verify/drop `analysis:leaf`. Document `check` vs `preflight`. (Left as a follow-up bead — non-breaking, and the consolidation is a maintainer preference call.)

## B. `scripts/` (23 files after this PR's 12 deletions)

| Group | Files | Status |
|---|---|---|
| Gate/quality (wired) | `tooling.mjs`, `runtime-public-surface-check.mjs`, `tiny-firegrid-layout-check.mjs`, `knip-{check,update}-baseline.mjs`, `jscpd-{check,update}-baseline.mjs`, `effect-quality-metrics-{check,baseline}.mjs`, `trace-seam-coverage.ts`, `tiny-config-prod-coverage.sh` | ✅ live (lint/preflight/CI) |
| Lane/coordination | `cmux-dispatch.sh`, `cmux-broadcast.sh`, `lane-sweep.sh`, `dispatch-gap.sh`, `task-{enter,exit,reap}.sh` | ✅ live (worktree flow) |
| Setup/publish | `install-git-hooks.sh` (+ `git-hooks/`), `publish-oss.sh` (+ `oss/`) | ✅ live |
| Earlier-phase analysis | `runtime-corpus.sh`, `runtime-flow-map.py` (+ `docs/architecture/corpus/`) | ❌ **RETIRED this PR** — runtime-shrink-loop tooling from an earlier phase; not wired to any gate/CI; manifest referenced deleted sims. |
| | `acp-trace-health.py` (+ `scripts/fixtures/acp-trace-health/`) | 🔸 adjacent May ACP-validation-phase trace probe; referenced only by historical investigation docs — likely also retire (left pending confirmation). |
| Retired this PR | `arch-graphs-check.sh`, `beads-sync*.sh`, `state-watch*.sh`, `install-*-cron.sh`, `signoff-queue.sh`, `phase1-workflow-core-paths-gate.sh`, `effect-native-production-cutover-check.mjs`, `test-layout-check.mjs`, `host-sdk-runtime-import-baseline.mjs`, `runtime-corpus.sh`, `runtime-flow-map.py` | ❌ deleted |

## C. tiny-firegrid sim runner

The runner discovers sims by eagerly importing **every** `simulations/<id>/index.ts` at startup. Consequence (observed): in a checkout with stale `node_modules` (e.g. the primary checkout that hasn't `pnpm install`-ed since #832/#833 added the `effect-durable-streams`/`effect-durable-operators` workspace deps), `verified-webhook-wait/host.ts`'s import of `effect-durable-streams` fails to resolve and **crashes discovery for *every* sim** — `simulate run <any-id>` dies with `Cannot find package 'effect-durable-streams'`, masking unrelated failures.

- **Immediate cause:** stale deps → run `pnpm install` after merging `main` (the recurring post-merge rule). In a fresh-installed worktree the symlink (`packages/tiny-firegrid/node_modules/effect-durable-streams → ../../effect-durable-streams`) exists and discovery succeeds.
- **Design smell (bead-worthy):** one sim's unresolved import shouldn't sink the whole runner. `runner/list.ts` should load sims resiliently (per-sim try/catch, report the failing sim id, continue) so a single bad/heavy import is a localized error.

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

1. **Resilient sim discovery** (P2) — per-sim try/catch in `runner/list.ts` so one bad/heavy import doesn't sink the whole runner (it currently does — §C).
2. **Collapse redundant root scripts** (P3) — the 4 `firegrid:<sub>` shortcuts, `effect:check`, `bootstrap`, `analysis:leaf`.
3. **Confirm/retire `acp-trace-health.py`** (P3) — adjacent May-phase probe; retire with its fixture if the ACP-trace-health investigations are closed.
