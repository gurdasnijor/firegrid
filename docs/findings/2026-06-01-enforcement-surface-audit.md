# Enforcement-surface audit — what gates the TARGET (unified) arch vs a SUPERSEDED one

- **Bead:** `tf-ll90.16` (Lane 4, enforcement-surface audit) — READ-ONLY finding.
- **Date:** 2026-06-01
- **Trunk audited:** `sim/unified-kernel-validation` HEAD (the #765 integration branch). All gate output below was **run locally on this checkout**; all STALE verdicts are grounded in the rule/script source **read this session** + the target-arch authority docs.
- **Authority docs (precedence, coordinator-approved):** (1) `docs/analysis/2026-06-01-765-deletion-audit.md` (the R1–R14/C1–C8 ledger — PRIMARY for STALE), (2) `docs/architecture/2026-05-31-unified-architecture-mental-model.md` (3 primitives), (3) `docs/sdds/SDD_FIREGRID_GATEWAY_SEPARATION_OF_CONCERNS.md` (§4 split), (4) `docs/cannon/architecture/kernel-owned-write-arm.md`, (5) `docs/architecture/unified-subscriber-kernel.md` *with* handoff §9 caveat, (6) handoff `docs/handoffs/2026-06-01-stabilize-unified-handoff.md`.
- **Meta-rule applied to this audit:** no STALE verdict without (a) reading the rule/script source **and** (b) git/fs-verifying the guarded dir/constraint is deleted/superseded. Where I could not fully verify, it is labelled.

## 0. The one fact the whole audit turns on (verified `ls packages/runtime/src/`)

| Dir | State post-#765 |
|---|---|
| `kernel/`, `workflow-engine/`, `subscribers/`, `composition/`, `authorities/`, `streams/`, `control-plane/`, `agent-event-pipeline/` | **DELETED** |
| `unified/` (the actual kernel) | **PRESENT** — but **no enforcement rule references it** |
| `events/`, `capabilities/`, `channels/`, `tables/`, `transforms/`, `sources/`, `producers/`, `engine/`, `verified-webhook-ingest/`, `_archive/` | **PRESENT as pre-unified RESIDUE** — the dirs `tf-ll90.8` §4 folds/deletes |

**Consequence that recurs throughout:** the bulk of the structural enforcement (dep-cruiser tier family, the `runtime-public-surface-check`, the semgrep authority cluster, the legacy-tree rules) was written for the **2026-05-22 Shape-C physical target tree** (`docs/architecture/2026-05-22-runtime-physical-target-tree.md` / `…-shape-c-cutover-roadmap.md`). The unified collapse **superseded that tree**. So those rules are either (a) **vacuously green** (their targets are deleted, nothing matches), (b) **actively wrong** (they *require* deleted dirs to exist), or (c) **blind to `unified/`** (they police residue the kernel no longer lives in). None of them gate the unified kernel.

---

## PART 1 — ★ SATISFY-vs-RETIRE for Lane 1's 4 red CI gates (the headline)

CI (`.github/workflows/ci.yml`) has 5 jobs: **Lint, Semgrep, Typecheck, Effect-diagnostics, Tests**. Typecheck is green. The **Lint job is a megagate** that aggregates 5 independently-failing sub-checks, so it is broken out. Verdicts grounded in the exit codes + outputs captured this session (`/tmp/lane4/*.out`).

| Gate / sub-check | Local result | Cause (evidence) | Verdict for Lane 1 |
|---|---|---|---|
| **Effect-diagnostics** | RED | "3 errors, 11 warnings, 9 messages above baseline" — **all in LIVE code**: `unified/{channel-bindings,codec-adapter,subscribers/*}`, substrate (`effect-durable-streams` Writer/Http/Producer/sse), `runtime/test/`. Zero in deleted dirs. 3 errors = `unified/subscribers/runtime-context.ts:110` (missingReturnYieldStar), `runtime/test/misuse-resistance-footguns.test.ts:77,81` (floatingEffect). | **SATISFY** (real Effect-idiom debt, mechanical). |
| **Lint ▸ eslint** | RED (7 err/22 warn) | `unified/host.ts:235` no-unsafe-assignment (real). Remaining errors in tiny-fg **sim files** (`production-flow-*.ts` comma-dangle×3 + process.env×2; `fake-acp-agent-process.ts`). | **SATISFY** `unified/host.ts` now; **DEFER** sim-file errors → `.11/.15` (those sims get rebuilt). |
| **Lint ▸ runtime-public-surface-check** | RED | `scripts/runtime-public-surface-check.mjs:41-52` **requires `subscribers/` + `composition/` to exist** (citing the pre-unified target-tree doc); #765 deleted both. Also flags `unified/` as undocumented. | **★ RETIRE / REALIGN — DO NOT SATISFY.** Recreating those dirs reintroduces the tree the collapse deleted. The one pure recreate-trap. Realign with `tf-ll90.8`. |
| **Lint ▸ knip (lint:dead)** | RED (current=21) | Unused files `events/agent-output.ts` + `tables/runtime-control-plane-time.ts` (residue → `.8`); bulk unused exports in `tiny-firegrid/.../unified-kernel-validation/*` (sims → `.11/.15`); unused deps `@effect/cli`, `@firegrid/observability` in `runtime/package.json` (live). | **MIXED:** SATISFY the 2 unused deps only; **DEFER** residue files → `.8`, sim exports → `.11/.15`. Don't grind to zero now. |
| **Lint ▸ jscpd (lint:dup)** | RED (82 dup lines, 11 clones, threshold 0) | All 11 clones in **live code**: `unified/{scheduled-webhook-peer,permission-and-tool,signal,codec-adapter,channel-bindings}` + `verified-webhook-ingest/adapter`. | **SATISFY** (refactor or accept-with-rebaseline). `channel-bindings` clones relocate with `.2`. |
| **Lint ▸ effect-quality** | RED (4 metrics) | `effectOrDieSiteCount` 4>2 (all `unified/` — observers/runtime-context/codec-adapter), `forOfInPackageSourceCount` 8>0 (live `unified/codec-adapter,signal` + sims), `throwOutsideBinScriptCount` 6>4, `processEnvOutsideBinCount` 2>0 (the 2 sim files). | **MIXED:** ratchet is ALIGNED; SATISFY live `unified/` sites; DEFER sim sites → `.11/.15`. |
| **Semgrep** | RED | 22 **unbaselined** ERROR findings drive the failure (verified `semgrep-check-baseline.mjs:64,80` only exits 1 on `failures`, i.e. unbaselined; the ~23 "baseline improvement" lines are advisory). Split below. | **MIXED** — see split. |
| ↳ semgrep hygiene rules | — | `firegrid-no-date-now`, `firegrid-no-inline-stream-url-construction`, `firegrid-no-process-env-outside-bin` on live `unified/` + sim. | **SATISFY** (ALIGNED determinism/hygiene). |
| ↳ `firegrid-no-unclassified-workflow-make` | — | 4 hits `unified/subscribers/*` + 1 sim. Rule = `pattern: Workflow.make(...)`, executable guard for **CANNON C2** (`runtime-design-constraints.md`). Handoff §5 assigns "workflow-classification semgrep" to `tf-ll90.8`. | **DEFER → `.8`** (NOT Lane 1). Rule ALIGNED; don't blind-baseline. |
| ↳ 3 table-authority rules | — | `…owned-table-writes-use-authorities`, `…no-table-type-parameters-outside-authorities`, `…no-table-service-yield-outside-providers` fire on `unified/{channel-bindings,codec-adapter}`. Rules key on the **deleted `authorities/` dir** + pre-unified capability tags. Handoff §5: `tf-ll90.2` relocation "clears the table-discipline semgrep." | **DEFER → `.2` + REALIGN rule.** Do NOT recreate `authorities/`. |
| ↳ semgrep baseline cruft | — | All 14 runtime entries in `semgrep-error-baseline.json` point at **deleted** `composition/*` + `subscribers/*` (verified). | **RETIRE** (prune from baseline). |
| **Tests** | not re-run* | *Not re-run this session (turbo heavy). Per handoff §4: `protocol/test/channels/session-permission.test.ts:21` offset ParseError = real schema-collapse fix; PR #772 already shows Tests ✅. | **SATISFY** (real; effectively done on #772). |

### Lane 1 net guidance
- **SATISFY now (live unified invariants, Lane 1's):** effect-diagnostics; `unified/host.ts:235` eslint; semgrep `no-date-now`/`no-inline-stream-url`; jscpd live dup; knip 2 unused deps; offset test (on #772).
- **RETIRE / do-not-grind:** `runtime-public-surface-check` (demands deleted dirs — realign with `.8`); semgrep baseline cruft (prune).
- **DEFER (real, but owned by another bead — don't double-work):** `no-unclassified-workflow-make` → `.8`; table-authority semgrep + `channel-bindings` dup/effect-diag → `.2`; ALL sim-file lint/quality/dead findings → `.11/.15`; residue dead files → `.8`.
- **Of the 4 red gates, exactly ONE sub-check is a pure stale-recreate-trap:** `runtime-public-surface-check`. Everything else is real-and-Lane-1's or real-but-another-bead's.

---

## PART 2 — Full enforcement classification

Legend: **ALIGNED** (real unified invariant → keep) · **STALE** (enforces a pre-unified/Shape-C/legacy-tree constraint #765 superseded → retire) · **REALIGN** (useful, needs updating to unified). "Vacuous" = currently green only because its target was deleted.

### 2A. CI gate-reach map (what actually gates the trunk)

| CI job | Runs | 
|---|---|
| **Lint** | `check:specs`, `check:docs`, `lint` (eslint + `effect-native-production-cutover-check` + `runtime-public-surface-check` + `legacy-runtime-roots-scoreboard` + `runtime-target-legacy-type-only-check` + `test-layout-check` + `tiny-firegrid-layout-check` + `effect:diagnostics`), `lint:dead`, `lint:dup`, `lint:deps`, `lint:effect-quality`, `lint:ast-grep` |
| **Semgrep** | `lint:semgrep:test`, `lint:semgrep` |
| **Typecheck** | per-package typecheck |
| **Effect diagnostics** | `effect:diagnostics` (also inside `lint`) |
| **Tests** | per-package test |
| **NOT in CI** (verify/hook/manual only) | `clean-room-hard-root-guard`, `lint:host-sdk-imports`, `trace:seams`, `toy:coverage:check`, `preflight` |

### 2B. `scripts/` — wired enforcement (the ~20)

| Script | Wired? | Invariant | Verdict | Evidence |
|---|---|---|---|---|
| `runtime-public-surface-check.mjs` | Lint | Requires the 10 Shape-C "semantic target surfaces" (incl. **`subscribers/`,`composition/`**) to exist + be documented | **STALE/REALIGN** (actively wrong; RED) | `:41-52` `requiredTargetSurfaces`; cites `2026-05-22-runtime-physical-target-tree.md`. Demands deleted dirs; ignorant of `unified/`. → `tf-ll90.8`. |
| `legacy-runtime-roots-scoreboard.mjs` | Lint | PARK-allowlist ratchet over `runtime/src/{kernel,workflow-engine}` | **STALE (vacuous-green)** | Both roots **absent**; prints "Wave E exit gate reached", parkAllowlist empty → exits 0. Its job is done; cites Shape-C roadmap. RETIRE. |
| `runtime-target-legacy-type-only-check.mjs` | Lint | Forbids `import type` from target-tier dirs into legacy roots | **STALE (vacuous-green)** | `:40-61` target/legacy lists are pre-unified; "0 edges across 9 target-tier folders". RETIRE/realign with `.8`. |
| `effect-native-production-cutover-check.mjs` | Lint | Forbids old durable-streams API tokens (`appendJson`, `RuntimeCaptureJournal`, `RuntimeIngressLive`…) | **ALIGNED** (anti-regression; green) | `:26-36`. Tokens name deleted pre-unified constructs; guard prevents their return. Cheap, keep. |
| `test-layout-check.mjs` | Lint | No colocated tests under `src/` | **ALIGNED** (generic; green) | Arch-agnostic layout hygiene. Keep. |
| `tiny-firegrid-layout-check.mjs` | Lint | `tiny-firegrid/src` top-level ⊆ {simulations,runner,experiment*,bin,index,types} | **ALIGNED** (sim methodology; green) | The coarse half of the sim shape-lock; `tf-ll90.15` adds the per-sim `{index,driver,host}` file-shape lock. Keep + `.15` extends. |
| `effect-quality-metrics-check.mjs` | Lint | AST ratchet (orDie/forOf/throw/processEnv/…) | **ALIGNED** (ratchet; RED) | `:48` regression-on-increase. Regressions are live `unified/` + sims (see Part 1). Keep; satisfy live, defer sims. |
| `tooling.mjs check specs`/`check docs` | Lint | Feature-YAML + doc hygiene | **ALIGNED** (generic; green) | `:78,97`. Arch-agnostic. Keep. |
| `tooling.mjs effect diagnostics` | Lint + own CI job | Effect-LSP diagnostics baseline floor | **ALIGNED** (RED) | `:163-212`. Live-code debt. Keep; satisfy. |
| ast-grep (`lint:ast-grep`) | Lint | Only `hrtime-number-arithmetic` (filtered) | **ALIGNED** (generic; green) | `tooling/ast-grep/`; `workflow-make-inventory.yml` is informational (blocking gate is semgrep). Keep. |
| `git-hooks/{pre-commit,pre-push}` | hooks | Primary checkout must stay on `main` | **ALIGNED** (operational; arch-agnostic) | Worktree discipline guardrail. Keep. |
| `clean-room-hard-root-guard.mjs` | **UNWIRED** | `runtime/src` top-level allowlist + `_archive`/host-sdk import locks | **STALE (dormant)** | Self-documents "NOT wired into the default lint chain"; allowlist still lists deleted `subscribers/`+`composition/`; cites Shape-C docs. If ever wired it would mis-gate. RETIRE or realign before any use. |
| `host-sdk-runtime-import-baseline.mjs` | verify/preflight (**not CI**) | host-sdk → runtime import quarantine | **ALIGNED-but-dormant** | `@firegrid/host-sdk` is `export {}` (#733) → vacuous. Relevant again after `tf-ll90.12` host-sdk-fate decision. |
| `trace-seam-coverage.ts` (`trace:seams`) | **UNWIRED** (manual tsx) | Asserts every documented seam fired in a sim's OTLP trace | **ALIGNED** (sim-evidence instrument) | Header: "prove the production-flow scenario exercises every path the unified architecture introduces." This is the trace-as-evidence tool, not a CI gate. Sim-methodology territory (`.11/.15`). |
| `tiny-config-prod-coverage.sh` (`toy:coverage:check`) | **UNWIRED** (manual) | Production-surface vs sim-config coverage | **REALIGN/deprioritize** | Aux analysis; references pre-unified config names. Note-but-deprioritize. |
| `preflight.mjs` | **UNWIRED** (local runner) | Runs the full verify gate set, non-stop | **ALIGNED** (operational) | Mirrors `verify`. Keep. |

**Orphan coordination/cron tooling** (`cmux-dispatch`, `cmux-broadcast`, `lane-sweep`, `dispatch-gap`, `signoff-queue`, `task-{enter,exit,reap}`, `beads-sync{,-cron}`, `install-*`, `state-watch{,-cron}`, `runtime-corpus.sh`, `runtime-flow-map.py`, `acp-trace-health.py`, `oss`/`publish-oss.sh`, `phase1-workflow-core-paths-gate.sh`): operational, not arch gates → **note-but-deprioritize** (per brief). `runtime-shape-baseline.json` is consumed only by the orphan `runtime-corpus.sh`.

### 2C. `.dependency-cruiser.cjs` (`lint:deps` — currently GREEN/vacuous)

| Rule family | Rules | Verdict | Evidence |
|---|---|---|---|
| **Tier-DAG family** | `runtime-{events,capabilities,tables,transforms,sources,producers,channels}-no-higher-tier-import`, `runtime-subscribers-no-{composition,producers,sources}-import`, `runtime-shape-c-runtime-context-no-producers-import` | **STALE** | Encodes the Shape-C tier DAG (`:99-100` comment). `from` dirs are residue (`.8` deletes); `subscribers/`/`composition/` `from` rules have **no files to scan**. **None reference `unified/`** — blind to the kernel. RETIRE/realign with `.8`. |
| **Legacy-tree family** | `runtime-{tables,producers,sources,channels,subscribers,composition}-no-legacy-tree-import` | **STALE (100% vacuous)** | `:274-367` all forbid `to:[workflow-engine/, agent-event-pipeline/, authorities/]` — **all deleted**. Carve-outs (`pathNot`) name deleted files (`workflow-engine/workflows/wait-for.ts`, `authorities/index.ts`). Nothing can match. RETIRE with `.8`. |
| **tiny-fg sim airgap (R2/R3)** | `tiny-firegrid-sim-airgap-whole-sim` (`:669`), `tiny-firegrid-test-no-internals` (`:705`) | **ALIGNED as of `tf-ll90.15`** (do not reopen) | Right intent. The leaky state captured in my trunk-at-audit-time run had holes: R2 grandfathered `unified-kernel-validation/*` entirely (`:678`), carved out `host.ts` (`:676`) enabling the driver→`./host.ts` value-import cheat, and `to` omitted `@effect/workflow` + `@durable-streams/server`; R3 omitted those + `effect-durable-operators` and grandfathered `unified-firegrid-host-compose.test.ts`. **Coordinator-reported (not re-verified against Lane 3's branch this session): `tf-ll90.15` has since dropped the 3 grandfathers and added `@effect/workflow` + `@durable-streams/*` to the `to` lists.** `.15` owns; do not reopen. |
| **Package-boundary family** | `client-sdk-no-runtime`, `runtime-no-client-sdk-or-cli`, `runtime-no-host-sdk`, `protocol-no-client-or-runtime`, `cli-no-runtime`, `no-package-imports-cli`, `client-sdk-no-host-sdk-or-cli`, `*-scan` variants | **ALIGNED** | Enforce the public package seams the unified arch keeps. Keep. (host-sdk ones dormant while host-sdk is `export {}`.) |
| **Substrate boundary** | `durable-streams-imports-contained`, `effect-durable-operators-state-only`, `client-sdk-no-broad-durable-streams-root`, `client-sdk-production-no-node-tier-durable-streams-subpaths`, `no-source-registration-to-durable-tools` | **ALIGNED** | The durable-streams substrate seam — core to unified. Keep. |
| **Generic hygiene** | `no-circular`, `runtime-src-no-folder-cycles`, `not-to-unresolvable`, `no-non-package-json`, `not-to-deprecated`, `no-duplicate-dep-types`, `not-to-test-from-production` | **ALIGNED** | Arch-agnostic. Keep. |
| **Host-internal** | `runtime-no-host-internal-imports-outside-host` (`:371`), `runtime-errors-internal-only` | **REALIGN/vacuous** | Key on `runtime/src/host/` — not present in the current tree. Verify against `.8`'s final shape. |

> The tiny-fg R2/R3 airgap rules are flagged **ALIGNED-needs-strengthening** and handed to `tf-ll90.15` — **not duplicated here** (coordinator boundary).

### 2D. Baselines

| Baseline | Floor | Verdict | Evidence |
|---|---|---|---|
| `.effect-diagnostics-baseline.json` | 82 entries | **MOSTLY LEGIT + 2 stale** | 11 `runtime/src` refs; only **2** point at deleted `subscribers/runtime-control/workflows.ts`. The floor is mostly real substrate/live debt. Prune the 2; the green-up FIXES live regressions above the floor (Part 1). |
| `semgrep-error-baseline.json` | — | **SUBSTANTIALLY STALE** | **All 14** `runtime/src` entries point at deleted `composition/{agent-tool-host-live,host-public}` + `subscribers/*/workflow.ts` (verified). The "baseline improvement (remove from baseline)" advisories in the gate output are these. **Prune.** |
| `.knip-baseline.json` | net 21 | **REALIGN** | No deleted-dir refs; the 21 current findings are residue/sim/deps (Part 1). Re-derive after `.8/.11/.15`. |
| `runtime-shape-baseline.json` (+ `.keyless`) | — | **ORPHAN** | Consumed only by `runtime-corpus.sh` (not a gate). Deprioritize. |
| `host-sdk-runtime-import-baseline.json` | — | **DORMANT** | Empty of runtime refs; host-sdk is `export {}`. Revisit with `.12`. |
| `effect-quality-metrics-baseline.json` | per-metric | **ALIGNED** | The 4 RED metrics are live `unified/` + sim regressions, not stale entries. |
| jscpd (threshold 0, no baseline file) | 0 | **ALIGNED** | Zero-tolerance; current 82 dup lines are live code. |

### 2E. `eslint.config.js` + `.semgrep.yml`

**eslint.config.js**
- **ALIGNED (durable-correctness / generic):** `local/no-fixed-polling`, `local/no-production-js-timers`, `local/no-module-durable-cache`, `local/no-process-env-outside-bin`, `local/no-extends-error`, `local/no-manual-tagged-error`-style, `local/relative-ts-extensions`, `local/no-node-process-import`, `no-restricted-imports` package-seam blocks (client-sdk/cli/runtime/substrate/apps). Keep.
- **ALIGNED as of `tf-ll90.15` (do not reopen):** the per-file **sim airgap** — `simulations/*/driver.ts` (`:708`, client-sdk-only), `simulations/*/host.ts` (`:740`, no client-sdk), and R4 `tiny-firegrid/src/**` no-standalone-script / no-`process.exit` (`:759-796`). This is the eslint half of the same airgap as dep-cruiser R2/R3. My trunk-at-audit-time run showed the `driver.ts` `no-restricted-imports` patterns left the value-import cheat open. **Coordinator-reported: `tf-ll90.15` has since added the `driver.ts` all-relative-import ban + `host.ts` cast-ban locks** that close it. `.15` owns; do not reopen.
- **REALIGN/dormant:** `local/no-host-authority-registry` (`:980`, warn) and `local/no-hidden-control-plane` (`:704`) name the pre-unified authority/control-plane model — verify relevance against the unified table/signal model (couples to `.2`).

**.semgrep.yml** (53 rules)
- **STALE authority cluster (~13 rules, `firegrid-runtime-agent-event-pipeline.AUTHORITIES.*/ENFORCEMENT.*`):** `…no-singleton-authority-specifiers`, `…no-exported-authority-singletons`, `…no-exported-authority-registry-api`, `…no-custom-authority-wrapper-types`, `…no-authority-static-helper-calls`, `…no-authority-registry-surface`, `…no-old-singleton-authority-tag-keys`, `…runtime-context-workflow-requires-local-authority`, `…no-second-durable-capability-provider`, + the **3 table-authority rules** (Part 1). All key on the **deleted `authorities/` tiering**. Mostly vacuous; the 3 table ones fire on `unified/`. → **STALE/REALIGN**, coupled to `.2`/`.8`. The invariant "table writes have one owner / no leaked table services" *may* survive under the DurableTable primitive + §4 read-side-no-drift, but the rule text + the `authorities/**` exclusions are pre-unified.
- **STALE Shape-C / tier rules:** `firegrid-shape-c-runtime-context-no-workflow-machinery`, `firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber`, `firegrid-transforms-purity-import-boundary`, `firegrid-runtime-subscribers-transforms-no-table-facades`, `firegrid-no-numbered-runtime-subpath` (tied to the numbered Shape-C tree). → RETIRE/realign with `.8`.
- **ALIGNED (CANNON / determinism / generic Effect hygiene):** `firegrid-no-unclassified-workflow-make` (C2), `firegrid-no-random-durable-identity`, `firegrid-no-new-date-iso-in-library`/`firegrid-no-date-now` (durable determinism), `firegrid-no-process-env-outside-bin`, `firegrid-no-inline-stream-url-construction`, `firegrid-prefer-match-tag-over-switch`, `firegrid-no-promise-chain-in-effect-code`, `firegrid-no-mutable-identity-let`, `firegrid-no-inline-tagged-error-fail`, and most `firegrid-remediation-hardening.*`. Keep.

---

## PART 3 — Coupling handoffs to the other lanes

- **→ `tf-ll90.1` (Lane 1 green-up):** Part 1 table is the satisfy-vs-retire spec. Headline: only `runtime-public-surface-check` is a pure recreate-trap; do not recreate `subscribers/`/`composition/`.
- **→ `tf-ll90.2` (read-side relocation):** owns clearing the 3 table-authority semgrep rules (relocate `unified/` read-side → `channels/`), the `channel-bindings` `layerMergeAllWithDependencies` effect-diag cluster, and the `channel-bindings` jscpd clones. Also the rule-text REALIGN (drop `authorities/` refs).
- **→ `tf-ll90.8` (§4 split + residue reconciliation):** owns clearing the `no-unclassified-workflow-make` hits, and **retiring the dep-cruiser tier-DAG + legacy-tree families, `runtime-public-surface-check`, `legacy-runtime-roots-scoreboard`, `runtime-target-legacy-type-only-check`, the semgrep Shape-C/tier rules, and `clean-room-hard-root-guard`'s allowlist** — each stale rule retires with the dir it polices. **A stale dir's tier-rule retires with it.**
- **→ `tf-ll90.15` (sim-enforcement) — LANDED (coordinator-reported):** has strengthened dep-cruiser R2/R3 (dropped the 3 grandfathers, added `@effect/workflow` + `@durable-streams/*` to `to`) + the eslint sim airgap (driver all-relative-import ban + host cast-ban). Those rows above are marked ALIGNED-as-of-`.15` — do not reopen. `tiny-firegrid-layout-check` + `trace-seam-coverage` are its allies; the per-sim `{index,driver,host}` shape-lock remains `.15`'s. **Not duplicated here.**
- **→ `tf-ll90.12` (host-sdk fate):** unblocks `host-sdk-runtime-import-baseline` + the dep-cruiser host-sdk rules from dormancy.

## PART 4 — Recommendation summary

1. **RETIRE (stale, coupled to `.8` dir deletion):** dep-cruiser tier-DAG + legacy-tree families; `runtime-public-surface-check`; `legacy-runtime-roots-scoreboard`; `runtime-target-legacy-type-only-check`; `clean-room-hard-root-guard` (or realign + keep unwired); semgrep authority cluster + Shape-C/tier rules; semgrep-error-baseline runtime entries; the 2 stale effect-diag baseline entries.
2. **REALIGN to unified:** the table-discipline invariant (→ `.2`, retarget off `authorities/`); `runtime-public-surface-check` required-surface list (→ `.8`, document `unified/` + the §4 tiers); the dep-cruiser R2/R3 + eslint sim airgap (→ `.15`); knip baseline (re-derive post-`.8/.11/.15`).
3. **KEEP (ALIGNED):** effect-diagnostics, effect-quality ratchet, jscpd, eslint durable-correctness + package-seam rules, dep-cruiser package/substrate/generic rules, `effect-native-production-cutover-check`, `test-layout-check`, `tiny-firegrid-layout-check`, ast-grep, doc/spec checks, git-hooks, the CANNON/determinism semgrep rules.
4. **The trap to avoid (for every lane):** "make CI green" must not mean "satisfy a Shape-C requirement." The unified collapse retired that tree; satisfying its enforcement re-grows the residue `tf-ll90.8` exists to delete. **Falsify the requirement against §0 before satisfying it.**
