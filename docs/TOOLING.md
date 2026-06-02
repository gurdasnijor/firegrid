# Tooling

This repo standardizes TypeScript hygiene on ESLint plus the Effect language
service, gated locally by `pnpm preflight` and in CI by the workflow at
`.github/workflows/ci.yml`.

## The review gate: `pnpm preflight`

```sh
pnpm preflight
```

This is **the** canonical local ready-for-review gate (`tooling/src/preflight.ts`).
It runs every gate in parallel over a weighted semaphore (heavy gates start
first), keeps going after failures, and replays each failing gate's output in one
pass. Gates:

`test` · `typecheck` · `effect:diagnostics` · `lint` · `lint:dead` · `lint:dup` ·
`lint:deps` · `lint:effect-quality` · `trace:seams:ukv` · `check:specs` · `check:docs`

`task-exit.sh` runs `pnpm preflight` and refuses to push on failure.

> `pnpm verify` is a thin **alias** of `pnpm preflight` (kept for muscle memory /
> existing references). `pnpm check` is a *different*, build-inclusive chain
> (`check:specs + check:docs + lint + effect:diagnostics + turbo run build check`)
> — use it when you specifically want the build in the loop.

**CI is authoritative for the full suite.** CI runs the same gates split across
parallel jobs (below), so a clean `pnpm preflight` should mean a green CI.

## ESLint

```sh
pnpm run lint     # eslint + runtime-public-surface + tiny-firegrid layout checks
pnpm run format   # eslint --fix
```

One ESLint stack covers formatting, type-aware linting, Effect guardrails, and
package-boundary checks. Beyond `lint`'s ESLint pass, the `lint` script also runs
two filesystem-shape checks (`scripts/runtime-public-surface-check.mjs`,
`scripts/tiny-firegrid-layout-check.mjs`).

Local durable-authority guardrails (custom `local/*` rules) catch shapes that
commonly bypass durable state — e.g. `local/no-production-js-timers`,
`local/no-hidden-control-plane`, `local/no-module-durable-cache`,
`local/no-fixed-polling`, `local/no-host-authority-registry`. Reviewed
exceptions use a nearby escape comment with a reason:

```ts
// durable-lint-allow-polling: subscription deadline fallback with bounded scope
```

## Static-quality ratchets

```sh
pnpm run lint:dead          # knip: zero unused exports/files/deps/binaries
pnpm run lint:dup           # jscpd: duplicated-line count vs .jscpd.json threshold
pnpm run lint:deps          # dependency-cruiser boundary/cycle/direction checks
pnpm run lint:effect-quality # ts-morph per-pattern Effect-quality count ratchet
```

Each has a `:baseline` companion (`lint:dead:baseline`, etc.) that recomputes the
tracked count after intentional reduction. The baseline scripts refuse to ratchet
upward automatically; raising a threshold requires an explicit config edit and
review. See `docs/contributing/quality-gates.md` and
`docs/contributing/effect-quality-metrics.md`.

## Build

```sh
pnpm run build
```

Each package emits production JavaScript into its local `dist` from `src`,
excluding tests. Source uses relative `.ts` import specifiers; TypeScript's
`rewriteRelativeImportExtensions` rewrites them to `.js` in `dist`, so source
stays TypeScript-native while emitted ESM runs under Node. ESLint enforces and
autofixes this convention.

## Effect diagnostics & devtools

```sh
pnpm run effect:diagnostics            # turbo run diagnostics (gated)
pnpm run effect:diagnostics:baseline   # recompute the diagnostics baseline
pnpm run effect:patch / effect:unpatch # opt-in: patch local TS for build-time diagnostics
```

`@effect/language-service` is installed at the workspace root and enabled in each
package tsconfig; editors must use the workspace TypeScript version for the plugin
to load. For VS Code / Cursor, set `"typescript.tsdk": "node_modules/typescript/lib"`.

## Architecture dependency graphs

Graphs are **review evidence, not a gate**, and are **not committed**. Render them
locally with dependency-cruiser:

```sh
pnpm run arch:deps          # workspace + collapsed package graphs (Mermaid)
pnpm run arch:deps:detail   # uncollapsed module-level graphs
pnpm run arch:graphs        # both of the above
pnpm run arch:deps:client | :protocol | :runtime   # focused single-package graphs
```

