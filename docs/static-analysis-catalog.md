# Static-Analysis Tooling Catalog

**Purpose.** A complete inventory of every static-analysis/lint rule in the repo and the *stack* (engine + file scope) it runs on. This is the working reference for consolidating the overlapping pattern-matching tooling onto fewer engines. Captured 2026-06-02 from `main`.

> **STATUS: consolidation executed.** §1–§6 below are the *pre-consolidation
> snapshot*. ast-grep and Semgrep have since been **retired**; see
> "## Consolidation outcome (executed)" at the bottom for the current state and
> where each rule now lives.

> Headline: code-pattern enforcement is spread across **four** mechanisms that do the same *kind* of job — ESLint (type-aware AST + custom JS rules), Semgrep (53 YAML patterns), ast-grep (8 patterns, 1 gated), and ~7 bespoke node scripts. The genuinely-distinct stacks (dependency-cruiser = import graph, knip = reachability, jscpd = cross-file duplication, effect-language-service = Effect diagnostics) are *not* overlap and should stay.

## Stack summary

| Stack | Rules defined | Actually gated | Scope | Mechanism | Baseline? |
|---|---|---|---|---|---|
| **ESLint** | 10 custom `local/` + ~45 typescript-eslint + 4 @stylistic + 1 @effect + ~12 `no-restricted-imports` blocks + extensive `no-restricted-syntax` | all (`--max-warnings 0`, warn=fail) | per-package via 26 `files:` blocks; **type-aware** only on `{src,packages,apps}/**/*.{ts,tsx}` | single-node + type-aware AST | none (zero-tolerance) |
| **Semgrep** | 53 | **ERROR-only**, **`packages/` tree only** | TS; per-rule `paths:` | YAML patterns (~18 use semgrep-only features; ~35 simple/regex) | `semgrep-error-baseline.json` |
| **ast-grep** | 8 | **1** (`hrtime-number-arithmetic`) | `packages/` | tree-sitter patterns | none |
| **dependency-cruiser** | ~35 forbidden | all (2 passes) | `packages/*/src` + 2nd pass adds `tiny-firegrid/test` | import dependency graph | none |
| **bespoke node scripts** | 7 gates | 6 (clean-room-guard unwired) | filesystem / `packages/**` | substring / line-regex / ts-morph AST / FS-structural | 3 ratchet, 4 zero-state |
| **jscpd** | 1 | yes | `packages/*/src` (tiny-firegrid excluded) | token clone detection | `.jscpd.json` threshold=0 |
| **knip** | 1 | yes | all workspaces | reachability graph | forced-zero |
| **effect-language-service** | per-package diagnostics | yes | 9 packages, per-package baseline | Effect LSP (type-aware) | per-package multiset |

## Consolidation-relevant findings

