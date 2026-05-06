# Tooling

This repo standardizes TypeScript hygiene on ESLint plus the Effect language service.

## ESLint

Run:

```sh
pnpm run lint
```

Autofix formatting and safe lint fixes:

```sh
pnpm run format
```

The ESLint config intentionally keeps one stack for formatting, type-aware linting, Effect guardrails, and package-boundary checks. Current Effect defect-boundary debt such as `Effect.orDie` and `Layer.orDie` is reported as warnings so the lint setup can land before the behavioral refactor.

The repo also carries local durable-authority guardrails. These do not prove distributed correctness; they catch shapes that commonly bypass durable state:

- `local/no-production-js-timers` errors on production `setInterval`, `setTimeout`, and `setImmediate`.
- `local/no-hidden-control-plane` errors on HTTP/control-plane imports in host/client production paths.
- `local/no-module-durable-cache` warns on module-scope mutable durable-state caches or registries.
- `local/no-fixed-polling` warns on fixed schedules, stream ticks, and `Effect.sleep` inside loops.
- `local/no-host-authority-registry` warns on host-owned run/completion/claim/event-plane registry names.

Reviewed production exceptions should use a nearby escape comment with a reason, for example:

```ts
// durable-lint-allow-polling: subscription deadline fallback with bounded scope
```

## Build

Run:

```sh
pnpm run build
```

Each package emits production JavaScript into its local `dist` directory from `src`, excluding tests. Declaration emit is intentionally off for the first build baseline because the current substrate schemas need explicit exported type annotations before portable declaration generation can pass.

Source files use relative `.ts` import/export specifiers. TypeScript's `rewriteRelativeImportExtensions` rewrites those to `.js` in `dist`, so source stays TypeScript-native while emitted ESM remains runnable by Node. ESLint enforces and autofixes this convention.

## Effect Devtools

The repo installs `@effect/language-service` at the workspace root and enables it in each package tsconfig. Editors must use the workspace TypeScript version for the plugin to load.

For VS Code and Cursor, this repo recommends the Effect Dev Tools extension and configures:

```json
{
  "typescript.tsdk": "node_modules/typescript/lib"
}
```

Build-time Effect diagnostics are available after patching the local TypeScript install:

```sh
pnpm run effect:patch
```

This is intentionally opt-in for now: the current codebase has existing Effect diagnostics that should be fixed in a dedicated refactor before the patch becomes part of the default install/check path. Use `pnpm run effect:unpatch` to restore the normal TypeScript compiler.

The runtime tracer dependency `@effect/experimental` is not installed yet. Add it when there is a concrete app/runtime entrypoint that should connect to the editor DevTools tracer.

## Static-quality tooling

Run the complete review gate:

```sh
pnpm verify
```

This is the canonical ready-for-review gate for agent work. CI is the authoritative full-suite runner; cmux review-request payloads should report CI status and any targeted local checks used to debug concrete failures. Local agents should use targeted
checks to debug concrete failures unless the coordinator explicitly asks for a
full local `pnpm verify`.

### CI workflow shape

The repo's CI workflow at `.github/workflows/ci.yml` runs five gating jobs in
parallel — `Lint`, `Semgrep`, `Typecheck`, `Effect diagnostics`, `Tests` —
plus one non-gating evidence job, `Architecture reports`, which uploads
regenerated dependency graphs and the Effect artifact inventory as workflow
artifacts on every pull request.

Each job's setup boilerplate (checkout + pnpm setup + node setup + install)
lives in the shared composite action at `.github/actions/setup`. Bumping the
pnpm or Node version touches one file rather than every job.

CI wall-clock equals the slowest single job (typically `Tests` or `Typecheck`)
rather than the serial sum. The pnpm content-addressed store cache, keyed on
`pnpm-lock.yaml` via `actions/setup-node@v6 with cache: pnpm`, is shared
across jobs in the same workflow run, so the second-and-later jobs install
from a warm cache.

Run duplicate-token detection:

```sh
pnpm run lint:dup
```

This runs jscpd over `packages/*/src` and `apps/*/src` and compares the duplicated-line count against the tracked threshold in `.jscpd.json`. The threshold is currently zero, so CI fails on any production-source token clone.

Recompute the duplication baseline:

```sh
pnpm run lint:dup:baseline
```

