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

This is the canonical ready-for-review gate for agent work. cmux review-request payloads must include `pnpm verify: PASS` before asking for approval.

Run duplicate-token detection:

```sh
pnpm run lint:dup
```

This runs jscpd over `packages/*/src` and compares the duplicated-line count against the tracked threshold in `.jscpd.json`. CI fails when a change introduces duplicated lines above that baseline.

Recompute the duplication baseline:

```sh
pnpm run lint:dup:baseline
```

This is intended for remediation slices such as R4 after helper extractions reduce duplication. The script refuses to raise the threshold automatically; lowering the count is a ratchet, while accepting a higher count requires an explicit config edit.

Run dead-code detection:

```sh
pnpm run lint:dead
```

This runs knip and compares the current unused-export, unused-file, unused-dependency, and unlisted-binary finding count against `.knip-baseline.json`. Recompute the baseline after intentional cleanup with:

```sh
pnpm run lint:dead:baseline
```

The baseline script refuses to ratchet upward automatically. New knip findings should be fixed when they are real, or justified in the PR description when they are intentional tool or fixture shapes.

Run transitive dependency boundary checks:

```sh
pnpm run lint:deps
```

This runs dependency-cruiser with `.dependency-cruiser.cjs`. Unlike direct import lint rules, dependency-cruiser can flag transitive boundary violations, cycles, and orphan modules across the substrate, runtime, client, and lab packages.

Run structural duplication-shape checks:

```sh
pnpm run lint:semgrep
```

Semgrep is installed outside npm because the npm packages are not maintained. Locally, install the CLI with:

```sh
pipx install semgrep
```

The CI workflow uses the same `pipx install semgrep` path before running the root `.semgrep.yml` rules. The current rules flag repeated shapes for durable-stream append wrappers, scoped substrate-database acquisition, retained-row reads, and authoritative-run lookups.

The Effect ESLint plugin currently ships only two rules in `@effect/eslint-plugin@0.3.2`: `dprint` and `no-import-from-barrel-package`. `dprint` conflicts with this repo's existing stylistic formatter stack, so only `@effect/no-import-from-barrel-package` is enabled. If the plugin adds or changes rules during an upgrade, audit the shipped rule list before enabling anything new.

To add a semgrep rule, add a focused rule to `.semgrep.yml`, include path filters or exclusions if the rule needs narrower scope, and add a matching fixture in `semgrep-tests/` with `ruleid` and `ok` comments. Verify it with:

```sh
semgrep --test --config .semgrep.yml semgrep-tests/dup-detection.ts
```

To add a dependency-cruiser rule, add it to `.dependency-cruiser.cjs`, keep the severity at `warn` while triaging existing debt, and promote to `error` once the rule is clean enough to gate CI.

To add a knip rule or exception, prefer making the code reachable or dropping unused exports first. Use `knip.json` ignores only for intentional tool fixtures, external binaries, or dependencies invoked through scripts that knip cannot statically infer.

This tooling exists because the original manual review missed near-duplicates in `packages/substrate/src/retained-records.ts` and similar repeated static-quality issues. Manual review windows are too narrow to serve as the only guardrail.
