# Static Enforcement Proposal — Firegrid Effect Compliance

**Date:** 2026-05-05
**Author:** review-synthesis pass
**Companion docs:** `docs/REVIEW_EFFECT_FULL_AUDIT_2026-05-05.md` and the per-skill `REVIEW_EFFECT_*_2026-05-05.md` set.
**Anchors:** `docs/TOOLING.md` (current static-quality stack).

## 1 — Goals

Make every concrete finding in the review docs either:

1. **Mechanically prevented** by an existing static-quality tool (ESLint, dependency-cruiser, semgrep, knip, ts-morph artifact inventory), or
2. **Bounded by a ratchet** that locks in the current count and refuses regressions, or
3. **Documented as a deliberate policy exception** with a per-site escape comment (mirroring the existing `// durable-lint-allow-polling:` convention).

The goal is not to convert all 4,023 detector findings in one slice. It is to make sure no new finding can land, while the per-skill remediation tracks chip away at the backlog.

## 2 — Synthesis of issues to enforce

Pulling across `REVIEW_EFFECT_FULL_AUDIT`, `REVIEW_EFFECT_TESTING`, `REVIEW_EFFECT_PATTERN_MATCHING`, `REVIEW_EFFECT_ERROR_MANAGEMENT`, `REVIEW_EFFECT_RESOURCE_MANAGEMENT`, `REVIEW_EFFECT_CODE_STYLE`, and `REVIEW_FIREGRID`:

### 2.1 Decided policy (do not blanket-enforce against)

These read as violations in the raw detector output but the topical reviews argue for keeping them. Enforcement should target *new drift*, not the existing sites:

| Item | Source | Disposition |
|---|---|---|
| `Data.TaggedError` (39 sites) instead of `Schema.TaggedError` | `REVIEW_EFFECT_ERROR_MANAGEMENT_2026-05-05.md` §1 | **Keep `Data.TaggedError`.** No errors cross a wire; `Schema.TaggedError` would add machinery without payoff. Document the policy and ban only re-introduction of `extends Error`. |
| `cfg.x ?? "default"` for config defaults (most rule-006 hits) | `REVIEW_EFFECT_PATTERN_MATCHING_2026-05-05.md` Out-of-scope | Acceptable; do not enforce conversion. |
| `beforeAll(startTestServer)` / `afterAll(stopTestServer)` | `REVIEW_EFFECT_TESTING_2026-05-05.md` §7 | Correct for process-singleton durable-streams test server. |
| `Effect.runPromise` inside `__tests__/` | `REVIEW_EFFECT_TESTING_2026-05-05.md` §5 | Allowed by intent in test glob. |
| Choreography `Effect.orDie` cluster | `REVIEW_EFFECT_ERROR_MANAGEMENT_2026-05-05.md` §6 | Documented `effectDebtGuardrails` warnings; enforcement is the *justification comment*, not removal. |

### 2.2 Concrete patterns to mechanically prevent