This is intended for remediation slices after helper extractions reduce duplication. The script refuses to raise the threshold automatically; accepting any nonzero count requires an explicit config edit and coordinator review.

Run dead-code detection:

```sh
pnpm run lint:dead
```

This runs knip and requires the current unused-export, unused-file, unused-dependency, and unlisted-binary finding count to remain zero. Recompute the tracked report after intentional cleanup with:

```sh
pnpm run lint:dead:baseline
```

The check script refuses any nonzero baseline or current finding count. New knip findings should be fixed when they are real, or explicitly reviewed as intentional tool or fixture shapes before adding an ignore.

Run transitive dependency boundary checks:

```sh
pnpm run lint:deps
```

This runs dependency-cruiser with `.dependency-cruiser.cjs`. Unlike direct import lint rules, dependency-cruiser can flag transitive boundary violations, cycles, and orphan modules across the substrate, runtime, client packages and the lab app. It also gates general dependency hygiene for unresolvable imports, undeclared npm dependencies, deprecated package usage, production imports from test files, and duplicate dependency declarations.

## Architecture Reporting

Architecture reports are review evidence, not the ready-for-review gate. They
answer "what does the package and Effect surface look like right now?" before a
package-structure or boundary cleanup. They do not prove runtime behavior,
durable transition correctness, or Semgrep/ESLint policy compliance. Use
`pnpm verify` and GitHub CI for those gates.

Spec anchors:

- `firegrid-remediation-hardening.STATIC_QUALITY.3`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.1`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.3`
- `firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.5`
- `firegrid-architecture-boundary.DEPENDENCY_GRAPH.6`

Regenerate the full report set:

```sh
pnpm run arch:reports
```

This lightweight alias runs `pnpm run arch:effect-artifacts` followed by
`pnpm run graph`. Use it before reviewing package-boundary changes,
durable-core reshaping, public export movement, or SDD updates that cite
current architecture evidence. Commit regenerated report files only when the
slice intentionally changes architecture evidence; otherwise use the command as
a local inspection tool.

CI uploads the same evidence as a workflow artifact on every pull request via
the non-gating `architecture-reports` job in `.github/workflows/ci.yml`.
Reviewers can download the artifact bundle (`architecture-reports`) from the
GitHub Actions run page and inspect the regenerated inventory and graph files
without rerunning the commands locally. The job is `continue-on-error: true`
so an evidence-regen failure on a structurally sound PR does not block merges;
gating remains with the five strict jobs (`Lint`, `Semgrep`, `Typecheck`,
`Effect diagnostics`, `Tests`).

Generate Effect artifact architecture evidence:

```sh
pnpm run arch:effect-artifacts
```

This uses ts-morph to inventory exported declarations under `packages/*/src` and `apps/*/src`, classify Effect-facing artifacts, and emit:

- `docs/effect-artifact-inventory.json` — structured data for independent SDD checks
- `docs/effect-artifact-inventory.md` — human-readable summary for architecture review

The inventory covers exported service tags, Layers, Schemas, tagged errors, Effect-returning exports, service interfaces paired with tags, plain types, constants, and pure helpers. It records package workspace, physical source area, inferred architecture layer, re-export binding, declaration-file imports, and richer type evidence such as generic type parameters, call parameters, return or declared type text, class/interface heritage and members, and variable binding shape. For `Effect.Effect<A, E, R>` and `Layer.Layer<ROut, E, RIn>` exports it uses ts-morph type APIs where possible to record channel text, flattened requirement entries, and resolved requirement declarations. The markdown report includes export-pressure tables and durable-core same-package import layer crossings to guide package-structure work.

The JSON output is the authoritative machine-readable inventory for
`firegrid-architecture-boundary.EFFECT_ARTIFACT_GRAPH.5`. The markdown output is
rendered from the same data for humans. Use the JSON when writing independent
checks or rule reports; use the markdown when reviewing export pressure,
workspace re-exports, Effect requirement-channel crossings, and durable-core
layer crossings.

The current report is on-demand rather than part of `pnpm verify` because it is
an architecture evidence artifact and can churn with harmless export movement.
It does not decide whether a boundary is acceptable; it shows the exports,
requirements, and crossings reviewers need to compare against the package SDD.

