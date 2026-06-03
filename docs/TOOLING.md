# Tooling

This repo standardizes TypeScript hygiene on ESLint plus the Effect language
service, gated locally by `pnpm preflight` and in CI by the workflow at
`.github/workflows/ci.yml`.

## The review gate: `pnpm preflight`

```sh
pnpm preflight
```

This is **the** canonical local ready-for-review gate. It is a single
`turbo run … --continue --output-logs=errors-only` over every gate (tf-c3wb) —
turbo owns the DAG, concurrency, keep-going, and per-gate caching; on failure it
replays only the failing gates' logs. Gates:

`test` · `typecheck` · `diagnostics` · `lint` · `lint:dead` · `lint:dup` ·
`lint:deps` · `trace:seams:ukv`

The slow gates (`test` / `typecheck` / `diagnostics`) are per-package turbo-cached,
so unchanged re-runs skip them. `lint` / `lint:dead` scan the whole repo and the
`trace` gate is a live sim, so all three are `cache: false` (never a stale
false-green); `lint:dup` / `lint:deps` cache against declared inputs.

`task-exit.sh` runs `pnpm preflight` and refuses to push on failure.

> `pnpm verify` is a thin **alias** of `pnpm preflight` (kept for muscle memory /
> existing references). `pnpm check` is a *different*, build-inclusive chain
> (`lint + effect:diagnostics + turbo run build check`) — use it when you
> specifically want the build in the loop.

**CI is authoritative for the full suite.** CI runs the same gates split across
parallel jobs (below), so a clean `pnpm preflight` should mean a green CI.

## ESLint

```sh
pnpm run lint     # eslint . --max-warnings 0 (cached)
pnpm run format   # eslint --fix
```

One ESLint stack covers formatting, type-aware linting, Effect guardrails, and
package-boundary checks — `pnpm run lint` is a single `eslint .` pass.

Local durable-authority guardrails (custom `local/*` rules) catch shapes that
commonly bypass durable state — e.g. `local/no-production-js-timers`,
`local/no-hidden-control-plane`, `local/no-module-durable-cache`,
`local/no-fixed-polling`, `local/no-host-authority-registry`. Reviewed
exceptions use a nearby escape comment with a reason:

```ts
// durable-lint-allow-polling: subscription deadline fallback with bounded scope
```

## Static-quality gates

```sh
pnpm run lint:dead          # knip --treat-config-hints-as-errors: zero unused exports/files/deps + clean config
pnpm run lint:dup           # jscpd packages/*/src: zero duplication (.jscpd.json threshold 0)
pnpm run lint:deps          # dependency-cruiser boundary/cycle/direction checks
```

`lint:dead` and `lint:dup` are the tools' **native strict-0** enforcement — no
baseline JSON to drift (the former `.mjs` count-wrappers + `.knip-baseline.json`
were removed). The `effect-quality` ts-morph count ratchet + its
`effect-quality-metrics-baseline.json` were **deleted** (tf-q6vf) — the last
baseline gate in the repo. Its enforcement moved to AST-precise `local/*` ESLint
rules; see `docs/contributing/quality-gates.md` and
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
pnpm run effect:diagnostics            # turbo run diagnostics (effect-language-service --strict)
pnpm run effect:patch / effect:unpatch # opt-in: patch local TS for build-time diagnostics
```

`@effect/language-service` is installed at the workspace root and enabled in each
package tsconfig; editors must use the workspace TypeScript version for the plugin
to load. For VS Code / Cursor, set `"typescript.tsdk": "node_modules/typescript/lib"`.

The `diagnostics` turbo task runs the language-service's **own** gate directly —
each package's `diagnostics` script is `effect-language-service diagnostics
--project tsconfig.json --strict` (tf-mnpo; the hand-rolled
`effect-diagnostics-check.ts` parser/exit wrapper + the whole `tooling/` package
were deleted). `--strict` fails on any **error or warning**; message-level hints
stay editor-advisory. There is no baseline (the per-package
`.effect-diagnostics-baseline.json` files were deleted in tf-ov4w). The few rules
that false-positive or flag legitimate raw-IO boundaries / deliberate test fixtures
carry documented inline `// @effect-diagnostics <rule>:off` directives.

### The `local/*` Effect guards are NOT redundant with the language service

The language service ships effect-native diagnostics that *look* like duplicates
of our `local/*` ESLint rules — `nodeBuiltinImport` (vs `no-raw-node-io` /
`no-node-process-import` / `no-node-crypto-import`), `processEnv` (vs
`no-process-env-outside-bin`), `globalDate` (vs `no-date-now` / `no-new-date-iso`),
`globalTimers` (vs `no-production-js-timers`), `extendsNativeError` (vs
`no-extends-error`). **They are off by default in this version and do not
enforce anything** — verified (tf-w4os) with a probe file containing every such
violation: `effect-language-service diagnostics` reported `0 errors, 0 warnings
and 0 messages`. Of the shipped rules, **31 default to `off` and 18 to
`suggestion`** (editor-advisory, never gating); only 26 are `warning`/`error`.

