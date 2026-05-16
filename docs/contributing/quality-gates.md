# Quality Gates

Firegrid quality gates are ratchets. They are meant to fail early, locally, and
with a clear remediation path. Run the whole local preflight before pushing a
code PR:

```sh
pnpm run preflight
```

`pnpm run verify` still exists for CI parity and stops at the first failure.
`preflight` runs the same practical gate set but continues after failures and
prints a summary at the end. This satisfies
`firegrid-quality-gates.PREFLIGHT.1` and
`firegrid-quality-gates.PREFLIGHT.2`.

## Gate Summary

This section satisfies `firegrid-quality-gates.DOCS.1`.

| Gate | Script | What It Forbids | Canonical Replacement | Notes |
|---|---|---|---|---|
| Specs | `check:specs` | Invalid `features/*/*.feature.yaml` syntax | Fix YAML before changing code | `acai` specs are the behavior source of truth. |
| Docs | `check:docs` | Trailing whitespace and conflict markers in docs/specs | Remove whitespace/markers | Covers `README.md`, `docs`, and `features`. |
| TypeScript | `typecheck` | Type errors across workspace packages | Fix type/service requirements | Runs through Turbo package scripts. |
| ESLint | `lint` | Style, unsafe TS, restricted imports, production cutover violations | Follow local ESLint error and use public package roots | Includes `scripts/effect-native-production-cutover-check.mjs`, `scripts/runtime-public-surface-check.mjs`, and `scripts/test-layout-check.mjs`. |
| Test layout | `lint:test-layout` | `*.test.*` / `*.spec.*` files or `__tests__/` directories anywhere under the repo-root `src/` tree or a workspace unit's production `src/` tree | Move the test to the unit's sibling `test/` directory, fix relative imports, and add `test/**` to that unit's tsconfig / vitest `include` | Zero-state gate, no baseline. Scans the repo-root `src/` (the `firegrid` binary) plus every pnpm workspace unit. Runs as part of `lint`. Documented exceptions live in `scripts/test-layout-check.mjs`. Satisfies `firegrid-quality-gates.TEST_LAYOUT.1`/`.2`. |
| Dead code | `lint:dead` | Any Knip finding | Remove the dead export/import/file or wire it through a public surface intentionally | Baseline must remain zero. |
| Duplicate code | `lint:dup` | jscpd duplicated lines above the ratchet | Extract a shared helper or keep the implementation single-source | Rebaseline only after reducing duplication. |
| Dependency boundaries | `lint:deps` | Forbidden package/app dependency edges | Move code to the owning package or depend on a public subpath | Uses `.dependency-cruiser.cjs`. |
| Effect quality | `lint:effect-quality` | Regressions in AST-counted Effect/runtime anti-patterns | Use Effect services, scoped layers, typed errors, and approved adapters | Improvements print a rebaseline hint. |
| Semgrep fixtures | `lint:semgrep:test` | Semgrep rule fixtures no longer match expectations | Fix `.semgrep.yml` or the fixture | Required when editing guardrails. |
| Semgrep baseline | `lint:semgrep` | New unbaselined ERROR findings | Use the rule's canonical replacement; remove baseline entries only after remediation | Existing ERROR findings live in `semgrep-error-baseline.json`. |
| Effect diagnostics | `effect:diagnostics` | Effect language-service diagnostics | Fix Effect-specific type/service issues | CI runs this separately from TS typecheck. |
| Tests | `test` | Runtime behavior regressions | Add/fix tests near the owning feature | Runs workspace package tests through Turbo. |

## Semgrep Rules

This section satisfies `firegrid-quality-gates.DOCS.2`.

The Semgrep gate has two severities:

- `ERROR`: CI-blocking unless the exact finding is already in
  `semgrep-error-baseline.json`.
- `WARNING`: backlog signal. Do not add new warnings casually, but they are not
  currently baseline-blocking.