1. **ast-grep is 7/8 dead weight.** `lint:ast-grep` runs `sg scan ... --filter hrtime-number-arithmetic --error=hrtime-number-arithmetic packages` — only `hrtime-number-arithmetic` is gated. The other 7 rules are self-described "archaeology/inventory — findings are INFORMATION" and run in no gate. → Retiring ast-grep means relocating **one** rule and deleting 7 ungated ones.
2. **The host-sdk→runtime boundary is enforced** (this was a pre-consolidation snapshot; Semgrep retired #814 and `host-sdk-runtime-import-baseline.mjs` retired tf-636o): dependency-cruiser (`host-sdk-no-unsanctioned-runtime-subpaths-scan` + `host-sdk-public-composition-surface-only-unified`), `clean-room-hard-root-guard.mjs` (ungated), and ESLint `no-restricted-imports`.
3. **Confirmed duplicate rules across ESLint ↔ Semgrep**: `process.env` outside bin (`local/no-process-env-outside-bin` == `firegrid-no-process-env-outside-bin`), timers/`Date.now`, `extends Error`, `Effect.run*`. ESLint's variants are type-aware.
4. **`effect-quality-metrics-check.mjs` self-describes as "a redundant gate layered over ESLint/Semgrep"** — its unique value is count-ratchet semantics.
5. **Gating gaps**: Semgrep WARNING rules (≈10) never block CI and Semgrep only scans `packages/` (rules scoped to `apps/`/`/src` aren't enforced); `clean-room-hard-root-guard.mjs` is wired to no gate; ast-grep's 7 inventory rules aren't enforced.
6. **ESLint is the only type-aware engine** (single `parserOptions.project` block) → must be the consolidation keystone; semgrep/ast-grep are syntactic re-implementations of its domain.
7. **Two structural guards diverge**: `runtime-public-surface-check.mjs` and `clean-room-hard-root-guard.mjs` both enforce the `runtime/src` root-dir allowlist with *different* allowlists.

---

## 1. ESLint

Invocation: `eslint . --max-warnings 0 --cache` (every `warn` fails CI). Plugins: `typescript-eslint@8.59.2`, `@effect/eslint-plugin@0.3.2`, `@stylistic/eslint-plugin@5.10.0`, `@eslint/js@10.0.1`, `eslint@10.3.0`. Config is one flat array of **26 blocks** in `eslint.config.js` (1613 lines). Type-aware rules work only where `parserOptions.project = tsconfig.eslint.json` is set (the MAIN block: `{src,packages,apps}/**/*.{ts,tsx}`).

### 1a. Custom `local/*` rules (10, defined inline; all pure-AST, not type-aware)

| rule id | what it flags | file scope | severity |
|---|---|---|---|
| `local/no-node-process-import` | `import … from "node:process"` | MAIN | error |
| `local/relative-ts-extensions` | relative `.js` import specifiers (autofix → `.ts`) | MAIN | error |
| `local/no-production-js-timers` | `setInterval/setTimeout/setImmediate` (unless `durable-lint-allow-timer/polling` ≤2 lines) | `packages/**/src`+`apps/**/src`, minus durable-* & tests | error |
| `local/no-fixed-polling` | `Schedule.fixed/recurs/spaced`, `Stream.tick`, `Effect.sleep(literal)` in a loop | same | warn |
| `local/no-module-durable-cache` | top-level `let`; or top-level cache/registry/runs/… Map/Set/array/object | same | warn |
| `local/no-host-authority-registry` | `run/completion/claim/eventPlane` × `cache/registry` named decls | `runtime/src/**` (minus tests) | warn |
| `local/no-hidden-control-plane` | imports of `node:http(s)`/express/fastify/hono/koa/`@effect/platform/HttpServer` | `{client-sdk,runtime}/src/**` | error |
| `local/simulation-host-real-firegrid-host` | sim host.ts that never imports **or** never calls `FiregridHost` from `@firegrid/runtime/unified` (anti-forge) | `tiny-firegrid/src/simulations/*/host.ts` | error |
| `local/no-extends-error` | `class X extends Error` (push `Data.TaggedError`) | `packages/**/src`+`apps/**/src` (minus tests) | error |
| `local/no-process-env-outside-bin` | `process.env` (off under `src/bin/**`) | `packages/**/src`+`apps/**/src` (minus tests, bin) | error |

### 1b. typescript-eslint (≈45, from `recommendedTypeChecked` + explicit overrides; MAIN block, type-aware)

Type-aware highlights (irreplaceable by syntactic tools): `no-floating-promises` (error), `no-misused-promises` (error), `await-thenable`, `no-unsafe-{argument,assignment,call,member-access,return}` (error; downgraded to warn in test block), `only-throw-error`, `restrict-plus-operands`, `restrict-template-expressions` (warn, allow bool/number/nullish), `no-base-to-string` (warn), `unbound-method`, `no-unnecessary-type-assertion` (warn). Non-type-aware: `no-explicit-any`, `no-namespace`, `ban-ts-comment`, `consistent-type-imports` (warn, inline), `no-unused-vars` (warn, `^_` ignore), `no-require-imports`, etc. Explicitly **off**: `require-await`, `require-yield` (Effect generators).

### 1c. @effect / @stylistic / core

| rule | what | scope | sev |
|---|---|---|---|
| `@effect/no-import-from-barrel-package` | bans barrel imports of `@firegrid/{client-sdk,substrate,runtime}` (forces subpaths) | `packages/**/src`+`apps/**/src` | warn |
| `@stylistic/{comma-dangle,eol-last,quotes,semi}` | `always-multiline`, `always`, double, no-semi | MAIN | error |
| `no-restricted-imports` | **~12 per-package boundary configs** encoding the architecture dep graph (substrate/client-sdk/cli/runtime/host-sdk/protocol/lab import bans + tiny-firegrid driver/host/index allowlists) | numerous blocks | error |
| `no-restricted-syntax` | `riskyEffectRuntimeCalls` (`Effect.run*`, warn), `effectDebtGuardrails` (`Effect/Layer.orDie`, `Effect.die`, warn), **tiny-firegrid sim forge-guards** (error: no `Effect.run*`, `process.exit`, `as FiregridHost`, `as unknown`, `claimStatus`, `findings:[]`, recorder/fake-codec/fake-sandbox imports), substrate namespace/default import bans | MAIN + ~10 blocks | warn (debt) / **error** (sim guards) |
| core (`js.configs.recommended`) | standard correctness set; type-redundant subset disabled on TS by ts-eslint | all files | error |

### 1d. The 26 `files:` scopes ("per-package stacks")

Global ignores; `**/*.js` (node globals only); **MAIN** `{src,packages,apps}/**/*.{ts,tsx}` (type-aware, the bulk); `packages/**/src`+`apps/**/src` (timer/cache/debt rules); `{client-sdk,runtime}/src` (control-plane); per-package import-boundary blocks for substrate, client-sdk, cli, runtime (+ `runtime/src/bin` relaxed, + `runtime/src/{runtime-host,providers,runtime-ingress}`, + `runtime/src/internal/event-stream-materializer.ts`), host-sdk, protocol, lab; tiny-firegrid `simulations/*/{driver,host,index}.ts` + `src/**` + `simulations/**` + `test/**` (forge-guards, several blocks with **duplicated** selectors across G7/G9/G10/G11/G13); test override block (downgrade unsafe-* to warn); `src/bin/**` (process-env off).

---

## 2. Semgrep — `.semgrep.yml` (53 rules)

Gate (`scripts/semgrep-check-baseline.mjs`, CI Semgrep job): `semgrep --json --severity ERROR --config .semgrep.yml packages` → **only ERROR rules, only `packages/`**, ratcheted against `semgrep-error-baseline.json` (key `ruleId\0path\0line`). WARNING rules are advisory-only. `lint:semgrep:test` runs `semgrep --test` against `semgrep-tests/{dup-detection,wave-a-runtime-boundary}.ts`.

**Portability** — `semgrep-only?` = uses `patterns`/`pattern-either`/`pattern-inside`/`pattern-not-inside`/`metavariable-*`/taint/multi-line (not 1:1 portable to an ESLint rule). 18 flagged YES; 35 are single `pattern:`/`pattern-regex:` (mechanically portable).

| # | rule id | checks | sev | semgrep-only? |
|---|---|---|---|---|
|1|firegrid-no-process-env-outside-bin|`process.env` reads outside bin/scripts/tests|ERROR|YES|
|2|firegrid-no-date-now|`Date.now()`|ERROR|no|
|3|firegrid-no-new-date-iso-in-library|`new Date().toISOString()` in lib|WARN|no|
|4|firegrid-no-effect-run-in-library|`Effect.run*` in lib|WARN|YES|
|5|firegrid-no-manual-tagged-error-type|manual `readonly _tag` error type|WARN|no(regex)|
|6|firegrid-no-inline-tagged-error-fail|`Effect.fail({_tag,…})`|WARN|no|
|7|firegrid-prefer-match-tag-over-switch|`switch(x._tag)`|WARN|no(regex)|
|8|firegrid-no-promise-chain-in-effect-code|`.then().catch()` in lib (not in `Effect.sync`)|WARN|YES|
|9|firegrid-tryPromise-single-await|multiple `await` in one `Effect.tryPromise`|WARN|YES|
|10|firegrid-no-inline-stream-url-construction|inline durable-stream URL/namespace authority strings|ERROR|YES|
|11|firegrid-no-filesystem-in-runtime-package|fs/os/path/FileSystem in runtime|ERROR|YES|
|12|firegrid-no-host-id-env-authority|`FIREGRID_HOST_ID` via env/Config/import.meta|ERROR|YES|
|13|firegrid-runtime-context-workflow-requires-local-authority|direct `$ENGINE.execute(RuntimeContextWorkflow)`|ERROR|no|
|14|firegrid-no-unclassified-workflow-make|any `Workflow.make(...)` (C2)|ERROR|no|
|15|firegrid-no-replay-path-output-scan|output scans on replay path|ERROR|YES|
|16|firegrid-runtime-owned-table-writes-use-authorities|table insert/upsert/delete outside authorities|ERROR|no(regex)|
|17|firegrid-runtime-subscribers-transforms-no-table-facades|`Runtime*Table["Type"]` in subscribers/transforms|ERROR|no(regex)|
|18|firegrid-runtime-no-exported-authority-singletons|exported singleton authority|ERROR|no(regex)|
|19|firegrid-runtime-no-custom-authority-wrapper-types|`RuntimeAuthority*` wrapper types|ERROR|no(regex)|
|20|firegrid-runtime-no-authority-static-helper-calls|static authority helper calls|ERROR|no(regex)|
|21|firegrid-runtime-no-singleton-authority-specifiers|import/export old singleton authority names|ERROR|no(regex)|
|22|firegrid-runtime-no-second-durable-capability-provider|`Layer.succeed/effect(RuntimeEventAppendAndGet…)` outside owner|ERROR|no(regex)|
|23|firegrid-runtime-no-source-collection-handle-in-static-subscriber-contract|`SourceCollectionHandle` in contracts|ERROR|no(regex)|
|24|firegrid-runtime-no-table-service-yield-outside-providers|`yield* Runtime*Table` outside providers|ERROR|no(regex)|
|25|firegrid-runtime-no-authority-registry-surface|`AuthorityRegistry` as prod surface|ERROR|no(regex)|
|26|firegrid-runtime-host-no-direct-source-collection-registration|rejected source-collection registry|ERROR|YES|
|27|firegrid-runtime-no-host-internal-imports-outside-host|runtime host impl imports outside host/|ERROR|no(regex)|
|28|firegrid-runtime-no-runtime-errors-imports-outside-runtime|`runtime-errors.ts` import outside runtime|ERROR|no(regex)|
|29|firegrid-runtime-no-old-singleton-authority-tag-keys|old `Context.Tag` authority keys|ERROR|no(regex)|
|30|firegrid-runtime-no-table-type-parameters-outside-authorities|`Runtime*Table["Type"]` params outside authorities|ERROR|no(regex)|
|31|firegrid-runtime-no-exported-authority-registry-api|exported `RuntimeAuthorityRegistry*`|ERROR|no(regex)|
|32|firegrid-factory-exported-contracts-use-schema|`export interface/type` in factory (must be Schema)|ERROR|no(regex)|
|33|firegrid-no-random-durable-identity|`hostId/workerId/… = crypto.randomUUID()`|ERROR|no(regex)|
|34|firegrid-no-raw-stream-authority-string-schema|`Schema.String.pipe(streamAuthority)`|ERROR|no|
|35|firegrid-no-mutable-identity-let|`let sessionId/contextId/hostId = ""`|WARN|YES|
|36|firegrid-fire-and-forget-promise-uses-fork|`void $P.then()` not in `Effect.sync`|WARN|YES|
|37|firegrid-no-detached-promise-in-effect-sync|`void $P.then()` inside `Effect.sync`|ERROR|YES|
|38|firegrid-match-should-be-exhaustive|`Match.value().pipe(Match.tag…)` not exhaustive|WARN|no(regex)|
|39|firegrid-mutable-state-in-effect-gen|`$MAP.set/delete/clear()` in `Effect.gen`|WARN|YES|
|40|firegrid-c4-no-new-durable-deferred-runtime-wait|`DurableDeferred.X(` on RuntimeContext wait paths|ERROR|no(regex)|
|41|firegrid-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools|cursor/ChildOutput taxonomy in agent-tools|ERROR|YES|
|42|firegrid-c7-no-edge-local-terminal-synthesis|`_tag:"Done"` synthesis at edge|ERROR|no(regex)|
|43|firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber|workflow machinery in Shape-C subscriber|ERROR|YES|
|44|firegrid-host-sdk-no-runtime-kernel-import|`@firegrid/runtime/kernel` in host-sdk|ERROR|no(regex)|
|45|firegrid-host-sdk-no-runtime-archive-import|`@firegrid/runtime/_archive…`|ERROR|no(regex)|
|46|firegrid-host-sdk-no-runtime-workflow-engine-import|`@firegrid/runtime/workflow-engine`|ERROR|no(regex)|
|47|firegrid-host-sdk-no-runtime-streams-import|`@firegrid/runtime/streams`|ERROR|no(regex)|
|48|firegrid-no-numbered-runtime-subpath|`@firegrid/runtime/[1-7]-…`|ERROR|no(regex)|
|49|firegrid-host-sdk-no-effect-workflow-import|`@effect/workflow…` in host-sdk|ERROR|no(regex)|
|50|firegrid-host-sdk-no-runtime-root-barrel-import|`@firegrid/runtime` root barrel in host-sdk|ERROR|no(regex)|
|51|firegrid-transforms-purity-import-boundary|impure imports in transforms/|ERROR|YES|
|52|firegrid-shape-c-runtime-context-no-workflow-machinery|workflow machinery in runtime-context subscribers|ERROR|YES|
|53|firegrid-composition-no-legacy-imports|legacy/kernel/_archive imports in composition/|ERROR|YES|

**Counts:** 6 single-`pattern:` · 32 single-`pattern-regex:` · 15–18 semgrep-only-feature (15 strict; 18 if `pattern-either`-of-regexes counts). ~35 mechanically portable to ESLint.

---

## 3. ast-grep — `tooling/ast-grep/rules/*.yml` (8 rules; `language: typescript`, `severity: info`)

Gate (`lint:ast-grep`): `sg scan … --filter hrtime-number-arithmetic --error=hrtime-number-arithmetic packages` → **only `hrtime-number-arithmetic` is enforced.** The rest are inventory-only.

| rule | checks | gated? |
|---|---|---|
| `hrtime-number-arithmetic` | hrtime tuple math in number space (precision loss) | **YES** |
| `double-launder-cast` | `$E as unknown as $T` | no |
| `effect-context-in-layer-builder` | `Effect.context<$T>()` inside Layer builder | no |
| `manual-scope-buildwithscope` | `Layer.buildWithScope(...)` | no |
| `service-self-reference-getter` | self-referencing service getter | no |
| `tfind-anchor-comment` | `TFIND-\d+` / `firegrid-x.Y.N` anchor comments | no |
| `type-safety-eslint-disable` | `eslint-disable …no-unsafe-*` / `@ts-expect-error` / `@ts-ignore` | no |
| `workflow-make-inventory` | `Workflow.make(...)` inventory (real gate is Semgrep #14) | no |

---

## 4. dependency-cruiser — `.dependency-cruiser.cjs` (~35 forbidden, all `error`)

Invocation (`lint:deps`): `depcruise --config .dependency-cruiser.cjs packages` then a 2nd pass `--include-only '(^packages/.*/src|^packages/tiny-firegrid/test)' packages/tiny-firegrid/test`. Default `includeOnly: ^packages/.*/src`. No baseline (hard-zero).

**Graph-native:** `no-circular` (carve-out: durable-launch secret cycle), `runtime-src-no-folder-cycles`, `not-to-unresolvable`, `no-non-package-json`, `not-to-deprecated`, `no-duplicate-dep-types`, `not-to-test-from-production`.

**Runtime tier-ordering** (events < capabilities < tables < transforms < sources < producers < channels < subscribers < composition): `runtime-events-no-higher-tier-import`, `runtime-capabilities-…`, `runtime-tables-…`, `runtime-transforms-…`, `runtime-sources-no-peer-or-higher-…`, `runtime-producers-…` (carve: `channels/output-table-layer.ts`), `runtime-channels-…`.

**Package boundaries:** `client-sdk-no-runtime`, `runtime-no-client-sdk-or-cli` (carve: `runtime/src/bin`), `runtime-no-host-sdk`, `protocol-no-client-or-runtime`, `cli-no-runtime`, `no-package-imports-cli`, `client-sdk-no-host-sdk-or-cli`, `runtime-no-host-internal-imports-outside-host`, `runtime-errors-internal-only`, `no-source-registration-to-durable-tools`.

**host-sdk→runtime (the core boundary):** `host-sdk-no-unsanctioned-runtime-subpaths-scan` (allowlist of ~30 sanctioned capability subpaths), `host-sdk-public-composition-surface-only-unified` (the `#791` narrow allowance — root barrel `host-sdk/src/index.ts` may import runtime *only* via `runtime/src/unified/index.ts`), `host-sdk-no-workflow-or-durable-substrate-scan`, `runtime-no-host-sdk-scan`/`client-sdk-no-runtime-scan` (report mirrors).

**durable-streams containment:** `durable-streams-imports-contained`, `effect-durable-operators-state-only`, `client-sdk-no-broad-durable-streams-root`, `client-sdk-production-no-node-tier-durable-streams-subpaths`.

**tiny-firegrid airgap:** `tiny-firegrid-sim-no-fake-substitutes` (no fake-codec/acp-sandbox-fake/production-flow-scenario/`unified/adapter.ts`), **R2** `tiny-firegrid-sim-airgap-whole-sim` (every sim file except host.ts: no runtime/host-sdk/protocol internals/`@effect/workflow`/`@durable-streams`), **R3** `tiny-firegrid-test-no-internals` (test/ airgap; fires in 2nd pass).

> "R1" = the tiny-firegrid layout allowlist (§5, a script), not a depcruise rule. R4 = an ESLint rule.

---

## 5. Bespoke node-script gates

| gate (script) | enforces | scope | mechanism | gated in |
|---|---|---|---|---|
| `runtime-public-surface-check.mjs` | `runtime/src` root-dir shape: required semantic dirs+READMEs, no numeric-prefix dirs, only `{README,index,runtime-errors}` root files, no stale dirs/exports | `runtime/src` + `runtime/package.json` + 2 docs | filesystem + JSON, no baseline | `lint` |
| `tiny-firegrid-layout-check.mjs` | **R1** tiny-firegrid `src` top-level allowlist; each `simulations/<id>/` = exactly `{index,driver,host}.ts` | `tiny-firegrid/src` | filesystem exact-set | `lint` |
| `effect-quality-metrics-check.mjs` | ratchet on 10 ts-morph AST counts (`extendsError`, `processEnvOutsideBin` [strict-0], `throwOutsideBin`, `forOfInPackageSource`, `anyNoContextCast`, `nodeCryptoImport`, `dataTaggedErrorDeclaration`, `newDurableStreamSite`, `perCallLayerProvide`, `effectOrDie`) | `packages/**/src` (ts-morph) | **AST + baseline ratchet** | `verify` (`lint:effect-quality`) |
| `clean-room-hard-root-guard.mjs` | runtime root-dir allowlist (diverges from `runtime-public-surface`); `_archive` no prod importers; host-sdk runtime subpath/barrel rules | `runtime/src` + `packages/**/src` + `host-sdk/src` | filesystem + line-regex, zero-state | **not wired** (`lint:clean-room-hard-root` only) |
| _(retired tf-636o)_ | `effect-native-production-cutover-check.mjs`, `test-layout-check.mjs`, `host-sdk-runtime-import-baseline.mjs` removed — stale/dormant gates (forbade already-deleted tokens; generic test-placement; vacuous while `host-sdk` is `export {}`). host-sdk→runtime boundary still enforced by dependency-cruiser + ESLint `no-restricted-imports`. | — | — | — |

---

## 6. jscpd / knip / effect-language-service

- **jscpd** — `.jscpd.json` (`minTokens 40`, `minLines 5`, ts/tsx, ignores tests/`__tests__`/**tiny-firegrid**). Gate `lint:dup` (`scripts/jscpd-check-baseline.mjs`) scans `packages/*/src`, compares `statistics.total.duplicatedLines` to config `threshold` (**0**). In `verify`.
- **knip** — `knip.json` per-workspace `entry`/`project` (all 9 packages + `tooling` + root scripts; tiny-firegrid `ignoreDependencies` includes `@effect/{ai,workflow}`). Gate `lint:dead` (`knip-check-baseline.mjs`) requires `.knip-baseline.json` `issueCount == 0` (forced-zero). In `verify`.
- **effect-language-service** — `tooling/src/effect-diagnostics-check.ts`, per-package turbo `diagnostics` task; ratchets each package's `effect-language-service --format json` output against `packages/*/.effect-diagnostics-baseline.json` (identity key excludes line/column; multiset add-detection). All packages 0 errors; warnings/messages baselined (e.g. runtime 0/6/14, effect-durable-streams 0/3/34, protocol 0/0/18). In `check`.

---

## Proposed consolidation target (for decision, not yet executed)

**Keystone = ESLint** (only type-aware engine; already hosts custom + anti-forge rules). **Second code-static tool = jscpd** (cross-file duplication, which ESLint can't do). Retire **ast-grep** and **Semgrep** by migrating their rules into ESLint `local/` rules; keep the genuinely-distinct **dependency-cruiser** (graph), **knip** (reachability), **effect-language-service** (Effect diagnostics).

Staged: **Phase 0** delete the confirmed ESLint↔Semgrep duplicates · **Phase 1** retire ast-grep (relocate `hrtime`, delete 7 ungated) · **Phase 2** migrate Semgrep's 35 portable rules to ESLint (audit the 15–18 semgrep-only ones; keep a thin Semgrep residue only if some can't port) · **Phase 3** fold the AST-shaped bespoke scripts into `local/` rules. Every migration must be byte-equivalent with fixtures ported — these are all enforcement gates.

---

## Consolidation outcome (executed)

The plan above was executed. Two pattern engines were **fully retired**; ESLint
is the keystone. No enforcement gate was weakened (the empirical no-weakening
checks are recorded in the commit messages).

### ast-grep — RETIRED
- The one gated rule, `hrtime-number-arithmetic`, is now the type-aware ESLint
  rule `local/hrtime-number-arithmetic` (byte-equivalent; 0 findings, as before).
- The 7 ungated inventory rules, the `tooling/ast-grep/` pack, the `@ast-grep/cli`
  dep, the `lint:ast-grep` script, and its CI/preflight wiring were deleted.

### Semgrep — RETIRED (engine, CI job, pipx, baseline, fixtures, check script gone)
All 53 rules preserved (regexes, scopes, intent), split by whether they had live
findings:
- **45 footprint guards (0 live findings) → ESLint `local/sg-*`** — a shared
  source-text scanner (`makeSourceRegexBanRule` in `eslint.config.js`) applies
  Semgrep's *exact* regexes, scoped per the original rule's `paths` via each
  block's `files`/`ignores`; one ESLint rule id per Semgrep rule so overlapping
  scopes never collide on ESLint's per-rule config merge. Plus a new AST
  `local/no-date-now`, and `local/no-process-env-outside-bin` extended to
  `globalThis.process.env.X` (trailing access only, faithful to Semgrep).
- **8 rules WITH live findings → the `effect-quality` ts-morph count ratchet**
  (`scripts/effect-artifacts/quality-metrics.mjs`): `workflowMakeSiteCount`
  (the C2 admission gate; grandfathered owners in
  `docs/workflow-make-admission-ledger.md`), `newDateIsoCount`, `switchOnTagCount`,
  `manualTaggedErrorTypeCount`, `effectRunInLibraryCount`, `tryPromiseMultiAwaitCount`,
  `mutableStateInEffectGenCount`, `fireAndForgetVoidPromiseCount`,
  `detachedPromiseInEffectSyncCount` (strict-zero), `promiseThenCatchChainCount`.
  Grandfathers current counts, fails on increase — strictly stronger than the old
  advisory WARNINGs.

### Bespoke node-script gates — KEPT (not folded; would weaken or don't fit ESLint)
Evaluated in Phase 3; none should move to ESLint:
- `effect-quality-metrics-check.mjs` — **baseline-ratchet** semantics ESLint
  can't express (and now the home for the relocated Semgrep rules above).
- `runtime-public-surface-check.mjs`, `tiny-firegrid-layout-check.mjs` —
  **filesystem/directory-shape** checks, not code-pattern rules; out of ESLint's
  domain.

> Retired (tf-636o): `effect-native-production-cutover-check.mjs` (forbade
> already-deleted durable-streams tokens), `test-layout-check.mjs` (generic
> test-placement), and `host-sdk-runtime-import-baseline.mjs` (vacuous while
> `@firegrid/host-sdk` is `export {}`). The host-sdk→runtime boundary remains
> enforced by dependency-cruiser + ESLint `no-restricted-imports`.

### Resulting engine set
ESLint (keystone: type-aware + custom `local/` + ported `local/sg-*`) ·
`effect-quality` ts-morph ratchet · dependency-cruiser (import graph) · knip
(reachability) · jscpd (cross-file duplication) · effect-language-service (Effect
diagnostics) · the irreducible bespoke filesystem/baseline gates. The four
overlapping pattern engines (ESLint, Semgrep, ast-grep, bespoke substring) are now
**one** (ESLint) plus the baseline/structure gates ESLint structurally can't host.