Output (`docs/dependency-graph*.mmd`) is **git-ignored** — it is a renumber-churny
generated artifact that conflicted across parallel lanes with no review value as a
committed file. Instead, architectural change is surfaced automatically as an
**advisory PR comment**: the `Arch graph advisory` workflow
(`.github/workflows/arch-graph-comment.yml`) runs `depcruise --affected <base.sha>`
(changed modules since the PR base + everything that can reach them, highlighted)
and posts a Mermaid diagram. It is **advisory only — never a merge gate**.

For the *strict* dependency-boundary gate, use `pnpm run lint:deps` (and CI).

## CI workflow shape

`.github/workflows/ci.yml` runs five gating jobs in parallel — **Lint**,
**Typecheck**, **Effect diagnostics**, **Tests**, and **UKV trace seams**.
Dependency-cruiser boundary checks run inside the `Lint` job. The separate
`arch-graph-comment.yml` workflow posts the advisory dependency-graph comment and
is **non-gating**.

Each job's setup (checkout + pnpm + node + install) lives in the shared composite
action `.github/actions/setup`. CI wall-clock approaches the slowest single job;
the pnpm content-addressed store cache is shared across jobs in a run.

## CLI / runtime entrypoints

The runtime ships a unified `@effect/cli` binary with subcommands:

```sh
pnpm run firegrid -- run|acp|host|start [...]   # bin/firegrid.ts (unified)
```

The `firegrid:run` / `firegrid:acp` / `firegrid:host` / `firegrid:start` scripts
are thin shortcuts to the same per-subcommand bins. `firegrid:host:env` adds
`--env-file-if-exists=.env`.

## Static-analysis consolidation (Semgrep + ast-grep retired)

ESLint is the keystone source-pattern engine. Semgrep was retired (consolidation):
footprint guards with no live findings became ESLint `local/sg-*` rules in
`eslint.config.js` (a shared source-text scanner applying Semgrep's exact regexes,
scoped per block via `files`/`ignores`, run under `pnpm run lint`); rules with live
findings moved to the `effect-quality` ts-morph count ratchet
(`pnpm run lint:effect-quality`). ast-grep was likewise retired — its one gated
rule now lives as `local/hrtime-number-arithmetic`. To add a source-pattern guard:
prefer a type-aware ESLint rule; for a pure text shape add a `local/sg-*` block; or
— if it would have live findings — add a counter to
`scripts/effect-artifacts/quality-metrics.mjs` and re-baseline. See
`docs/static-analysis-catalog.md`.

## Effect-quality metric ratchet

`pnpm run lint:effect-quality` runs `scripts/effect-quality-metrics-check.mjs`,
which counts per-pattern findings across `packages/*/src` with ts-morph
(AST-precise, so comments/strings don't false-positive) and compares to
`effect-quality-metrics-baseline.json`. CI fails on any increase; decreases
recompute via `pnpm run lint:effect-quality:baseline` (never auto-raises).

Strict-zero rules layered alongside: `local/no-extends-error`,
`local/no-process-env-outside-bin`. Tracked ratchet metrics include
`throwOutsideBinScriptCount`, `forOfInPackageSourceCount`, `anyNoContextCastCount`,
`nodeCryptoImportCount`, `dataTaggedErrorDeclarationCount`, `newDurableStreamSiteCount`,
`perCallLayerProvideSiteCount`, `effectOrDieSiteCount`, and the test-migration
counters. New tagged-error classes are normal feature work — land the class and
re-run the baseline in the same PR.

### Policy exceptions (deliberate, documented)

- `Data.TaggedError` is the firegrid policy; `Schema.TaggedError` is reserved for
  wire-envelope error decoding. The ratchet caps the count.
- `Effect.runPromise`/`runPromiseExit` permitted in `__tests__/` (during the
  `@effect/vitest` migration) and in bin/app entrypoints. The ratchet caps it.
- `Effect.orDie`/`Layer.orDie`/`Effect.die` permitted only at deliberate
  runtime-fork / bin / test-harness boundaries. The ratchet caps it.

This tooling exists because manual review windows are too narrow to be the only
guardrail for architecture boundaries, durable-state helper shapes, and
Effect-quality regressions.

---

For the contributor-facing quality-gate reference see
`docs/contributing/quality-gates.md`; for a current works/stale map of every tool
surface see `docs/analysis/2026-06-02-tool-surface-audit.md`.
