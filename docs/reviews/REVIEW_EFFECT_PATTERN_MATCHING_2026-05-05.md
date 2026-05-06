# Effect-TS Pattern Matching Review — Firegrid

**Date:** 2026-05-05
**Branch:** `main` (post R0-R-STRICT-BASELINE)
**Scope:** `packages/*/src` and `apps/*/src` production sources (tests, scripts, and docs excluded).
**Skill anchor:** `claude-skill-effect-ts/skills/pattern-matching/SKILL.md`.
**Companion reviews:** the Effect code-style pass at
`docs/REVIEW_EFFECT_CODE_STYLE_2026-05-05.md` (pattern-matching ranked
#3 cross-cutting top-item there); the data-types pass on the
`ClaimOutcome`/`ClaimAttemptOutcome`/`TriggerMatchEvaluation` unions; and
the schema review for the dispatch surfaces named below.

This review catalogs concrete Match-shape replacements. It is a sites-and-shapes
inventory: zero patches, every finding is anchored at `file:line` so the
remediation owner can pull the fixes into a single `feat: pattern-matching
sweep` PR or split them across the relevant choreography / runtime / client
fronts. Detector cache totals (rule-006: 102, rule-002: 30, rule-010: 25,
rule-008: 13, rule-001: 61) are background context only — the curated sites
below are the load-bearing ones.

## Summary

Firegrid is in a healthier shape than the raw detector counts suggest. The
post-R0-strict baseline already eliminated the worst offenders: there are
**zero `else if` chains**, **zero nested `if` statements** beyond a single
level, and only **two `switch` statements** in the entire production tree.
Most of rule-006's 102 hits are nullish-coalescing on optional config
fields (`contentType ?? "application/json"`) — those are explicitly *not*
in this skill's mandate to refactor unless there is real branching downstream.

What remains is a well-shaped, targeted opportunity. The pattern-matching
debt is concentrated in three places:

1. **Run-state interpretation** — the `RunValue.state` discriminator is
   re-walked via flat `if (state === "...")` ladders in the operation
   client, the runtime handler, and the operator. These are the single
   highest-leverage Match-migration targets in the repo.
2. **Subscriber decisions** — the `DueTimeDecision` / `ProjectionMatchOutcome`
   unions in `subscribers.ts` use the same flat-`if`-on-`kind` shape and
   would simplify dramatically under `Match.tag` once the unions are
   `Schema.Union` (cross-reference the schema review's rule-011 hits).
3. **`ChangeEvent`-shaped guards** in the event plane producer — multiple
   `if ("issues" in r && r.issues !== undefined)` shapes that should be
   `Match.when(Schema.is(...))`.

This is small. The repo has already absorbed the major imperative-control-flow
cleanup; what's left is cosmetic-but-high-leverage where one Match
migration unlocks downstream cleanup of a tagged-union shape.

## Findings by concept

### 1. `else if` chains (skill says: MUST be `Match.value` + `Match.when`)

**None found.** A repo-wide grep across `packages/*/src` and `apps/*/src`
returns zero `else if` occurrences. This is the single best signal in
the review: the strict baseline rule that flagged these has held.

### 2. Ternaries (`cond ? a : b`)

The skill is firm: ternaries should be `Match.value` + `Match.when` or a
simple `if/else`. In practice many of these are *single-line value
selections* and the skill explicitly allows simple `if/else` as the
fallback. Surveyed sites:

- `packages/runtime/src/runtime/internal/operation-handler.ts:161` —
  `failure._tag === "Some" ? failure.value : cause`. This is a direct
  `_tag` ternary — should be `Option.match` (`onNone: () => cause,
  onSome: (v) => v`) or even `Option.getOrElse(() => cause)`. Listed
  under §4 below as well.
- `packages/substrate/src/subscribers.ts:334` /
  `subscribers.ts:335` —
  `o.kind === "resolved" ? [o.id] : []` and the `"cancelled"` twin.
  These are the canonical `Match.tag`-over-tagged-union case (the
  union is `ProjectionMatchOutcome`).
- `packages/substrate/src/subscribers.ts:365` —
  `typeof data.deadlineAtMs === "number" ? data.deadlineAtMs : undefined`.
  Currently a nullable-narrowing dance; should be
  `Schema.is(Schema.Number)` + `Option.fromNullable` (the *runtime*
  benefit is that the `unknown` cast on `data` is replaced by a
  validated decode).
- `packages/substrate/src/descriptors/event-stream.ts:80` —
  `isEventStreamStateRow(value) ? value.value : undefined`. This is a
  Schema-shaped guard returning a value-or-undefined. Should be
  `Option.fromNullable` paired with a `Schema.is` predicate (or fold
  into a single `Schema.decodeOption`).
- `packages/substrate/src/choreography/service.ts:288` —
  `...(timeoutMs !== undefined ? { timeoutMs } : {})`. Spread-of-empty
  ternary; idiomatic in Effect but the cleaner shape is
  `Option.fromNullable(timeoutMs).pipe(Option.match({...}))` or a
  helper `optional({timeoutMs})`.
- `packages/substrate/src/choreography/service.ts:300` —
  `typeof input.at === "number" ? input.at : input.at.getTime()`. This
  is a primitive-vs-Date dispatch. Canonical
  `Match.value(input.at).pipe(Match.when(Schema.is(Schema.Number),
  ...), Match.when(Schema.is(Schema.DateFromSelf), (d) =>
  d.getTime()), Match.exhaustive)`.
- `apps/lab/src/lab/RawStreamInspector.tsx:57`,
  `RawStreamInspector.tsx:68`, `LabEventStreamPanel.tsx:31` — string-vs-Error
  rendering ternaries. UI surface; acceptable as-is per skill since each
  is a single, non-nested `cond ? a : b` with no downstream branching, but
  could be a `Match.value` for consistency.

**Verdict on ternaries:** ~10 sites total in production code. Of those,
the four under `subscribers.ts` are the high-leverage ones because
they live alongside the tagged-union dispatch sites called out in §4.

### 3. `switch/case` statements

Only **two** in the production tree, and the skill explicitly tolerates
`switch` as a "last resort":

- `packages/substrate/src/schema/state-machine.ts:391` — switching on
  `awaitedCompletion.state` (a string-literal union). This is
  exhaustively typed and the function (`deriveBlockedRunOutcome`)
  returns a `DerivedRunOutcome` discriminated union. **Strong Match.value
  candidate** — the result is a tagged union, the input is a literal
  union, exhaustiveness here would catch the new-state-added regression
  the recent `STATE_MACHINE_CORRECTNESS.5` work was protecting against.
- `packages/substrate/src/choreography/triggers.ts:85` — `dispatchTrigger`
  is a *deliberate* exhaustive trigger-tag dispatcher with comments
  documenting "adding a new variant forces a new case here at compile
  time." This is the explicit author intent. **Acceptable per skill**,
  but the same goal is met more idiomatically with
  `Match.type<ChoreographyTrigger>().pipe(Match.tag("ProjectionMatch",
  ...), Match.exhaustive)` and the single-case verbosity goes away.

**Verdict on switch:** 1/2 should migrate to Match (the state-machine
fold), 1/2 is acceptable but would benefit from Match.

### 4. `_tag === "..."` discriminator branches

The skill is firm: never access `._tag` directly — use `Match.tag` or
`Schema.is()`. Sites:

- `packages/runtime/src/runtime/internal/operation-handler.ts:134` —
  `if (exit._tag === "Success") { ... }` over `Exit`. Effect provides
  `Exit.match` and `Match.tag("Success", ...)`/`Match.tag("Failure",
  ...)` — both are strictly better than a tag string compare.
- `packages/runtime/src/runtime/internal/operation-handler.ts:161` —
  `failure._tag === "Some" ? failure.value : cause`. **Use
  `Option.match` or `Option.getOrElse`.** This is the textbook example
  in the skill ("single null check → `Option.match`").
- `packages/substrate/src/projection-service.ts:75` — `opt._tag === "Some"
  ? Effect.succeed(opt.value) : Effect.fail(...)`. **Use
  `Option.match({onNone, onSome})`** (or `Option.matchEffect`). This is
  inside a Stream pipeline, so the cleaner form composes better with
  `Stream.runHead`'s `Option` output downstream.
- `apps/lab/src/lab/LabEventStreamPanel.tsx:93` — `if (exit._tag ===
  "Success") { ... }`. Same as the runtime case: prefer `Exit.match` /
  `Match.tag`.

These four sites are the densest cluster of skill-rule violations in
the repo, and they touch the three load-bearing code paths
(operation-result publishing, projection-stream consumption,
lab UI exit reporting).

The `kind === "..."` ladders in `subscribers.ts` (lines 198, 204, 397
and the ternaries above) are the **same** anti-pattern with a different
discriminator name — they walk a `DueTimeDecision`/`ProjectionMatchOutcome`
union with chained ifs instead of `Match.tag` (or `Match.value` since
these unions are not yet `Schema.TaggedClass`-based; cross-reference the
schema review's rule-011 advice to convert the unions first). Likewise
`facade/work.ts:109` (`outcome.kind === "lost"`).

### 5. Nested `if` statements

**None found that are skill-violating.** All the `if (a) return ...; if
(b) return ...` ladders in `operation-client.ts:172-193`,
`operator.ts:120-164`, `subscribers.ts:198-210`, and
`schema/state-machine.ts:329-336` are *flat early-return* shapes — the
skill explicitly allows simple `if/else` (and `if-return-without-else`
is its terminating-branch cousin). They would *all* read better as
`Match.value`, but they are not strict-rule violations.

The choreography service has two consecutive `if` blocks at
`service.ts:188-198` and `service.ts:200-217` with multi-line AND
predicates. Strictly these are top-level (not nested), but the multi-line
AND predicates are the rule-002 candidates from §6 below.

### 6. Multi-condition `&&` in `if`

The detector flagged 30 such sites. In the surveyed slice the load-bearing
ones are:

- `packages/substrate/src/subscribers.ts:366` — `if (deadlineAtMs !==
  undefined && nowMs >= deadlineAtMs)`. The `Schema.Struct({deadlineAtMs:
  Schema.Number, nowMs: Schema.Number}).pipe(Schema.filter(...))` shape
  is overkill for a single inequality, but combined with the rule-006
  hit on the same line and the upstream `data.deadlineAtMs` cast, the
  *whole* `data: unknown` decode here is a `Schema.decodeUnknown`
  candidate. That is the cross-cutting unlock.
- `packages/substrate/src/event-plane/producer.ts:119`,
  `producer.ts:137` — `if ("issues" in r && r.issues !== undefined)`.
  Standard-Schema's `ValidationResult` is *itself* a tagged union
  in spirit; this is the canonical `Match.when(Schema.is(...))` site.
  Both branches dispatch identical error-construction logic, so a
  single helper `isStandardSchemaFailure` predicate combined with
  `Match.value` collapses both blocks.
- `packages/substrate/src/choreography/service.ts:188`,
  `service.ts:200`, `service.ts:230` — the choreography facade's
  trio of compound-AND guards over `current.state`. All three are
  guarding `RunValue.state === "blocked"` plus a secondary
  `blockedOnCompletionId` predicate. **Highest leverage:** these would
  collapse to `Match.value(current).pipe(Match.tag("blocked", ...),
  Match.orElse(...))` *if* `RunValue` were a `Data.TaggedEnum` /
  `Schema.Union(StartedRun, BlockedRun, CompletedRun, ...)`. That is
  the data-types review's recommendation, and this site is its
  strongest payoff.
- `packages/substrate/src/choreography/tools.ts:113` — `if (run ===
  undefined || run.state !== "blocked" || run.blockedOnCompletionId ===
  undefined)`. Same shape as the service trio.

### 7. `Option.match` / `Either.match` patterns

No nested `Option.match` calls were found. The single-`Option.match`
sites that *should* exist (per the skill) are exactly the missed
`_tag === "Some"` ternaries enumerated in §4.

`Either.isLeft` / `Either.isRight` is used heavily in
`packages/substrate/src/operator.ts` (lines 168, 172, 192) and
`state-machine.ts:41`, `retained-records.ts:57`. These could all be
`Either.match` — the operator usage in particular has an
`Either.isRight ? completeRun(...) : failRun(...)` ternary at line
168-170 that is a perfect `Either.match` site, immediately followed by
an `Either.isLeft` check on the *result* at line 172 and an
`Either.isRight` check on the same value at line 192. That is three
isLeft/isRight calls on the same `handlerResult` in a 25-line block —
**one `Either.matchEffect`** would replace all three and tighten the
state-transition narrative.

## Out of scope

- Tests under `__tests__/` and `apps/lab/src/__tests__` are excluded
  per the brief (their grep-based assertions are intentional non-Effect).
- Nullish coalescing `cfg.x ?? "default"` for config fields with no
  downstream branching (most of rule-006's 102 hits) — wrapping these
  in `Option.fromNullable(...).pipe(Option.getOrElse(() =>
  "default"))` is *strictly* worse for readability and the skill
  acknowledges single-value defaults are fine.
- TS-narrowing `typeof x === "string"` in pure type-guards
  (`isEventStreamStateRow` body) — these are documented Standard-Schema
  predicate idioms; the schema review's rule-011 work is the right
  remediation seam.
- `for (const ...) continue` early-skip loops in
  `retained-records.ts`, `projection/ready-work.ts`, `runner.ts:75`,
  `operator-errors.ts:33` — these are filter-fold loops that the
  Effect code-style review already flagged for `Array.filterMap` /
  `Effect.forEach` migration.

## Top 5 Match-migration candidates (ranked by leverage)

Ranking weights: # of sites collapsed × invasiveness of refactor ×
downstream cleanup unlocked by the migration. Top of list = best
return on engineering time.

1. **`mapRunToState` and `decideTerminal` in
   `packages/client/src/firegrid/operation-client.ts:168-193` and
   `:238-275`.** Two functions, six chained `if (run.state === "...")`
   branches each. Single migration to a shared `Match.type<RunValue>()`
   matcher (or `Schema.TaggedClass` per state, per the data-types
   review) collapses both functions, makes the "Pending" /
   "Completed" / "Failed" / "Cancelled" mapping exhaustive at compile
   time, and surfaces the structurally-unreachable branches that the
   author currently documents in a code comment (`:267-269`). **This
   is the single highest-leverage cleanup in the repo.**
2. **`processDueTimeCandidate` and `processProjectionMatchCandidate` in
   `packages/substrate/src/subscribers.ts:196-211` and `:339-412`.**
   Both walk `DueTimeDecision.kind` / `ProjectionMatchOutcome.kind`
   ladders with `if (...kind === "data-error")` / `"skip"` /
   `"resolve"` shapes. Combined with the §2 ternaries on lines 334-335
   and the `evaluation.kind === "no-match"` check on line 397, this is
   one `Match.tag` migration that would touch ~40 lines of subscriber
   logic. Cross-reference the schema review's rule-011 hits — converting
   `DueTimeDecision` to `Schema.Union(Schema.TaggedStruct("DataError",
   ...), ...)` *first* makes the Match shape trivial.
3. **`exit._tag === "Success"` / `failure._tag === "Some"` cluster in
   `packages/runtime/src/runtime/internal/operation-handler.ts:134`,
   `:161`, plus `LabEventStreamPanel.tsx:93`.** These are the densest
   `_tag`-direct-access sites in the repo and they live on the
   operation-completion hot path. `Exit.match` /
   `Effect.matchCauseEffect` are drop-in. The
   `failure._tag === "Some" ? failure.value : cause` ternary is a
   skill-textbook case (`Option.getOrElse`).
4. **`Either` triple-check on `handlerResult` in
   `packages/substrate/src/operator.ts:168-205`.** Three
   `Either.isLeft`/`isRight` calls in a 25-line span on the same
   value. One `Either.matchEffect` would rewrite the
   `completeRun`/`failRun` build-and-append cascade as a single
   discriminated walk, *and* would eliminate the awkward
   `buildResult.left.from === undefined || ...` defensive cast on
   line 176. Net impact: 3 imperative checks → 1 Match shape.
5. **`deriveBlockedRunOutcome` switch in
   `packages/substrate/src/schema/state-machine.ts:381-400`.** The lone
   real `switch` in the tree. Migration to
   `Match.value(awaitedCompletion).pipe(Match.when({state: "rejected"},
   ...), ..., Match.exhaustive)` makes the noop-vs-fail-vs-cancel
   decision exhaustive at the type level — exactly the kind of
   compile-time safety net `STATE_MACHINE_CORRECTNESS.5` (cited in
   the source comment block) was protecting against. Combined with
   the `if (blockedRun.state !== "blocked" || ...)` early-return
   guard at `:385-390`, the whole function becomes one
   `Match.value` over the `(blockedRun, awaitedCompletion)` tuple.

## Strict-baseline coverage versus what new lint would catch

What the **R0 strict baseline** already enforces effectively:

- No `else if` chains (zero hits in `packages/*/src`).
- No deeply nested `if` (early-return ladders are flat).
- No `switch (x)` proliferation (only two switches in the tree).
- Direct `&&`-chain conditions stay short (no five-clause monsters).

What a **new ESLint or semgrep rule** would still catch:

- `_tag === "..."` direct-tag-access (4 sites; should be banned outright
  with a per-file allowlist for protocol decoders that genuinely need it).
- `cond ? a : b` over a tagged union (the 4 `kind === "..."` ternaries
  in `subscribers.ts` are the cleanest signal — a regex
  `\b(kind|_tag)\s*===\s*["'][^"']+["']\s*\?` would flag each).
- `Either.isLeft(x) ? ... : ...` and `Option.isSome(x) ? ... : ...` —
  these are textbook `Either.match` / `Option.match` sites and a lint
  rule that recognizes the call pattern would zero out a whole class
  of regressions. Currently 4 such sites in `operator.ts` plus the
  `projection-service.ts:74` site.
- Multi-line AND-conditions where the AND-list is itself a discriminator
  walk (`current.state === "blocked" && current.blockedOnCompletionId
  === ...`). A semgrep rule keyed to "two property checks on the same
  identifier joined by `&&`" would flag the choreography service's
  trio. Each is a `Match.tag` candidate after the upstream
  `RunValue`-as-`Schema.Union` migration recommended by data-types.

The remediation seam is clear: run the data-types review's
`Schema.Union`/`Schema.TaggedClass` conversions first
(`RunValue`, `CompletionValue`, `DueTimeDecision`,
`ProjectionMatchOutcome`, `ClaimOutcome`); the pattern-matching cleanup
of items 1-2 in the top-5 *follows mechanically* once those unions are
schema-typed, because `Match.tag` and `Schema.is()` both light up at
that point. Items 3-5 are independent of that seam and can land
piecewise.
