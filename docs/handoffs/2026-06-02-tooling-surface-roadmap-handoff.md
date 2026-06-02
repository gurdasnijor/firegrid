# Tooling surface-area & effect-native roadmap — handoff (2026-06-02)

Audience: the next agent picking up the tooling/quality-surface thread. Goal of
the program: **shrink tooling surface area, kill baselining, improve type safety
+ ergonomics, and make the tooling effect-native** — instead of a sprawl of
one-off `.mjs` wrappers and drift-prone baseline JSON.

## Status

**Landed: PR #854 (`tf-dbxp`) → `main` @ `da36e12e2`.** Tooling-hygiene pass:

- **knip + jscpd → native strict-0.** `lint:dead = knip --treat-config-hints-as-errors`,
  `lint:dup = jscpd packages/*/src` (`.jscpd.json` threshold 0). Deleted the `.mjs`
  count-wrappers + `.knip-baseline.json` + orphan `runtime-shape-baseline*.json`.
- **trace-seam coverage co-located** → `packages/tiny-firegrid/src/runner/seam-coverage.ts`
  (effect-native, reuses `runner/trace.ts`) + `bin/` entries. Both `scripts/` copies gone.
- **Retired** (one-off-by-one-off, evaluated as wrappers / settled-migration scaffolding):
  `public-surface-check`, `layout-check`, `tooling.mjs` (`arch:deps` depcruise wrapper,
  `check:docs`, `check:specs`), `tiny-config-prod-coverage.sh` (677L, ungated),
  `acp-trace-health.py` + fixtures (ungated instrument).
- **Spec/docs:** deprecated `firegrid-quality-gates` ACIDs PREFLIGHT.3 + DOCS.3
  (Acai `deprecated` convention); de-staled TOOLING.md / quality-gates.md / AGENTS.md /
  acai-walkthrough.md; updated ci.yml + arch-graph-comment.yml.

**Net:** `scripts/` is now **only operational shell** (`task-{enter,exit,reap}`,
`lane-sweep`, `dispatch-gap`, `cmux-*`, `install-git-hooks` + `git-hooks/`,
`publish-oss` + `oss/`) **+ the effect-quality ratchet** (`effect-artifacts/` +
`effect-quality-metrics-*.mjs` + `effect-quality-metrics-baseline.json`). The
ratchet is the last `.ts`/`.mjs` in `scripts/`; everything else is shell.

## Two load-bearing lessons from this session (do NOT re-walk)

1. **A ratchet/metric count is not the real usage — verify before "driving to 0."**
   The effect-quality ts-morph detectors are misleadingly narrow. `effectOrDieSiteCount`
   baseline = `1`, but it only counts the direct-call `Effect.orDie(x)` form; the
   idiomatic `.pipe(Effect.orDie)` form is used **25+ times** across `runtime/src` and is
   *legitimate* (policy permits orDie at deliberate runtime-fork/boundary). `grep` before
   you plan a fix-to-zero.
2. **Retiring a gate can break a live spec ACID.** Retiring `check:specs`/`check:docs`
   broke `firegrid-quality-gates` PREFLIGHT.3 + DOCS.3. Always grep `features/**/*.feature.yaml`
   for a gate before retiring it; amend the spec via the `deprecated: true` + `<n>-note`
   convention (no renumber) — see `features/firegrid/firegrid-materialization-engines.feature.yaml`.

## Immediate next — `tf-q6vf` (effect-quality ratchet → strict-0)

Full plan is in the bead (`br show tf-q6vf`). Summary:

- **Delete** `scripts/effect-artifacts/` + `scripts/effect-quality-metrics-*.mjs` +
  `effect-quality-metrics-baseline.json` + the `lint:effect-quality` gate (root
  `package.json` + `tooling/src/preflight.ts` gate + `ci.yml` step). After deletion,
  remove the `knip.json` root `"."` workspace (its `scripts/**/*.{ts,mjs}` entry will
  have no matches → a config-hint that fails `knip --treat-config-hints-as-errors`).