| Rule ID | Severity | What It Forbids | Canonical Replacement | Main Exclusions |
|---|---:|---|---|---|
| `firegrid-no-process-env-outside-bin` | ERROR | `process.env` / `globalThis.process.env` reads in package/app source | Use Effect `Config` at the binary boundary or accept config as an explicit parameter | Tests, `__tests__`, package/app `src/bin`. |
| `firegrid-no-date-now` | ERROR | `Date.now()` in library/app source | `Clock.currentTimeMillis` or caller-provided timestamp from an Effect scope | Tests, `__tests__`, `src/bin`. |
| `firegrid-no-new-date-iso-in-library` | WARNING | `new Date().toISOString()` in library source | `Clock.currentTimeMillis` then format from that value | Tests, `__tests__`, package `src/bin`. |
| `firegrid-no-effect-run-in-library` | WARNING | `Effect.runPromise`, `runSync`, `runFork`, or exit variants in library code | Capture runtime with `Effect.runtime` and bridge with `Runtime.runPromise(runtime)` | Tests, `__tests__`, package/app `src/bin`. |
| `firegrid-no-manual-tagged-error-type` | WARNING | Hand-written `_tag` error type/interface declarations | `Data.TaggedError` or `Schema.TaggedError` | Tests and `__tests__`. |
| `firegrid-no-inline-tagged-error-fail` | WARNING | `Effect.fail({ _tag: "...", ... })` objects | Instantiate the tagged error class | Tests and `__tests__`. |
| `firegrid-prefer-match-tag-over-switch` | WARNING | `switch (value._tag)` dispatch | `Match.value(...).pipe(Match.tag(...), Match.exhaustive)` | Tests and `__tests__`. |
| `firegrid-no-promise-chain-in-effect-code` | WARNING | Promise `.then/.catch` chains in package/app source | `Effect.tryPromise`, `Effect.promise`, or runtime bridge APIs | Tests, `__tests__`, app `main.tsx`. |
| `firegrid-tryPromise-single-await` | WARNING | Multi-step async bodies inside `Effect.tryPromise` | Move sequencing into `Effect.gen`; keep `tryPromise` to one awaited external call | Tests and `__tests__`. |
| `firegrid-no-inline-stream-url-construction` | ERROR | Inline Firegrid Durable Streams authority strings | `namespaceRuntimeStreamName`, `hostStreamName`, `runtimeControlPlaneStreamUrl`, `hostOwnedStreamUrl`, or `durableStreamUrl` | Tests, protocol schema/table files, runtime-host internals where allowed. |
| `firegrid-no-filesystem-in-runtime-package` | ERROR | `fs`, `path`, `os`, or Effect `FileSystem` usage in `packages/runtime/src` | Keep runtime identity/resources explicit; put filesystem policy in bin/app deployment code | Runtime tests and `__tests__`. |
| `firegrid-no-host-id-env-authority` | ERROR | `FIREGRID_HOST_ID` / `VITE_FIREGRID_HOST_ID` as runtime authority | Compose host identity through the approved host authority layer | Runtime/app source; tests excluded. |
| `firegrid-no-source-collections-production` | ERROR | `SourceCollections` / `sourceCollectionStreamHandle` / `registerRuntimeHostAppSource` in package/app source | Select a typed `RuntimeWaitSource` variant resolved from `RuntimeWaitStreams`; add a router `Match` arm for new runtime observations | Tests and `__tests__`. |
| `firegrid-runtime-context-workflow-requires-local-authority` | ERROR | Direct `RuntimeContextWorkflow` execution without local authority gate | `requireLocalContext` before workflow execution | Runtime-host internal exceptions only. |
| `firegrid-no-random-durable-identity` | ERROR | `crypto.randomUUID()` for host/worker/durable execution identity | Derive durable identity from schema-owned authority or caller-provided durable identity | Tests and `__tests__`. |
| `firegrid-no-raw-stream-authority-string-schema` | ERROR | `Schema.String.pipe(streamAuthority)` without validation/brand | Define a schema-owned authority encoder with validation and brand | Authority implementation exceptions only. |
| `firegrid-no-mutable-identity-let` | WARNING | Empty mutable string identity placeholders | Use typed `Option`, `Ref`, or construct the identity once | Tests and `__tests__`. |
| `firegrid-fire-and-forget-promise-uses-fork` | WARNING | Detached `void promise.then(...)` in Effect-adjacent code | `Effect.fork`, `Effect.forkScoped`, or explicit runtime bridge with supervision | Tests, `__tests__`, scripts. |
| `firegrid-no-detached-promise-in-effect-sync` | ERROR | Detached promise chains inside `Effect.sync` | Use `Effect.promise` / `Effect.tryPromise` or a supervised fiber | Tests and `__tests__`. |
| `firegrid-match-should-be-exhaustive` | WARNING | `Match.value(...).pipe(Match.tag(...))` without `Match.exhaustive` | Add `Match.exhaustive` | Tests and `__tests__`. |
| `firegrid-mutable-state-in-effect-gen` | WARNING | Mutating `Map` state directly inside `Effect.gen` | Use `Ref`, `SynchronizedRef`, scoped stores, or isolate mutation in `Effect.sync` | Tests and `__tests__`. |

## Baselines

Some ratchets have baselines:

- `.knip-baseline.json` must stay at zero.
- `.jscpd.json` stores the duplicate-line threshold.
- `effect-quality-metrics-baseline.json` stores per-metric maximums.
- `semgrep-error-baseline.json` stores exact existing ERROR findings by rule,
  path, and line.

Only update a baseline when the current code improved the metric or when a rule
PR intentionally introduces a staged baseline. Do not add baseline entries to
hide findings from an unrelated feature PR.

This guide does not relax or remove ratchets, and it does not install local Git
hooks automatically. Those boundaries are tracked by
`firegrid-quality-gates.SCOPE.1` and `firegrid-quality-gates.SCOPE.2`.
