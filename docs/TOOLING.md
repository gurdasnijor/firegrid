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

This tooling exists because the original manual review missed near-duplicates in `packages/substrate/src/retained-records.ts` and similar repeated static-quality issues. Manual review windows are too narrow to serve as the only guardrail.
