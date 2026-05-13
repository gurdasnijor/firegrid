# Effect-Quality Metrics

The repo enforces an AST-precise ratchet on a small set of Effect-related code
quality metrics. The check is `pnpm run lint:effect-quality`; it is part of
`pnpm run verify` and runs in CI as part of the `Lint` job (specifically the
"Check Effect-quality metric ratchet" step).

> Implementation:
> - Detector: `scripts/effect-artifacts/quality-metrics.mjs`
> - Check runner: `scripts/effect-quality-metrics-check.mjs`
> - Baseline writer: `scripts/effect-quality-metrics-baseline.mjs`
> - Baseline file: `effect-quality-metrics-baseline.json`

## How the ratchet works

For each metric, the check refuses to merge a PR whose count is **higher**
than the baseline (a regression). If a metric drops below the baseline,
the check **also** refuses, with a message asking you to lock the new lower
value in by running `pnpm run lint:effect-quality:baseline` and committing
the updated `effect-quality-metrics-baseline.json`.

Some metrics are **strict-zero** (`STRICT_ZERO_METRICS` in
`quality-metrics.mjs`): their baseline must remain 0 and the check refuses
any non-zero count regardless of baseline. Today these are
`extendsErrorCount` and `processEnvOutsideBinCount`.

## Scope rules

A "production source" file is any `.ts`/`.tsx` under `packages/*/src/` or
`apps/*/src/`, excluding `*.test.ts` / `*.test.tsx` / `__tests__/` paths and
excluding `bin/` and `scripts/` paths. A "test source" is the same prefix set
but `*.test.ts` / `*.test.tsx` / `__tests__/`. Some metrics apply only to
production sources; others apply repo-wide. See the per-metric notes below.

## The metrics

| Metric | Scope | Baseline (2026-05-13) | What it counts |
|---|---|---|---|
| `extendsErrorCount` | production | **0 (strict)** | Classes whose `extends` clause names `Error`. |
| `processEnvOutsideBinCount` | production | **0 (strict)** | Reads of `process.env` outside `bin/` and `scripts/`. |
| `throwOutsideBinScriptCount` | production | 2 | `throw` statements outside `bin/` and `scripts/`. |
| `forOfInPackageSourceCount` | production | 18 | `for...of` statements. |
| `anyNoContextCastCount` | production | 0 | `as Schema.Schema.AnyNoContext` casts (incl. chained). |
| `nodeCryptoImportCount` | production | 0 | `import { ... } from "node:crypto"`. |
| `dataTaggedErrorDeclarationCount` | production | 12 | `Data.TaggedError(...)` declarations. |
| `newDurableStreamSiteCount` | production | 0 | `new DurableStream(...)` instantiations. |
| `perCallLayerProvideSiteCount` | production | 0 | `Effect.provide(<X>Live(...))` heuristic — per-call layer construction inside hot paths. |
| `effectOrDieSiteCount` | production | 1 | `Effect.orDie` / `Effect.die` / `Effect.dieMessage` / `Layer.orDie` sites. |

> Baselines drift over time. The single source of truth is
> `effect-quality-metrics-baseline.json`; run `pnpm run lint:effect-quality`
> to see the live current/baseline pair.

## Why each metric exists, and what to do when it regresses

### `extendsErrorCount` — strict zero

Use `Schema.TaggedError`-style errors via `Data.TaggedError` (or
`Schema.TaggedError`), not classes extending `Error`. Native `Error`
subclasses do not carry tag metadata for `Match.tag`, do not encode/decode
through `Schema`, and lose structure across worker boundaries.

**Fix:** convert the class to `Data.TaggedError("MyError")<{ ... }>`. See
existing examples like `LocalProcessStdinDeliveryError` and `WaitForError`.

### `processEnvOutsideBinCount` — strict zero

`process.env` reads belong at the binary entry boundary (`bin/`) or in
tooling scripts (`scripts/`). In application code, accept configuration as
explicit parameters or use `Config.string` / `Config.option` /
`Config.redacted` so the Effect runtime can centralize loading and
validation.

**Fix:** lift the `process.env` read to `bin/<entry>.ts` and pass the
result down through a `Layer.succeed(MyConfig, value)`. Or replace with
`yield* Config.string("MY_VAR")` if the value should be configurable at
runtime.

### `throwOutsideBinScriptCount` — ratchet

Throwing inside Effect code escapes the Effect failure machinery (errors
become defects, lose tracing, bypass `catchAll`). The acceptable cases are
`bin/` entry points and `scripts/`; everywhere else, return an `Effect.fail`
or surface a `Schema.TaggedError`.

**Fix:** replace `throw new X(...)` with
`yield* Effect.fail(new MyTaggedError({ ... }))` (or `Effect.die` only if
the error truly represents a programmer error / unrecoverable defect).

