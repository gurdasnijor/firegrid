# Tooling / CI-infra handoff — 2026-06-02

Role: **tooling / dev-infra / CI** lane. Scope: preflight, CI workflow, lint/static-analysis config, knip, turbo, task-enter/exit, scripts. Do **not** touch product code (`unified/`, sims, `packages/*/src` logic) — coordinate via the Coordinator for that.

## Where things are

- **We are on `main` now** (#765 merged the unified-kernel trunk → main). Branch off `origin/main`, not `sim/unified-kernel-validation`. CI runs on `pull_request` + `push:[main]`, so **merges to main seed the turbo/eslint caches** that PR branches restore (this is what made the caching pay off).
- **Merge note:** the in-session Coordinator persona normally owns merges; this session the **product owner directed merges directly**, so I merged everything below. Keep that ownership in mind by default.
- **Worktree discipline:** always work in `/tmp/fg-*` worktrees off `origin/main`; never edit the primary checkout; `pnpm install` in each fresh worktree (task-enter now auto-installs); clean up worktrees after merge.

## Shipped this session (all merged to main)

| PR | What |
|---|---|
| #786 | lockfile sync for the `tooling/` workspace pkg + knip-clean it (the original CI break) |
| #796 | **dropped the duplicate `effect:diagnostics`** that ran in both the lint script and its own job (lint gate 44s→1.6s local); ESLint `--cache` + Turbo cache via `actions/cache` |
| #797 | **per-package turbo `effect:diagnostics`** — split the global baseline into `packages/*/.effect-diagnostics-baseline.json`, new typed checker `tooling/src/effect-diagnostics-check.ts`; unchanged packages skip the language-service run |
| #799 | tf-ll90.19.1: restored `@effect/{workflow,ai}` to tiny-firegrid (runtime-resolution deps, knip-ignored) + `task-enter.sh` auto-install + `preflight.ts` missing-deps guard |
| #803 | **split `trace:seams:ukv` into its own parallel CI job** (was last/sequential in Lint; Lint 92s→52s) |
| #804 | `docs/static-analysis-catalog.md` — full rule inventory (the consolidation reference) |

## CI performance state (measured)

Jobs now: `lint`, `trace-seams`, `semgrep`, `typecheck`, `effect-diagnostics`, `tests`. Latest run (caches warming on main):
- Lint ~52s · effect-diagnostics **15s** (warm turbo) · typecheck/tests ~50s · semgrep ~55s · **UKV trace seams ~65–70s ← current long pole**.
- The trace gate is an **uncacheable live sim** (spawns subprocesses, mtime-based run selection — same reason `tiny-firegrid#test` is `cache:false`). Further speedup there is sim-side (Agent3 / tiny-firegrid owners) or larger runners (cost), **not** a tooling-cache lever.

**Tooling/CI-mechanics levers are essentially exhausted** — the bottleneck is now genuine compute (one sim), not redundant work or cold caches.

### Levers deliberately NOT taken (with reasons — don't redo these)
- **Biome** to replace ESLint — rejected: can't host our 10 custom `local/` rules (incl. the anti-forge `simulation-host-real-firegrid-host`), `@effect/eslint-plugin`, or type-aware rules. Would gut enforcement.
- **typescript-eslint `projectService`** — surfaced parse errors on `vitest.config.ts`, no clear speedup; reverted.
- **Turbo-cache the trace gate** — non-deterministic sim; caching could mask failures.
- **Drop `dependsOn: ^build`** — load-bearing for cross-package turbo cache invalidation (a package's cache must bust when an upstream package's *source* changes, even though build emits nothing). The "no output files found" warning is cosmetic.
- **Semgrep `pipx` cache / larger runners** — save runner *cost*, not wall-clock (those jobs aren't the bottleneck).

## Open thread: static-analysis consolidation (the live initiative)

Product owner asked to consolidate overlapping static tooling onto 1–2 engines. **Cataloging is done** (#804 → `docs/static-analysis-catalog.md`). Decision teed up, **not yet executed**.

**Proposed target:** keystone **ESLint** (only type-aware engine; already hosts custom + anti-forge rules) + **jscpd** (cross-file dup, which ESLint can't do). Retire **ast-grep** then **Semgrep** by migrating rules into ESLint `local/` rules. Keep the genuinely-distinct **dependency-cruiser** (import graph), **knip** (reachability), **effect-language-service** (Effect diagnostics) — these are not overlap.

**Staged plan (each its own PR; every migration must be byte-equivalent with fixtures ported — all are enforcement gates):**
- **Phase 0** — delete the confirmed ESLint↔Semgrep duplicate rules (process.env, timers/Date.now, extends-Error, Effect.run*).
- **Phase 1 (recommended next)** — **retire ast-grep**: it's 7/8 dead (only `hrtime-number-arithmetic` is gated via `--filter`). Relocate `hrtime` to an ESLint `local/` rule (or semgrep), delete the 7 ungated inventory rules + the ast-grep dep/config/gate. Lowest-risk real consolidation.
- **Phase 2** — migrate Semgrep's ~35 mechanically-portable rules to ESLint `local/`; audit the 15–18 that use semgrep-only features (`patterns`/`pattern-inside`/taint) — keep a thin Semgrep residue only if some genuinely can't port; then retire Semgrep + its CI job/`pipx`.
- **Phase 3** — fold the AST-shaped bespoke scripts (`effect-quality-metrics`, `host-sdk-runtime-import-baseline`, the cutover-check) into `local/` rules where it makes sense.

**Hard constraint (Coordinator directive):** NEVER weaken the anti-forge / enforcement gates — the tiny-firegrid sim locks (ESLint `simulation-host-real-firegrid-host` + `no-restricted-syntax` forge guards), dep-cruiser airgaps (R2/R3) + host-sdk→runtime boundary, and the effect-quality/semgrep/knip ratchets. Strengthen or hold; baselines shrink, never grow without justification. Clear any change to these with the Coordinator.

## Gotchas learned this session

- **Stacked PRs on a moving trunk need rebase + reconcile, not blind merge.** When I came to merge, trunk had advanced: the diagnostics baseline drifted 82→80 entries (re-split per-package from the *current* baseline), the `lint` script had changed, and ci.yml had a new step. Always re-verify (full `pnpm preflight`) after a rebase before pushing.
- **`pnpm preflight`** runs all gates in parallel (weighted semaphore) and is the fast local gate; it auto-guards missing `node_modules` now. CI gates are the source of truth — report green only after the full CI set.
- The effect-diagnostics gate is **byte-equivalent verified** against the old global gate (both reported `6 warnings, 66 messages` pre-merge) and still bites on regressions (tested).

## Quick links
- Catalog: `docs/static-analysis-catalog.md`
- Preflight runner: `tooling/src/preflight.ts` · diagnostics checker: `tooling/src/effect-diagnostics-check.ts`
- CI: `.github/workflows/ci.yml` · setup: `.github/actions/setup/action.yml`
- Lint config: `eslint.config.js` (26 blocks) · `.semgrep.yml` · `tooling/ast-grep/` · `.dependency-cruiser.cjs`