Effect artifact rule reports:

- Current `main` emits inventory evidence only through
  `pnpm run arch:effect-artifacts`.
- Static enforcement and baseline/rule ratchets are owned by the Q5 static
  quality work. When those rule-report commands are present on `main`, list them
  here with their generated output paths and whether they are CI gates.

Regenerate dependency-graph evidence:

```sh
pnpm run graph
```

This uses dependency-cruiser to refresh the overview SVGs, the collapsed
workspace Mermaid graph, and focused package-internal Mermaid graphs. Graph
generation excludes tests and build outputs so the diagrams show production
architecture rather than test reachability.

Outputs:

- `docs/dependency-graph.svg` — broad production workspace graph.
- `docs/dependency-graph-modules.svg` — module-collapsed production graph.
- `docs/dependency-graph-archi.svg` — dependency-cruiser architecture view.
- `docs/dependency-graph.mmd` — collapsed Mermaid graph for quick text review.
- `docs/dependency-graph-client.mmd` — client package internals.
- `docs/dependency-graph-runtime.mmd` — runtime package internals.
- `docs/dependency-graph-substrate.mmd` — substrate package internals.

Focused graph targets:

```sh
pnpm run graph:client:mermaid
pnpm run graph:runtime:mermaid
pnpm run graph:substrate:mermaid
```

These write `docs/dependency-graph-client.mmd`,
`docs/dependency-graph-runtime.mmd`, and
`docs/dependency-graph-substrate.mmd`. Use them when reviewing package-shape
work; `pnpm run lint:deps` remains the strict CI dependency-boundary check.
The graph commands show import reachability and direction, including the
`firegrid-architecture-boundary.DEPENDENCY_GRAPH.6` app-vs-package boundary. They
do not distinguish public workspace package entrypoints from direct internal
subpath imports; use dependency-cruiser rules, package exports, and source
guards for that stricter interpretation.

Command map:

| Task | Command | Writes | Gate? |
| --- | --- | --- | --- |
| Ready-for-review static/test gate | `pnpm verify` | none | Yes, CI authoritative |
| Strict dependency boundary check | `pnpm run lint:deps` | none | Yes |
| Full architecture evidence refresh | `pnpm run arch:reports` | effect artifact reports and dependency graphs | No |
| Effect artifact inventory only | `pnpm run arch:effect-artifacts` | `docs/effect-artifact-inventory.{json,md}` | No |
| All dependency graphs | `pnpm run graph` | `docs/dependency-graph*` | No |
| Focused package Mermaid graph | `pnpm run graph:<package>:mermaid` | one focused `.mmd` file | No |
| Raw dependency-cruiser scan | `pnpm run graph:check` | none | No; prefer `lint:deps` for CI policy |

Run structural duplication-shape checks:

```sh
pnpm run lint:semgrep
```

Semgrep is installed outside npm because the npm packages are not maintained. Locally, install the CLI with:

```sh
pipx install semgrep
```

The CI workflow uses the same `pipx install semgrep` path before running the root `.semgrep.yml` rules. The current rules flag repeated shapes for durable-stream append wrappers, scoped substrate-database acquisition, retained-row reads, and authoritative-run lookups. Rule paths include `packages/*/src` and `apps/*/src`; shared generated-file, fixture, test, and build-output exclusions live in `.semgrepignore`.

Test the Semgrep ruleset fixtures:

```sh
pnpm run lint:semgrep:test
```

`pnpm verify` and CI run this fixture test before the production Semgrep scan so rule refinements cannot silently stop matching. Each rule should carry `metadata` with the review/source ACID, category, and canonical helper path. Production Semgrep runs with `--error`; new rules need fixtures and clean path scopes before entering the blocking scan.

The Effect ESLint plugin currently ships only two rules in `@effect/eslint-plugin@0.3.2`: `dprint` and `no-import-from-barrel-package`. `dprint` conflicts with this repo's existing stylistic formatter stack, so only `@effect/no-import-from-barrel-package` is enabled. If the plugin adds or changes rules during an upgrade, audit the shipped rule list before enabling anything new.

To add a semgrep rule, add a focused rule to `.semgrep.yml`, prefer repo-root `.semgrepignore` for shared excludes, use per-rule path exclusions only for canonical helper homes, and add a matching fixture in `semgrep-tests/` with `ruleid` and `ok` comments. Verify it with:

```sh
pnpm run lint:semgrep:test
```

To add a dependency-cruiser rule, add it to `.dependency-cruiser.cjs` and keep CI strict once the rule lands. Temporary warning-only triage requires an explicit remediation note and a follow-up to promote the rule.

To add a knip rule or exception, prefer making the code reachable or dropping unused exports first. Use `knip.json` ignores only for intentional tool fixtures, external binaries, or dependencies invoked through scripts that knip cannot statically infer.

Run the Effect-quality metric ratchet:

```sh
pnpm run lint:effect-quality
```

This runs `scripts/effect-quality-metrics-check.mjs`, which counts per-pattern Effect-quality findings across `packages/*/src` and `apps/*/src` using the same ts-morph project the artifact inventory walks (one project crawl per CI invocation, AST-precise so comments and string literals don't trigger false positives), and compares the result to `effect-quality-metrics-baseline.json`. CI fails on any metric increase. Decreases recompute via:

```sh
pnpm run lint:effect-quality:baseline
```

The baseline script refuses to ratchet upward automatically. A regression must either be fixed or — for genuinely intentional shapes — handled by relocating the code into an explicitly allowlisted path (currently `packages/*/bin/`, `scripts/`, `__tests__/`, and `*.test.ts` files where applicable).

Strict-zero gates layered alongside the metric ratchet:

- `local/no-extends-error` ESLint rule errors on `class … extends Error` declarations in package source. Current count is 0 after R7's `Data.TaggedError` migration.
- `local/no-process-env-outside-bin` ESLint rule errors on `process.env[…]` reads outside `bin/` and `scripts/`. Current count is 0.
- `firegrid-no-process-env-outside-bin` Semgrep rule complements the ESLint guard with a structural pattern.

Tracked metrics in the ratchet baseline:

- `extendsErrorCount` — `class … extends Error` declarations in package source. Strict-zero target; redundantly enforced by the ESLint rule above.
- `processEnvOutsideBinCount` — `process.env[…]` reads outside `bin/` and `scripts/`. Strict-zero target; redundantly enforced by the ESLint and Semgrep rules above.
- `throwOutsideBinScriptCount` — `throw` statements in package source outside `bin/` and `scripts/`. Ratcheted; reduce via per-site refactor to typed Effect failures.
- `forOfInPackageSourceCount` — `for…of` and `for await` loops in package source. Ratcheted; convert to `Array.forEach` / `Effect.forEach` / `Stream` per the code-style review.
- `anyNoContextCastCount` — `as Schema.Schema.AnyNoContext` casts. Ratcheted; centralize behind a single helper at the descriptor or schema boundary (Q3 owns).
- `nodeCryptoImportCount` — `import … from "node:crypto"` in package source. Ratcheted; replace with an injectable IdGen service (Q4 owns).
- `dataTaggedErrorDeclarationCount` — `class … extends Data.TaggedError(...)` declarations. Ratcheted at the current count to lock in shape (no `extends Error` regressions sneaking in alongside legitimate tagged-error additions). New tagged-error classes are part of normal feature work; the documented happy path for adding one is to land the class and then re-run `pnpm run lint:effect-quality:baseline` in the same PR with an ACID reference for the new error in the commit message. The ratchet is a structural ceiling that never auto-raises, not a feature freeze on tagged errors.
- `newDurableStreamSiteCount` — `new DurableStream(...)` constructor sites in package source. Ratcheted; migrate to a future `acquireDurableStream` helper.
- `perCallLayerProvideSiteCount` — `Effect.provide(*Live(cfg))` invocations inside per-call helpers (`withSubstrate`, etc.). Ratcheted; hoist live layer construction (Q4 owns).
- `effectOrDieSiteCount` — `Effect.orDie`, `Layer.orDie`, `Effect.die`, `Effect.dieMessage`. Ratcheted; documented as a policy exception.
- `effectRunPromiseInTestsCount` — `Effect.runPromise`, `runSync`, `runFork`, `runPromiseExit` calls in `__tests__/`. Ratcheted; migrate via `@effect/vitest`.
- `vitestItImportInTestsCount` — `import { it/describe/expect } from "vitest"` in `__tests__/`. Ratcheted; migrate via `@effect/vitest`.

The metric ratchet is intentionally conservative. A future Effect-detector ratchet (see "Effect-detector ratchet — deferred" below) would cover broader pattern families once the external detector is CI-stable.

## Effect-artifact rule layer

Run the inventory-driven rule layer:

```sh
pnpm run lint:effect-rules
```

`scripts/effect-artifacts-rules-check.mjs` regenerates the artifact inventory via `analyzeProject` and runs the rule set in `scripts/effect-artifacts/rules.mjs` against the committed baseline at `effect-artifact-rules-baseline.json`. CI fails on any rule violation or budget regression. Recompute via:

```sh
pnpm run lint:effect-rules:baseline
```

Rules implemented in this layer:

- **Workspace-pair forbidden edges** — re-exports or imports across forbidden workspace pairs (`runtime → client`, `client → runtime`, `lab → substrate`, `lab → runtime`, `runtime → lab`, `substrate → client/runtime/lab`, `client → lab`). Strict-zero target; current count is 0. Every artifact whose `exportLocation.workspace ≠ declarationLocation.workspace` is checked against the forbidden pair list.
- **Unknown-role exports budget** — count of `summary.byRole.unknown` artifacts. Ratcheted; reduce by extending `scripts/effect-artifacts/types.mjs` classification or by removing unused exports.
- **Cross-workspace re-export budget** — count of artifacts whose export workspace differs from their declaration workspace. Ratcheted; covers public-surface re-exports across packages and apps.
- **Boundary-crossing budget** — count of `summary.boundaryCrossings`. Ratcheted; the existing inventory tracks architecture-layer crossings.
- **Forbidden-layer-crossing budget** — count of `summary.forbiddenLayerCrossings`. Strict-zero target.
- **Effect-returning exports per workspace budget** — `effect-returning` role count per workspace. Ratcheted; prevents unintended growth of the Effect-returning surface area without a corresponding spec amendment.

Rules deferred (require ts-morph evidence not currently emitted by the inventory; tracked in `docs/PROPOSAL_STATIC_ENFORCEMENT_2026-05-05.md`):

- Service-tag namespace hygiene (tag string casing convention, namespace separator presence)
- Explicit-return-type visibility for exported Effect-returning functions
- Public-surface allowlist driven by the inventory itself (existing `client-foundations.test.ts` and `public-surface.test.ts` allowlist tests remain authoritative for now)

## Effect-detector ratchet — deferred

The `claude-skill-effect-ts` detector reports ~4,023 findings across the repo (see `docs/REVIEW_EFFECT_FULL_AUDIT_2026-05-05.md`). The detector currently runs through the local `claude-skill-effect-ts` plugin cache and uses `bun`; it is not yet CI-stable. The metric ratchet above covers the highest-confidence patterns from that detector's output. When the detector becomes CI-installable, replace or augment the metric ratchet with a per-rule baseline against `firegrid-detect.json` and document the upgrade boundary here.

## Policy exceptions

These deviations are deliberate and documented:

- `Data.TaggedError` is the firegrid policy. `Schema.TaggedError` is reserved for the moment a future descriptor needs error-decoding from a wire envelope. See `docs/REVIEW_EFFECT_ERROR_MANAGEMENT_2026-05-05.md` §1. The metric ratchet caps the count at the current baseline.
- `Effect.runPromise` is permitted in `__tests__/` while the `@effect/vitest` migration is in flight. The metric ratchet caps the count.
- `Effect.orDie` / `Layer.orDie` / `Effect.die` is permitted at the RunWait facade documented in `packages/substrate/src/coordination/run-wait/service.ts` and at runtime fork-point logging boundaries. The metric ratchet caps the count; future tightening with a `local/orDie-needs-justification` rule is tracked in the static-enforcement proposal.
- `Effect.runFork` / `Effect.runPromise` / `Effect.runPromiseExit` in `apps/lab/src/lab/LabEventStreamPanel.tsx` is the documented React boundary; the file carries explicit `eslint-disable-next-line no-restricted-syntax` suppressions.

This tooling exists because the original manual review missed near-duplicates in `packages/substrate/src/retained-records.ts` and similar repeated static-quality issues. Manual review windows are too narrow to serve as the only guardrail.