| # | Pattern | Primary review citation | Enforcement target |
|---|---|---|---|
| A | `extends Error` for new domain errors | error-management R7 | ESLint |
| B | New `Data.TaggedError` outside an existing-errors module (lock down growth) | error-management §1 | ESLint custom (allowlist current homes) |
| C | `interface` for domain DTOs in Effect modules | full-audit Critical #2 | ESLint custom (allowlist React-prop / TS utility shapes) |
| D | `if`/`switch`/ternary on tagged-union discriminators | pattern-matching §3, §4, §6 | type-aware ESLint custom |
| E | Direct `._tag` access | pattern-matching §4 | type-aware ESLint custom |
| F | `for...of` / `for await` in `packages/*/src` | full-audit Critical #5; resource §6 | ESLint `no-restricted-syntax` |
| G | Plain `function` declarations in Effect modules | code-style; full-audit Critical #7 | ESLint `func-style` |
| H | `throw new Error(...)` outside boot/script paths | full-audit Critical #10 | ESLint custom (escape token allowed) |
| I | `randomUUID()`, `Math.random()`, `Date.now()` inline | resource §recommendations #4; full-audit Critical #8 | ESLint custom + dependency-cruiser pin |
| J | `new DurableStream(...)` outside the canonical service | resource §acquireRelease, top-5 #2 | ESLint + dependency-cruiser + semgrep |
| K | `it`/`describe`/`expect` from `vitest` (not `@effect/vitest`) for *new* test files | testing §1, §5 | ESLint `no-restricted-imports` with file-allowlist |
| L | `as Schema.Schema.AnyNoContext`, `as unknown as Record<…>` | full-audit Warning #1 | ESLint `no-restricted-syntax` on `TSAsExpression` |
| M | `Effect.try(() => someEffect)` (wrapping an Effect) | choreography review (full-audit Required-Conversions #9) | type-aware ESLint custom |
| N | `Effect.provide(SomeLive(cfg))` inside per-call helpers | resource top-5 #1 | semgrep structural |
| O | `Either.isLeft(x) ? ... : ...` / `Option.isSome(x) ? ... : ...` | pattern-matching §7 | semgrep structural |
| P | `Cause.isInterruptedOnly` repetition (4 sites) | error-management §4; concurrency review | semgrep advisory + extract canonical helper |
| Q | `process.env[…]` outside `bin/` | resource top-5 #5 | semgrep / ESLint `no-restricted-syntax` |
| R | `effectDebtGuardrails` `orDie` site without justification token | error-management top-5 #5 | ESLint custom (require nearby `// effect-debt:orDie:` comment) |
| S | `catchAll` on a single-tag channel where `catchTag` would do | error-management §2 | type-aware ESLint custom (advisory) |
| T | Domain unions declared as `type X = A \| B \| C` instead of `Schema.Union` | full-audit Required-Conversions #1, schema review | ts-morph census + ratchet (NOT lint — too many false positives) |

### 2.3 Architectural metrics — track via ratchet, do not lint per-site

These are too noisy for ESLint but are trackable by the ts-morph artifact inventory:

- Effect-detector total counts per rule (ratchet on `/tmp/firegrid-detect.json`).
- Count of domain `interface` declarations.
- Count of plain `function` decls in Effect modules.
- Count of `Layer.succeed` services holding closure-captured `DurableStream` handles.
- Count of test files importing `it`/`describe`/`expect` from `vitest`.
- Count of `Effect.runPromise` call sites in `__tests__/`.
- Count of `Effect.orDie` / `Layer.orDie` sites (already lint-warned; add count to artifact JSON).

Each metric goes into a tracked baseline file; CI fails if any metric increases. Decreases recompute via a `:baseline` script (parallel to `lint:dup:baseline` and `lint:dead:baseline`).

## 3 — Concrete tooling additions

This section maps each pattern in §2.2 to a specific configuration change.

### 3.1 ESLint local rules — additions

Add to `eslint-plugin-local` (or wherever `local/no-production-js-timers` etc. live):

| New rule | Pattern | Severity | Notes |
|---|---|---|---|
| `local/no-extends-error` | A | error | AST: `ClassDeclaration` with `superClass.name === "Error"`. |
| `local/no-new-data-tagged-error` | B | error | AST: `class extends Data.TaggedError(...)` outside files in allowlist (`*-errors.ts`, plus the existing 18 declaration files). |
| `local/no-domain-interface` | C | error | AST: `TSInterfaceDeclaration` in `packages/*/src/**`, ignoring files matching `*.props.ts`, `apps/lab/**/*.tsx`. |
| `local/no-tag-equality` | E | error | type-aware: `BinaryExpression` `===` with member `_tag`/`kind`/`state` where the object's type symbol is a known tagged union. Allowlist comment escape: `// match-allow-tag-equality:`. |
| `local/no-discriminator-conditional` | D | error | type-aware: `IfStatement` / `ConditionalExpression` whose test resolves to a discriminator literal compare on a tagged union type. |
| `local/no-for-in-effect` | F | error | AST: `ForOfStatement` / `ForInStatement` in `packages/*/src/**` (not in `__tests__/`, not in `bin/`). |
| `local/effect-arrow-functions` | G | error | Reuse `func-style: ["error","expression"]` plus `prefer-arrow-callback`. Apply to `packages/*/src/**`. Allow `function*` (generators) and `Effect.fn(...)` calls. |
| `local/no-throw-in-effect-module` | H | error | AST: `ThrowStatement` in `packages/*/src/**` not in `bin/`/`scripts/`. Escape comment: `// effect-allow-throw:`. |
| `local/no-nondeterministic-globals` | I | error | AST: import of `randomUUID` from `node:crypto`; member-expression `Date.now()` / `Math.random()` outside designated service files. |
| `local/no-direct-durable-stream-ctor` | J | error | AST: `NewExpression` with callee `DurableStream` outside `packages/substrate/src/stream.ts` (the canonical home, paired with `acquireDurableStream`). |
| `local/no-vitest-it-import` | K | error in test files for new files | `no-restricted-imports` `paths: [{ name: "vitest", importNames: ["it","describe","expect","beforeAll","afterAll"], message: "use @effect/vitest" }]` with per-file `// vitest-allow-legacy:` escape. |
| `local/no-anycontext-cast` | L | error | `TSAsExpression` whose target type text matches `Schema.Schema.AnyNoContext` or `unknown as Record<`. |
| `local/no-effect-try-effect` | M | error | type-aware: `Effect.try(() => ...)` where the lambda returns an `Effect.Effect<…>`. |
| `local/no-per-call-effect-provide` | N | warn → error | type-aware: `CallExpression` `Effect.provide(LayerLive(...))` inside a function whose body is itself called once per RPC. (Heuristic: implement as semgrep first.) |
| `local/either-option-match-not-ternary` | O | error | AST: `ConditionalExpression` whose test is `Either.isLeft`/`Either.isRight`/`Option.isSome`/`Option.isNone`. |
| `local/no-process-env-outside-bin` | Q | error | AST: `MemberExpression` `process.env` outside `packages/*/bin/**`, `apps/*/bin/**`, `scripts/**`. |
| `local/orDie-needs-justification` | R | error | When `Effect.orDie` / `Layer.orDie` / `Effect.die*` is called, require a comment within 3 lines containing `effect-debt:orDie:` (free-text reason follows). |

All new rules support a per-site escape comment in the form already in use (`// durable-lint-allow-X:`). The rule fires on the absence of the escape comment, not the call itself, mirroring the choreography `effectDebtGuardrails` pattern.

### 3.2 Semgrep — additions to `.semgrep.yml`

| Rule ID | Pattern | Existing review |
|---|---|---|
| `firegrid-no-direct-durable-stream` | `new DurableStream($CFG)` outside `packages/substrate/src/stream.ts` | resource top-5 #2 |
| `firegrid-no-per-call-substrate-live` | `Effect.provide(SubstrateClientLive(...))` inside a function named `withSubstrate` / `withClient` / `*PerCall*` | resource top-5 #1 |
| `firegrid-no-effect-try-effect` | `Effect.try(() => Effect.$X(...))` and `Effect.try(() => yield* ...)` | full-audit |
| `firegrid-no-throw-tagged-error` | `throw new $TaggedError(...)` outside `Effect.tryPromise` `catch` blocks | full-audit Critical #10 |
| `firegrid-no-process-env-outside-bin` | `process.env[$X]` with path filter | resource top-5 #5 |
| `firegrid-cause-isinterruptedonly-helper` | `Cause.isInterruptedOnly($X) ? Effect.void : Effect.logError(...)` (advisory — flag for `logCauseUnlessInterrupted` extraction) | error-management §4 |
| `firegrid-no-vitest-runpromise-in-effect-test` | inside an `it.effect` body, finds `Effect.runPromise` (advisory while migration is partial) | testing §1 |

Each rule needs a fixture file in `semgrep-tests/` per the existing convention. Add `metadata` with the canonical-helper path.

### 3.3 dependency-cruiser — additions to `.dependency-cruiser.cjs`

| Rule | Forbidden import | Allowed in |
|---|---|---|
| `no-node-crypto-in-domain` | `node:crypto` (and `crypto`) | `packages/*/src/services/uuid/*`, `bin/`, `scripts/`, and explicit `__tests__/` fixtures only |
| `no-node-timers-in-domain` | `node:timers`, `timers/promises` | `bin/` only |
| `no-direct-durable-stream-import` | named import of `DurableStream` constructor from `@firegrid/durable-streams` | `packages/substrate/src/stream.ts` only |
| `no-effect-runpromise-in-source` | named import of `runPromise` / `runSync` / `runPromiseExit` from `effect` into `packages/*/src/**` (excluding `bin/`) | already partly in `eslint.config.js`; promote to dep-cruiser so it is project-wide and can't be disabled per-line |

### 3.4 ts-morph artifact inventory — extensions

Extend `pnpm run arch:effect-artifacts` to emit additional metrics into `docs/effect-artifact-inventory.json`:

```jsonc
{
  "metrics": {
    "effectDetectorTotal": 4023,
    "effectDetectorByRule": { "async/rule-005": 983, /* … */ },
    "domainInterfaceCount": 103,
    "plainFunctionInEffectModule": 88,
    "dataTaggedErrorDeclarations": 39,
    "schemaTaggedErrorDeclarations": 0,
    "newDurableStreamSites": 10,
    "perCallLayerProvideSites": 2,
    "vitestItImportsInTests": 21,
    "effectRunPromiseInTests": 210,
    "effectOrDieSites": 13,
    "nodeCryptoImports": 4,
    "processEnvOutsideBin": 1
  }
}
```

### 3.5 Detector ratchet (new) — `lint:effect-detector`

New script `pnpm run lint:effect-detector`:

1. Run the existing detector (the one that produced `/tmp/firegrid-detect.json`).
2. Compare `definitePerRule` against `effect-detector-baseline.json` checked into the repo root.
3. Fail if any rule's count increased.
4. Companion `pnpm run lint:effect-detector:baseline` to recompute.

Mirrors the `lint:dup` and `lint:dead` ratchets exactly. This is the single most important new gate — it locks in current state across all 4,023 findings without forcing immediate cleanup.

### 3.6 Type-aware ESLint — preconditions

Custom rules D, E, M, S require `parserOptions.project` and `@typescript-eslint/utils`'s `getParserServices`. Steps:

1. Confirm `parserOptions.project` is set in `eslint.config.js` for `packages/*/src/**` (it likely is — it's required for the existing `riskyEffectRuntimeCalls` selectors).
2. Add `requiresTypeChecking: true` to the new rules' `meta`.
3. Measure CI cost: type-aware lint on the substrate test directory has historically been the slowest step. If lint time climbs >30 %, scope these rules to a focused glob (e.g. only `packages/substrate/src/{schema,choreography}`) initially.

### 3.7 Effect compiler diagnostics — promote `effect:patch`

`docs/TOOLING.md` notes `effect:patch` is opt-in because the codebase has existing diagnostics. Add a tracked subset:

1. New script `pnpm run check:effect-patched` that runs `effect:patch && tsc --noEmit && effect:unpatch`.
2. Track an allowlist of files that pass cleanly. As remediation lands, files move into the allowlist.
3. CI fails if a file in the allowlist regresses.

Same shape as the detector ratchet but at the type-checker level.

## 4 — Recommended sequencing

Ordered for maximum coverage with minimum blast radius. Each step is one PR.

| Step | Change | Estimated coverage |
|---|---|---|
| 1 | Detector ratchet (`lint:effect-detector` + baseline) | Locks in 4,023 findings; zero refactor required |
| 2 | One-line ESLint additions: A, F, G, H, K, L, Q | ~1,800 of the rule-level violations cease to grow |
| 3 | dependency-cruiser pins for `node:crypto`, `node:timers`, `DurableStream` constructor | Pattern J + I locked at architecture level |
| 4 | Semgrep additions (3.2 list) | Patterns J, M, N, O, P; structural shapes the AST can't see cleanly |
| 5 | ts-morph metric extensions + ratchet on each metric | Locks in domain-interface count, plain-function count, etc. |
| 6 | Type-aware ESLint custom rules: D, E, M, S | Highest-value gate; measure CI cost first |
| 7 | `local/orDie-needs-justification` (R) | Forces inline rationale on every `orDie` |
| 8 | `local/no-new-data-tagged-error` allowlist (B) | Keeps current `Data.TaggedError` policy from sprawling further |
| 9 | `check:effect-patched` allowlist | Adds Effect compiler diagnostics gate, file-by-file |

Steps 1–3 can ship in a single week; they require no remediation and no behavioural change. Steps 4–5 require new fixtures and metric scripts but no code conversion. Steps 6–9 each require a small remediation slice before they can flip to `error`.

## 5 — Recommended `docs/TOOLING.md` updates

Sections to add or modify:

### 5.1 Update the ESLint section

The existing list of `local/*` rules at lines 23–27 stops at `local/no-host-authority-registry`. Append the new rules grouped by category:

```md
Effect-shape guardrails:

- `local/no-extends-error` errors on classic class-based errors; use `Data.TaggedError`.
- `local/no-domain-interface` errors on `interface` declarations in `packages/*/src/**` outside React props.
- `local/no-tag-equality` errors on direct `_tag === "..."` checks; use `Match.tag` / `Schema.is` / `Exit.match` / `Option.match`.
- `local/no-discriminator-conditional` errors on if/switch/ternary on tagged-union discriminators.
- `local/no-for-in-effect` errors on `for...of` / `for await` in `packages/*/src`.
- `local/effect-arrow-functions` errors on plain `function` decls in Effect modules.
- `local/no-throw-in-effect-module` errors on `throw` outside `bin/`/`scripts/`.
- `local/no-nondeterministic-globals` errors on `randomUUID()`, `Date.now()`, `Math.random()` outside designated service modules.
- `local/no-direct-durable-stream-ctor` errors on `new DurableStream(...)` outside `packages/substrate/src/stream.ts`.
- `local/no-anycontext-cast` errors on `as Schema.Schema.AnyNoContext` and `as unknown as Record<…>`.
- `local/no-effect-try-effect` errors on `Effect.try(() => Effect.X(…))` (double-wrap).
- `local/either-option-match-not-ternary` errors on `Either.is*(…) ? a : b`.
- `local/no-process-env-outside-bin` errors on `process.env[...]` outside `bin/`.
- `local/orDie-needs-justification` errors on `Effect.orDie` / `Layer.orDie` without a `// effect-debt:orDie:` comment within 3 lines.
- `local/no-vitest-it-import` errors on `import { it, describe, expect } from "vitest"` for new test files.
```

Each rule supports a `// {rule-name}-allow:` escape comment.

### 5.2 New section: Effect-detector ratchet

Insert after the dead-code section (line 109):

```md
Run Effect-detector ratchet:

\`\`\`sh
pnpm run lint:effect-detector
\`\`\`

This runs the Effect-TS detector across `packages/*/src` and `apps/*/src`, compares the per-rule violation counts against the tracked baseline in `effect-detector-baseline.json`, and fails CI on any increase. The detector covers async, testing, imperative, errors, conditionals, native-apis, code-style, discriminated-unions, and schema rule families.

Recompute the baseline after a remediation slice:

\`\`\`sh
pnpm run lint:effect-detector:baseline
\`\`\`

The check refuses to lower the gate without an explicit baseline regeneration. Increases require either fixing the new violation or — for genuinely intentional shapes — moving the rule to advisory in the detector config with an inline rationale.
```

### 5.3 New section: Effect compiler diagnostics gate

Add after the existing `effect:patch` paragraph (line 65):

```md
A tracked subset of files is required to pass the patched Effect compiler:

\`\`\`sh
pnpm run check:effect-patched
\`\`\`

This patches the local TypeScript install with `@effect/language-service`, runs `tsc --noEmit` against `effect-typecheck-allowlist.json`, and unpatches afterward. Files in the allowlist must pass cleanly; CI fails on any regression. As remediation lands, additional files are added to the allowlist via:

\`\`\`sh
pnpm run check:effect-patched:expand
\`\`\`

This is the path by which `effect:patch` becomes the default — file-by-file, not big-bang.
```

### 5.4 New section: Architecture metric ratchet

Modify the existing `arch:effect-artifacts` paragraph (lines 119–132) to note that the inventory now feeds a CI gate:

```md
The inventory now also emits a `metrics` block that the static-quality pipeline ratchets against `effect-artifact-baseline.json`. Run:

\`\`\`sh
pnpm run lint:arch-metrics
\`\`\`

Metrics tracked: domain-interface count, plain-function-in-Effect-module count, `Data.TaggedError` declaration count, `new DurableStream` site count, `Effect.runPromise`-in-test count, `Effect.orDie` site count, and the per-rule detector counts. None of these may increase. Decreases recompute via `pnpm run lint:arch-metrics:baseline`.
```

### 5.5 New section: Policy exceptions

Append a top-level section after Static-quality tooling:

```md
## Policy exceptions

These deviations are deliberate and documented:

- `Data.TaggedError` is the firegrid policy. `Schema.TaggedError` is reserved for the moment a future descriptor needs error-decoding from a wire envelope. See `docs/REVIEW_EFFECT_ERROR_MANAGEMENT_2026-05-05.md` §1. The `local/no-new-data-tagged-error` rule prevents *growth* outside the current 18 declaration files; it does not flag the existing 39 sites.

- `Effect.runPromise` is permitted in `__tests__/`. New test files default to `@effect/vitest` (`local/no-vitest-it-import`); legacy files carry `// vitest-allow-legacy:` until the test-migration slice lands.

- `beforeAll(startTestServer)` / `afterAll(stopTestServer)` is correct for the singleton durable-streams test server; `it.scoped` is not the right tool here.

- The choreography facade's `Effect.orDie` cluster is documented in `packages/substrate/src/choreography/service.ts:46-51` and gated by `local/orDie-needs-justification` rather than by removal.
```

### 5.6 Add to the "tooling exists because…" closing paragraph

Replace the closing paragraph (line 192) with:

```md
This tooling exists because the original manual review missed near-duplicates in `packages/substrate/src/retained-records.ts` and similar repeated static-quality issues, and because the 2026-05-05 Effect review surfaced 4,023 detector findings the manual review did not catch. The detector ratchet, semgrep structural rules, and architecture metric gates together replace the per-PR manual Effect-shape review with a mechanical floor. Manual review windows are too narrow to serve as the only guardrail.
```

## 6 — Other tools worth evaluating (not adopting yet)

| Tool | Use case | Recommendation |
|---|---|---|
| **`ts-prune`** | Dead-export detection alongside knip | Skip — knip already covers this; second tool would be noise. |
| **`eslint-plugin-functional`** | Generic immutability / no-loop / no-let rules | Skip — too noisy for a partially-Effect codebase; the targeted custom rules above are better. |
| **`eslint-plugin-deprecation`** | Catches use of deprecated symbols | Adopt if/when Effect APIs flag deprecations. Currently no usage signal. |
| **`madge`** | Cycle detection alternative to dep-cruiser | Skip — dep-cruiser already covers cycles. |
| **`syncpack`** | Workspace dependency version drift | Adopt as a separate `pnpm run lint:syncpack` step. Independent of Effect concerns; trivial to add. |
| **`@arethetypeswrong/cli`** | Validates package `exports` for ESM/CJS consumers | Adopt before declaration emit is turned on (currently off per `TOOLING.md` line 43). Aligns with the package-structure SDD. |
| **`tsd`** | Type-level assertions in tests | Adopt for the `Schema.Class` / typed-error contracts once the `Schema.Class` migration starts. Lets a test like `expectType<RunValue>(decoded)` lock the channel shape at the type level. |
| **`@effect/eslint-plugin`** new rules | Already installed at 0.3.2; only `no-import-from-barrel-package` enabled | Re-audit on every plugin upgrade per existing `TOOLING.md` line 180 — keep that practice. |
| **Mutation testing (`stryker`)** | Verifies test suite catches mutations | Out of scope for this proposal; the Effect-skill testing review noted it as not addressed. |
| **OpenTelemetry runtime span enforcement** | Verifies `Effect.fn(name)` spans land in traces | Connect once `@effect/experimental` is installed (per `TOOLING.md` line 67). Not a static check. |

## 7 — Risks and mitigations

| Risk | Mitigation |
|---|---|
| Type-aware ESLint balloons CI time | Step 6 in §4 — measure first, scope to subset; skip if cost > 30 % |
| Detector ratchet blocks unrelated PRs (e.g. someone fixes a bug and the file rises by one definite count of an unrelated rule) | Per-rule baseline, not per-file. Rule counts only ever decrease. A file change that fixes one issue and introduces another in a different rule is allowed. |
| New ESLint custom rules generate false positives for legit shapes (e.g. React-prop interfaces) | Every rule has a path-allowlist + per-site `// rule-allow:` escape. Same convention as existing `// durable-lint-allow-polling:`. |
| Vitest-import ban breaks legacy tests | Per-file `// vitest-allow-legacy:` escape on every existing test file in the migration PR. Net change for legacy files is one comment line. |
| `local/no-new-data-tagged-error` blocks adding a new error to an existing module | Allowlist is by *file*, not by declaration. New errors in existing `*-errors.ts` modules pass. New error files require an allowlist edit, which is the audit point. |
| dependency-cruiser pin on `node:crypto` breaks scripts | Allowlist `bin/`, `scripts/`, and explicit `__tests__/` fixtures. Scripts retain access. |
| Per-call `Effect.provide(LayerLive(...))` rule (N) over-fires | Implement as semgrep first (advisory), promote to error after the `withSubstrate` fix lands. |

## 8 — Acceptance criteria

This proposal is "done" when:

1. Every pattern in §2.2 has either a CI-blocking rule or an entry in the ratchet baseline.
2. `docs/TOOLING.md` reflects every new rule and script (§5).
3. `pnpm verify` runs the new gates and is the canonical signal for "no new Effect violations."
4. Each per-skill review's "Top 5 highest-leverage" item is either fixed or has a tracked enforcement preventing the same shape from recurring.
5. Policy exceptions (§2.1) are documented in `TOOLING.md` and have escape tokens defined where applicable.

## 9 — Out of scope

- Behavioural refactor of the existing 4,023 findings — owned by the per-skill remediation slices.
- Test-suite migration to `@effect/vitest` — owned by `REVIEW_EFFECT_TESTING` Top-5 #1.
- Schema-typing of domain unions (`RunValue`, `CompletionValue`, `DueTimeDecision`) — owned by `REVIEW_EFFECT_DATA_TYPES` and `REVIEW_EFFECT_SCHEMA`.
- Type emit / declaration files — gated by separate package-structure work per `TOOLING.md` line 43.
- Runtime tracer / OpenTelemetry — gated by the `@effect/experimental` install per `TOOLING.md` line 67.

---

**Net summary:** the firegrid review docs surface 4,023 findings clustered around ~14 mechanical patterns. Eight of those patterns are catchable with single-AST-node ESLint rules; four need type-aware ESLint or semgrep structural rules; the rest are best handled by a detector ratchet plus per-skill remediation. With the additions above, no new instance of any reviewed pattern can land, while the existing backlog is locked at its current size and shrinks monotonically as remediation lands.