### `forOfInPackageSourceCount` — ratchet

`for...of` is not forbidden, but the Effect idiom is `Effect.forEach`,
`Array.forEach`, `Array.every`, or `Array.reduce`. The metric exists to
prevent imperative loop creep where a functional combinator would do.

**Fix:**
- Loop over an array building side effects: `Effect.forEach(items, (it) => ...)`.
- Pure iteration with no Effect: `items.forEach(...)` or `items.map(...)`.
- Aggregation: `items.reduce((acc, it) => ..., init)`.
- Predicate check: `items.every(...)` / `items.some(...)`.
- Inside a synchronous callback (e.g., `subscribeChanges`): `Array.forEach`.

The wait_for PR (#171) hit this with five new `for...of` loops; the fix
commit (`3b5008e3a`) is a good reference.

### `anyNoContextCastCount` — ratchet

`as Schema.Schema.AnyNoContext` was a workaround for a Schema typing issue
that has since been narrowed. New casts are not allowed.

**Fix:** rework the call site to avoid the cast. If you genuinely cannot,
escalate before adding one.

### `nodeCryptoImportCount` — ratchet

`crypto.randomUUID()` and `crypto.subtle` are available on `globalThis` in
Node 19+ and in the browser. Import `node:crypto` only if you need
algorithms that aren't on the Web Crypto surface (and ideally only from
`bin/` or `scripts/`).

**Fix:** use `crypto.randomUUID()` from `globalThis`, not from `node:crypto`.

### `dataTaggedErrorDeclarationCount` — ratchet

Tracks the count of `Data.TaggedError("Name")<{ ... }>` declarations. This
isn't a "bad" metric — `Data.TaggedError` is preferred over native `Error`
classes — but it's tracked so a regression upward isn't accompanied by a
hidden migration toward less-typed errors elsewhere.

**Fix:** if you're adding a new error type, prefer `Schema.TaggedError` (a
Schema-aware variant) over `Data.TaggedError`. If your `Data.TaggedError`
count drops because you migrated to `Schema.TaggedError`, run the baseline
script to lock the new lower value in.

### `newDurableStreamSiteCount` — ratchet

`@durable-streams/*` client objects should be acquired through scope-managed
Effect layers (e.g., `DurableTable.layer(...)`,
`DurableStream.define(...).producer({ ... })` inside an effect), not via raw
`new DurableStream(...)` in application code.

**Fix:** route the call through the appropriate Effect-shaped helper. If you
need a new helper, add it to the appropriate substrate package.

### `perCallLayerProvideSiteCount` — ratchet

Detects `Effect.provide(<X>Live(...))` calls where `<X>Live` is invoked
inline. Per-call layer construction means every invocation rebuilds the
layer's dependencies (typically a fresh durable stream materializer), which
defeats preload and caching.

**Fix:** acquire the layer once at the application/service/test scope and
provide the resulting service via `Effect.provide(myLayer)`.

### `effectOrDieSiteCount` — ratchet

`Effect.orDie` (and friends) turns a typed failure into an unrecoverable
defect. Useful at the system boundary (e.g., a workflow handler that
declared `error: Schema.Never`), but easy to overuse. The ratchet keeps the
count from growing unnoticed.

**Fix:** prefer surfacing the error in a typed channel
(`Effect.mapError(...)`, declaring an `error:` schema on the workflow,
returning a richer outcome). If `orDie` is genuinely appropriate, the
metric drift is fine — just be ready to justify it.

## Updating the baseline

Two scenarios:

**You made a metric drop (improvement).** The check fails with
`Effect-quality improvement (re-baseline to lock in): ...`. Run:

```bash
pnpm run lint:effect-quality:baseline
```

Commit the resulting `effect-quality-metrics-baseline.json`. This locks in
the new lower value so future regressions are detected against the
post-improvement floor.

**You added a regression intentionally.** The baseline script refuses to
ratchet upward. You have to fix the regression. If you genuinely believe a
ratchet upward is justified (very rare), escalate to coordinator and update
the baseline manually as part of a documented PR — but the default answer
is "rework the code."

## How to add a new metric

If you find a recurring code-quality regression that's worth pinning, add a
new detector in `scripts/effect-artifacts/quality-metrics.mjs`:

1. Add a counter field to `initialMetrics()`.
2. Add an AST predicate inside the source-file walk.
3. Decide whether it's `STRICT_ZERO_METRICS` or ratcheted.
4. Run `pnpm run lint:effect-quality:baseline` to seed the baseline.
5. Add a row to this doc explaining what it counts and how to fix
   regressions.

Keep the per-metric explanation here in sync with the detector. If a
detector is renamed or removed, mark the old name as deprecated in this doc
for at least a release cycle.