So the `local/*` rules are the **sole active enforcement** of those invariants,
and they carry scope precision the plugin config cannot express (product-`src`
only; `bin`/`test`/`scripts` exempt; `// durable-lint-allow-*` escape hatches).
**Do not retire them as "covered by the language service."** Consolidating onto
the LSP would require enabling each rule's severity per-tsconfig *and* losing the
scoping — net more config, not less.

### Applying the Effect codemods (refactors / quickfixes / codegens)

`overview` / `layerinfo` / `quickfixes` only *read*. The transforms apply two ways:

- **Editor refactors** (the bulk — *Layer Magic* auto-composition, async→`Effect.gen`/`Effect.fn`,
  `Effect.Service`→`Context.Tag`, *remove unnecessary `Effect.gen`*, pipe-style
  toggles, *Structural Type → Schema*). Invoke on the relevant node via the editor
  code-action menu (VS Code / Cursor: `Cmd+.`), with the editor on the **workspace**
  TypeScript (`"typescript.tsdk": "node_modules/typescript/lib"`). These are
  independent of diagnostic severity, so they work even though the matching
  diagnostics are off.
- **`quickfixes` (CLI — preview only)** — `pnpm effect:quickfixes` (or
  `--file <f>`) lists fixable diagnostics + their diffs; narrow with
  `--code <rule>` / `--fix <name>`. It *displays*; apply the diff in-editor. Most
  fixable diagnostics are off by default, so bump a rule's severity first if you
  want it to surface here.
- **`codegen` (CLI — writes files)** — directive-driven. Put `// @effect-codegens
  accessors` (or `annotate` / `typeToSchema`) above an export, then
  `npx effect-language-service codegen --project packages/<pkg>/tsconfig.json`
  fills it in (`--force` to regenerate, `--verbose` to log changes).

## Architecture dependency graphs

Graphs are **review evidence, not a gate**, and are **not committed**. Render one
locally with dependency-cruiser directly:

```sh
pnpm exec depcruise --config .dependency-cruiser.cjs packages --output-type mermaid
```

(The former `arch:deps*`/`arch:graphs` wrapper scripts + `tooling.mjs` were retired —
they only wrapped this depcruise invocation for advisory output.) Architectural
change is surfaced automatically as an **advisory PR comment**: the
`Arch graph advisory` workflow
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

The runtime ships a unified `@effect/cli` CLI (`bin/firegrid.ts`) with subcommands:

```sh
pnpm firegrid run|acp|host|start [...]    # the single Firegrid CLI entrypoint
pnpm firegrid:env <sub> [...]             # same, with --env-file-if-exists=.env
```

(tf-636o collapsed the former per-subcommand `firegrid:run`/`:acp`/`:host`/`:start`
shortcuts into the unified `firegrid <sub>`; the stale `firegrid-runtime-process`
feature spec — which predated the #830 unified CLI and called `firegrid:host` the
"single host launch command" — was corrected to match.)

## Static-analysis consolidation (Semgrep + ast-grep retired)

ESLint is the keystone source-pattern engine. Semgrep was retired (consolidation):
footprint guards with no live findings became ESLint `local/sg-*` rules in
`eslint.config.js` (a shared source-text scanner applying Semgrep's exact regexes,
scoped per block via `files`/`ignores`, run under `pnpm run lint`); rules with live
findings moved to the `effect-quality` ts-morph count ratchet
(`pnpm run lint:effect-quality`). ast-grep was likewise retired — its one gated
rule now lives as `local/hrtime-number-arithmetic`. To add a source-pattern guard:
prefer a type-aware `local/*` ESLint rule; for a pure text shape add a `local/sg-*`
block. **Do not** add a baseline-JSON count ratchet — the last one was deleted
(below). See `docs/static-analysis-catalog.md`.

## Effect-quality enforcement — strict-0 ESLint rules (was a ratchet)

The `effect-quality` ts-morph **count ratchet** and its
`effect-quality-metrics-baseline.json` were **deleted** (tf-q6vf): the last
baseline gate in the repo. Per-pattern verification showed its 20 metrics were a
mix of genuine guards, over-matching heuristics, legitimate patterns, and
already-covered cases — "fix 38 → strict-0" was a mirage. Enforcement re-homed to
AST-precise `local/*` ESLint rules (no comment/string false positives, pinned to
path+line): `no-new-date-iso`, `no-node-crypto-import`, `no-new-durable-stream`,
`no-for-of-in-source`, `no-any-no-context-cast`,
`no-detached-promise-in-effect-sync`, plus the pre-existing `no-extends-error` /
`no-process-env-outside-bin`. The C2 `Workflow.make` admission guard moved to
`local/no-unclassified-workflow-make` (per-site `// workflow-make-admission`
annotation). `Effect.orDie` / library `Effect.run*` keep their advisory warns.
Heuristic / legitimate / excluded-scope metrics were dropped — full mapping in
`docs/contributing/effect-quality-metrics.md`.

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
