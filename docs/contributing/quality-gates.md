# Quality Gates

Firegrid quality gates are ratchets. They are meant to fail early, locally, and
with a clear remediation path. Run the whole local preflight before pushing a
code PR:

```sh
pnpm run preflight
```

`pnpm run verify` is a thin alias of `pnpm run preflight` (kept for existing
references); both run the same complete gate set, continue after failures, and
print a summary at the end. (`verify` was previously a separate serial subset
that drifted from `preflight`; it was collapsed to an alias in tf-636o so the two
can't diverge.) This satisfies
`firegrid-quality-gates.PREFLIGHT.1` and
`firegrid-quality-gates.PREFLIGHT.2`. Its docs/spec entries satisfy
`firegrid-quality-gates.PREFLIGHT.3`.

## Gate Summary

This section satisfies `firegrid-quality-gates.DOCS.1`. (The runnable
`check:specs`/`check:docs` gates — `firegrid-quality-gates.DOCS.3` — were retired
as low-value tool-wrappers and that ACID deprecated; see tf-dbxp.)

| Gate | Script | What It Forbids | Canonical Replacement | Notes |
|---|---|---|---|---|
| TypeScript | `typecheck` | Type errors across workspace packages | Fix type/service requirements | Runs through Turbo package scripts. |
| ESLint | `lint` | Style, unsafe TS, restricted imports | Follow local ESLint error and use public package roots | Single `eslint .` pass (type-aware + local rules). |
| Dead code | `lint:dead` | Any Knip finding or config-hint | Remove the dead export/import/file (or fix knip.json) | Native strict-0: `knip --treat-config-hints-as-errors`, no baseline. |
| Duplicate code | `lint:dup` | Any jscpd-detected duplication | Extract a shared helper or keep the implementation single-source | Native strict-0: `jscpd packages/*/src` (.jscpd.json threshold 0). |
| Dependency boundaries | `lint:deps` | Forbidden package/app dependency edges | Move code to the owning package or depend on a public subpath | Uses `.dependency-cruiser.cjs`. |
| Effect quality | `lint` (`local/*` rules) | Effect/runtime anti-patterns (replay-unsafe time/RNG, detached promises, type laundering, `Workflow.make` admission) | Use Effect services, scoped layers, typed errors, and approved adapters | Strict-0 AST ESLint rules; the ts-morph count ratchet was deleted (tf-q6vf). |
| Effect diagnostics | `effect:diagnostics` | Any effect-language-service diagnostic in production `src/**` | Fix the site, or add a documented inline `// @effect-diagnostics <rule>:off` | Strict-0, no baseline (tf-ov4w); tests not gated. CI runs this separately from TS typecheck. |
| Tests | `test` | Runtime behavior regressions | Add/fix tests near the owning feature | Runs workspace package tests through Turbo. |

## Source-pattern guard rules (formerly Semgrep)

This section satisfies `firegrid-quality-gates.DOCS.2`.

Semgrep was retired in the static-analysis consolidation (ESLint is the keystone
engine). Its rules moved to two homes; the regexes, scopes, and intent are
preserved:

- **ESLint `local/sg-*` rules** (`lint`, zero-tolerance) — the footprint guards
  that had no live findings. They scan source text with Semgrep's exact regexes,
  scoped per the original rule's `paths` via the enabling block's `files`/
  `ignores`. Edit them in `eslint.config.js` (search `sg-`).
- **Strict-0 `local/*` ESLint rules** (`lint`) — the live-finding Semgrep rules
  briefly lived in an `effect-quality` ts-morph count ratchet; that ratchet was
  **deleted** (tf-q6vf) and its enforcement re-homed to AST-precise ESLint rules:
  `local/no-unclassified-workflow-make` (the C2 workflow-admission guard; per-site
  `// workflow-make-admission` annotation, owners in
  `docs/workflow-make-admission-ledger.md`), `local/no-new-date-iso`,
  `local/no-node-crypto-import`, `local/no-new-durable-stream`,
  `local/no-for-of-in-source`, `local/no-any-no-context-cast`, and
  `local/no-detached-promise-in-effect-sync`. Heuristic / legitimate / excluded
  metrics (`manualTaggedErrorType`, `mutableStateInEffectGen`, `switchOnTag`,
  `tryPromiseMultiAwait`, `fireAndForgetVoidPromise`, `promiseThenCatchChain`,
  `effectRunInLibrary`) were dropped after per-pattern verification — full mapping
  in `docs/contributing/effect-quality-metrics.md`.

| Guard | Engine / id | What It Forbids | Canonical Replacement | Main Exclusions |
|---|---|---|---|---|
| process.env / globalThis.process.env reads | ESLint `local/no-process-env-outside-bin` | env reads in package/app source | Effect `Config` at the binary boundary, or an explicit parameter | tests, `__tests__`, `src/bin` |
| `Date.now()` | ESLint `local/no-date-now` | `Date.now()` in library source | `Clock.currentTimeMillis` or a caller-provided timestamp | tests, `__tests__`, `src/bin` |
| OTel hrtime tuple math | ESLint `local/hrtime-number-arithmetic` | `.{startTime,endTime,duration}[0] * …` | `nsFromHrTime` / `startNs` / `endNs` bigint helpers | — |
| Durable-stream authority strings | ESLint `local/sg-no-inline-stream-url-construction` | inline `*.firegrid.*` stream names/URLs | schema/table authority encoders | schema/table files, runtime-host internals |
| Runtime filesystem use | ESLint `local/sg-no-filesystem-in-runtime-package` | `fs`/`os`/`path`/Effect `FileSystem` in `packages/runtime/src` | explicit config or Durable Streams state | runtime tests, `src/bin` |
| Host-id env authority | ESLint `local/sg-no-host-id-env-authority` | `FIREGRID_HOST_ID` / `VITE_FIREGRID_HOST_ID` | the approved host authority layer | tests |
| Random durable identity | ESLint `local/sg-no-random-durable-identity` | `crypto.randomUUID()` for host/worker/exec identity | schema-owned or caller-provided durable identity | tests |
| Raw stream-authority schema | ESLint `local/sg-no-raw-stream-authority-string-schema` | `Schema.String.pipe(streamAuthority)` | a validated/branded authority encoder | — |
| Runtime authority surface bans | ESLint `local/sg-runtime-no-*` (authority singletons, wrapper types, static helpers, specifiers, registry surface/API, old tag keys, table writes/yields/type-params, second provider) | reintroducing the bundled runtime-authority surface | split Effect `Context.Tag` capabilities + provider layers | `authorities/`, `producers/`, `tables/`, `channels/`, `control-plane/` |
| Source-collection registry | ESLint `local/sg-runtime-host-no-direct-source-collection-registration` | `SourceCollections` / `sourceCollectionStreamHandle` / `registerRuntimeHostAppSource` | a typed `RuntimeWaitSource` from `RuntimeWaitStreams` | tests |
| host-sdk → runtime/substrate imports | ESLint `local/sg-host-sdk-imports`, `local/sg-no-numbered-runtime-subpath` | kernel/_archive/workflow-engine/streams/root-barrel/`@effect/workflow`/numbered subpaths | narrow semantic runtime subpaths | tests |
| Runtime host-internal / runtime-errors imports | ESLint `local/sg-runtime-no-host-internal-imports-outside-host`, `local/sg-runtime-no-runtime-errors-imports-outside-runtime` | importing runtime host impl files / `runtime-errors.ts` externally | the host barrel / public `@firegrid/runtime` exports | inside `runtime/src` |
| Cannon C4/C6/C7 + Shape-C guards | ESLint `local/sg-c4-*`, `local/sg-c6-*`, `local/sg-c7-*`, `local/sg-shape-c-*`, `local/sg-transforms-purity-import-boundary`, `local/sg-composition-no-legacy-imports` | DurableDeferred waits / cursor taxonomies / edge terminal synthesis / workflow machinery in Shape-C / impure transforms / legacy composition imports | the design-constraint-compliant shape | tests |
| Inline tagged-error fail / mutable-identity let / non-exhaustive Match | ESLint `local/sg-no-inline-tagged-error-fail`, `local/sg-no-mutable-identity-let`, `local/sg-match-should-be-exhaustive` | the respective shapes | `Data.TaggedError`; const-before-use identity; `Match.exhaustive` | tests |
| Workflow.make admission (C2) | ESLint `local/no-unclassified-workflow-make` | net-new `Workflow.make` without a `// workflow-make-admission` ledger annotation | SDD-justify + annotate; see `docs/workflow-make-admission-ledger.md` | tests, `__tests__` |
| Replay/durability + type-safety idioms | ESLint `local/no-new-date-iso`, `local/no-node-crypto-import`, `local/no-new-durable-stream`, `local/no-for-of-in-source`, `local/no-any-no-context-cast`, `local/no-detached-promise-in-effect-sync` | `new Date().toISOString()` / `node:crypto` / `new DurableStream` / imperative `for…of` / `…AnyNoContext` casts / detached `void promise.then()` in `Effect.sync` | each rule's message names the canonical replacement | tests, `__tests__`, `src/bin` (date/crypto) |

## Baselines

`lint:dead` (knip) and `lint:dup` (jscpd) are **native strict-0** — no baseline
JSON. `.jscpd.json` holds the config (`threshold: 0`); there is no knip baseline.

There are **no baseline-JSON gates left** in the repo. `effect-quality-metrics-baseline.json`
was deleted (tf-q6vf) — its enforcement is now strict-0 `local/*` ESLint rules; the
grandfathered `Workflow.make` owners are recorded in
`docs/workflow-make-admission-ledger.md` and gated per-site by
`local/no-unclassified-workflow-make`. The per-package
`.effect-diagnostics-baseline.json` files were deleted (tf-ov4w) — `effect:diagnostics`
is now strict-0 over production `src/**`, with genuine findings fixed and the few
false-positive / raw-IO-boundary rules carrying documented inline
`// @effect-diagnostics <rule>:off` directives.

Only update that baseline when the current code improved the metric or when a
rule PR intentionally introduces a staged baseline. Do not add baseline entries
to hide findings from an unrelated feature PR.

This guide does not relax or remove ratchets, and it does not install local Git
hooks automatically. Those boundaries are tracked by
`firegrid-quality-gates.SCOPE.1` and `firegrid-quality-gates.SCOPE.2`.