- **Per-pattern triage** (NOT a uniform fix-to-zero — see lesson #1):
  - **Drop** (legit patterns; capping is noise): `dataTaggedError`(12), `workflowMake`(7)
    — re-home to its own C2 admission guard if still wanted (owners in
    `docs/workflow-make-admission-ledger.md`), `switchOnTag`(6).
  - **Drop / keep the existing advisory warn** (boundary patterns, not debt):
    `effectOrDie`, `effectRunInLibrary` (the 4 are `react.ts` / a SIGINT handler /
    Producer doc-comments). The eslint `effectDebtGuardrails` already warns on the call form.
  - **Fix the sites + author a strict-0 ESLint rule** (genuine replay/durable anti-patterns):
    `newDateIso`(10 — sites enumerated in the bead), `manualTaggedError`(9),
    `mutableStateInEffectGen`(8), `tryPromiseMultiAwait`(1), `fireAndForget`(1);
    triage `throwOutsideBin`(4) per-site.
  - **Convert already-0 patterns → ESLint** and delete from the ratchet: `extendsError` +
    `processEnvOutsideBin` (rules already exist), `forOf`, `nodeCrypto`, `newDurableStream`,
    `anyNoContextCast`, `promiseThenCatch`, `perCallLayerProvide`, `detachedPromiseInEffectSync`.
    Patterns needing AST context (`mutableStateInEffectGen`, `detachedPromiseInEffectSync`)
    are expressible as **ancestor-walking custom `local/*` rules** — the existing local
    rules already do ancestor checks (`no-fixed-polling`/`hasLoopAncestor`,
    `no-module-durable-cache`/`isTopLevelDeclaration`).
- Base off the `tf-dbxp` history (now on `main`) — `tf-dbxp` already touched
  `package.json`/`preflight.ts`/`ci.yml` gate wiring.
- **This edits runtime correctness paths.** Its own reviewable PR with fresh focus.

## Roadmap by axis

### A — Shrink surface area / kill baselining
- **`tf-q6vf`** (above) — removes the last `scripts/` `.ts`/`.mjs`.
- **effect-diagnostics baselines (9 files).** `find . -name .effect-diagnostics-baseline.json`
  → 9 per-package baselines: another baseline system (effect-language-service diagnostics
  ratchet). To honor "no baselining," drive `effect:diagnostics` to strict-0 and delete the
  baselines (runtime is at `0 errors, 3 warnings, 10 messages` — fix or suppress per-site).
  Sizeable; its own bead.
- **`tooling/analysis/`** — `s1/s2/s3-*.ts`, `type-map/`, `baseline/`, `claim-verification/`,
  and several `*.md` reports (calibration-report, comprehensive-report,
  workflow-composition-necessity, leaf-findings). **No live consumer** (grep finds no gate/
  script referencing them). Earlier-phase analysis artifacts — evaluate + retire with the
  same lens used on `scripts/`. (These `.ts` are also in the `tooling/` lint blind-spot — see B.)
- **`@ast-grep/cli`** is still installed though ast-grep was retired; referenced only in an
  `eslint.config.js` comment + historical `tooling/analysis` docs. Verify it's an orphan
  (it's not in root `package.json` — likely transitive or a stray package devDep) and remove.
- **`docs/research/tf-u6l-*/repro*.mjs`** — historical ACP turn-abort repro scripts; retire if done.

### B — Type safety
- **`local/no-launder-cast` rollout.** 8 `as unknown as` in `packages/*/src`
  (`grep -rn "as unknown as" packages --include='*.ts'`, excl tests). The rule is enabled
  ONLY in `packages/runtime/src/bin/**`. Fix the 8 (drive residual `R` to `never` / `orDie`
  infra errors at the boundary) and enable repo-wide. Known sites incl. `channel-bindings.ts`,
  `mcp-host/toolkit.ts`.
- **`local/sg-*` source-regex rules → type-aware AST rules.** ~35 `sg-*` rules are text-regex
  Semgrep ports; they scan source/comments and **false-positive on strings/comments** (this
  session hit one: a stale-path data string `".../authorities/registry.ts"` and the word
  "AuthorityRegistry" in a comment both tripped `sg-runtime-no-authority-registry-surface`,
  needing an escape comment). Upgrading the high-value ones to AST/type-aware `local/*` rules
  removes the false-positives and the escape-comment debt.
- **Extend ESLint type-aware scope to `tooling/**/*.ts`.** Today only `src/**`,
  `packages/**`, `apps/**` get the type-aware + stylistic + `local/*` rules (see
  `eslint.config.js` base block `files` + `tsconfig.eslint.json` `include`); `tooling/src/*.ts`
  and `tooling/analysis/*.ts` get only `js.recommended` — the last lint blind-spot.
  `tooling/src/preflight.ts`'s `node:` dep-guard preamble is a legit bootstrap boundary
  (it must run before `@effect/platform` is importable) — escape-hatch it, don't fight it.

### C — Ergonomics (turbo orchestration)
- **Turbo-orchestrate + cache the lint gates.** The original ask ("easy to orchestrate via
  `turbo.json`") is only half-done — the `arch` wrapper was retired, but no turbo tasks were
  added. Add `lint` / `lint:dead` / `lint:dup` / `lint:deps` as turbo **root** tasks (`//#name`)
  with **exhaustive `inputs`** so they cache safely.
  ⚠️ **Caution:** under-declared `inputs` → turbo serves a cached PASS when files changed =
  **false-green = a weakened gate.** Any gate that reads cross-package/out-of-tree files (docs,
  other packages) must NOT be cached, or must declare those files as inputs. `knip`/`jscpd`/
  `eslint`/`depcruise` have declarable repo-wide globs; favor those.
- `tooling/src/preflight.ts` is already effect-native (weighted semaphore + `Stream`) — fine.
  Optionally have it delegate the cacheable gates to `turbo run`.

### D — Effect-nativeness
- **`tf-h1ld` (filed):** product `node:http`/`node:net`/`node:stream` → `@effect/platform`.
  7 sites: `runtime/src/unified/mcp-host/mcp-host.ts` (`node:http` `createServer`),
  `runtime/src/channels/verified-webhook/source-live.ts` (`node:http`/`node:net`),
  `runtime/src/bin/acp.ts` (`node:stream`), and the tiny-firegrid sim equivalents
  (`simulations/verified-webhook-wait/host.ts`, `bin/fake-acp-agent-process.ts`). Migrate to
  `@effect/platform` `HttpServer` / `Stream`; then extend `local/no-raw-node-io` to
  `node:http`/`net`/`stream`, **drop the `bin/` exemption**, and remove the escape-hatches.
- `packages/observability/src/node.ts` OTel file exporter (`node:fs`) is the one legit fs
  boundary — keep its documented escape-hatch.
- Runner read-side (`runner/trace.ts`, `telemetry.ts`, `experiment/`) is already
  `@effect/platform`-native (this PR + prior work). Verify `perf.ts` / `show.ts` /
  `phase1-gate.ts` for consistency.

## Operating notes (discipline that held this session)
- `main` IS the trunk — base lanes off `origin/main`. When a lane modifies the same gate
  wiring as an open predecessor (e.g. `tf-q6vf` removing `lint:effect-quality` that `tf-dbxp`
  edited), base off the predecessor branch to avoid conflicts, retarget after it merges.
- `pnpm preflight` green before push (`task-exit.sh` enforces it). CI is authoritative for
  `test` + the agent-spawning `trace:seams:ukv` sim — both ran green for #854.
- Beads are the status authority (`br stats` / `bv --robot-insights`; `BEADS_DIR=$HOME/gurdasnijor/.beads`).
  Open: **`tf-q6vf`** (effect-quality strict-0), **`tf-h1ld`** (http/stream effect-native).
- Never weaken anti-forge / enforcement gates; `publish-oss.sh`'s allowlist is a firewall.
