# Effect-Quality Metrics — RETIRED (tf-q6vf)

The AST-precise `effect-quality` **count ratchet** (`pnpm run lint:effect-quality`,
`scripts/effect-artifacts/quality-metrics.mjs` + `effect-quality-metrics-baseline.json`)
has been **deleted**. It was the last baseline-JSON gate in the repo; killing it
removes the drift-prone baseline and the last `.ts`/`.mjs` from `scripts/`
(now operational shell only).

Verification (per-pattern source-read, not a blind drive-to-zero) showed the 20
metrics were a mix of genuine guards, over-matching heuristics, legitimate
patterns, and already-covered cases. Enforcement was re-homed as follows.

## Genuine anti-patterns → strict-0 ESLint rules

AST-precise `local/*` rules in `eslint.config.js` (no source/comment false
positives, pinned to path+line, enabled in the package-source block):

| Retired metric | Replacement rule |
|---|---|
| `newDateIsoCount` | `local/no-new-date-iso` — `new Date().toISOString()`; read `Clock.currentTimeMillis`. Pure value-builders / CLI stamps escape-hatch with `// effect-quality-allow-wall-clock`. |
| `nodeCryptoImportCount` | `local/no-node-crypto-import` |
| `newDurableStreamSiteCount` | `local/no-new-durable-stream` |
| `forOfInPackageSourceCount` | `local/no-for-of-in-source` |
| `anyNoContextCastCount` | `local/no-any-no-context-cast` |
| `detachedPromiseInEffectSyncCount` (was STRICT_ZERO) | `local/no-detached-promise-in-effect-sync` (ancestor-walking) |
| `extendsErrorCount` (STRICT_ZERO) | `local/no-extends-error` (pre-existing) |
| `processEnvOutsideBinCount` (STRICT_ZERO) | `local/no-process-env-outside-bin` (pre-existing) |
| `workflowMakeSiteCount` (C2 / WORKFLOW_ADMISSION) | `local/no-unclassified-workflow-make` — per-site `// workflow-make-admission` annotation gate; see [workflow-make-admission-ledger.md](../workflow-make-admission-ledger.md). |

`effectOrDieSiteCount` / `effectRunInLibraryCount` were boundary patterns, not
debt; they keep their existing advisory `no-restricted-syntax` warns
(`effectDebtGuardrails` / `riskyEffectRuntimeCalls`).

## Dropped — verified non-debt (no replacement)

- `mutableStateInEffectGenCount` — majority false-positive: idiomatic
  `Ref.update(r, (m) => { const next = new Map(m); next.set(...); return next })`
  copies and `url.searchParams.set` (a `URLSearchParams`, not a `Map`). The
  detector cannot distinguish an immutable-copy update from shared-state
  mutation, so a port would re-introduce exactly the false-positive /
  escape-comment debt this consolidation removes.
- `manualTaggedErrorTypeCount` — over-matched **every** `_tag` discriminated
  union (channel bindings, event-source data types), not just hand-rolled
  errors. `local/no-extends-error` already guards the real anti-pattern.
- `tryPromiseMultiAwaitCount`, `fireAndForgetVoidPromiseCount`,
  `throwOutsideBinScriptCount` — all remaining sites live in
  `effect-durable-operators` (excluded from the type-aware lint regime); the
  fire-and-forget is an explicitly-documented React-mount boundary.
- `dataTaggedErrorDeclarationCount`, `switchOnTagCount` — legitimate patterns;
  capping them was noise.
- `perCallLayerProvideSiteCount`, `promiseThenCatchChainCount` — heuristic /
  zero-site; not worth a rule (re-add a `local/*` rule if a real case appears).

## Adding a new guard

Author a small AST-precise `local/*` rule in `eslint.config.js` (see the rules
above for the pattern) and enable it in the package-source config block. Do
**not** reintroduce a baseline-JSON count ratchet.
