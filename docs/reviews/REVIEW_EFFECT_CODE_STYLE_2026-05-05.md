# Effect-TS Code-Style Review — 2026-05-05

## Summary

After R0–R-STRICT-BASELINE the firegrid codebase has the structural Effect bones in place: `Effect.gen` is the dominant control flow, services are uniformly defined as `Context.Tag` or `Effect.Service`, `Layer.effect`/`Layer.succeed` compose them bottom-up, `Data.TaggedError` is used everywhere domain failures appear, and the strict static-quality gates keep new imperative code from sliding in. The codebase is recognizably idiomatic-Effect at the **architecture layer**.

It is **materially divergent** from the canonical code-style skill at the **micro-syntax layer**. The two largest gaps are (a) domain types that remain TypeScript `interface`/`type` declarations rather than `Schema.Class`/`Schema.Union`, and (b) defensive `??`/`if (x === undefined)` idioms instead of `Option`. Neither divergence is incorrect — both compile and pass the existing strict gates — but both make the boundary between trusted Effect data and raw external JSON implicit. There is also a repo-wide divergence from the skill's preferred error type: the skill recommends `Schema.TaggedError`, firegrid has standardized on `Data.TaggedError` (flagged in repo context as canonical).

**Quick stats.** Detector ran 3833 violations across `packages/` and 153 across `apps/lab/`. After filtering tests, the documented intentional surfaces (`bin/firegrid.ts`, lab `*.tsx`, `main.tsx`, `runUnsafe` shim, the substrate `node:crypto` R9 follow-up files), roughly **950 source-side violations remain (~25%)** as real findings; the other ~75% are intentional surfaces or test fixtures.

## Findings by skill category

### schema

**Rule reference**: code-style SKILL.md §"1. Schema-First Data Modeling" ("Define ALL data structures as Effect Schemas"); `schema/SKILL.md` §"Tagged Unions Over Optional Properties".

**Detector volume in firegrid**: 423 (sum of `schema/rule-005`, `-009`, `-010`, `-011`, `-001`, `-007`, `-012`, `-013`, `-015`); ~280 after filtering tests. This is the **largest non-test category**.

**Real findings.**

- `packages/substrate/src/subscribers.ts:42` — `export interface SubscriberInput`; wire-shape input to durable-stream subscribers, should be `Schema.Class` so `streamUrl`/`contentType` actually validates at the boundary.
- `packages/substrate/src/subscribers.ts:47-58` — `TimerSubscriberResult`, `ScheduledWorkSubscriberResult`, `ProjectionMatchSubscriberResult` interfaces returned to Effect callers.
- `packages/substrate/src/subscribers.ts:61-63` — `ProjectionMatchEvaluation` is a discriminated union (`kind: "match" | "no-match"`); should be `Schema.Union` of two `Schema.TaggedClass` arms (flagged as `schema/rule-011`).
- `packages/substrate/src/waits.ts` — 11 interface-to-Schema sites (densest file for this rule).
- `packages/runtime/src/runtime/internal/stream-resolver.ts` — 9 sites on a hot path; the public surface (`StreamResolverInput`) is the priority subset.
- `packages/substrate/src/projection-service.ts:29` — `snapshotFromDb` is a manual conversion function; should be `Schema.transform(SubstrateStreamDB, ProjectionSnapshot, { decode, encode })` for bidirectional, test-exposable behavior.

**Suggested fix shape.** Convert each `interface Foo` whose values cross an Effect/IO boundary into `class Foo extends Schema.Class<Foo>("Foo")({...})`. Keep purely structural HKT helpers (e.g. `PendingOf<K>` at `subscribers.ts:78`, a type-predicate intersection) as `type`.

**Backlog priority.** **H** — many sites but each conversion is local and mechanical. The bigger payoff is that once boundary types are Schema, several conditional/discriminated-unions findings collapse automatically (`Schema.is(NoMatch)` replaces `o.kind === "no-match"`).

### conditionals

**Rule reference**: code-style SKILL.md §"Conditionals - Use Pattern Matching"; `pattern-matching/SKILL.md`.

**Detector volume in firegrid**: 130 (`conditionals/rule-006` + `-002` + `-010` + `-001` + `-008`); ~107 in non-test source.

**Real findings.**

- `packages/substrate/src/subscribers.ts:91`, `:99` — `input.contentType ?? "application/json"`; should be `Option.fromNullable(...).pipe(Option.getOrElse(() => "application/json"))` (or hoisted).
- `packages/substrate/src/subscribers.ts:219`, `:238`, `:354` — `if (data === undefined || typeof data.dueAtMs !== "number")`; cleanest refactor is to model `data` with a `Schema.Class` whose decode failure surfaces `SubscriberDataError` via `Effect.mapError`, eliminating the manual narrow.
- `packages/substrate/src/subscribers.ts:334-335` — `flat.flatMap((o) => (o.kind === "resolved" ? [o.id] : []))` and `…"cancelled"…` — two ternaries doing partition-by-tag; idiomatic form is `Array.partition` / `Array.filterMap` keyed by `Schema.is`.
- `packages/substrate/src/schema/state-machine.ts:74` — `machine[from ?? "absent"].includes(to)` mixes nullish coalesce, native indexing, and native `.includes`; should use `Record.get` + `Array.contains`.
- `packages/runtime/src/runtime/internal/operation-handler.ts:134,161` — `if (exit._tag === "Success")` and `failure._tag === "Some"`; should be `Exit.match` and `Option.match`.
- `packages/substrate/src/projection-service.ts:75` — `opt._tag === "Some"`; should be `Option.match`.

**Suggested fix shape.** For nullable-default expressions, prefer `Option.fromNullable` + `Option.getOrElse`. For `_tag` checks on Effect's own data types (`Option`, `Either`, `Exit`), use the corresponding `match` helper. For domain unions, use `Match.tag` exhaustively.

**Backlog priority.** **M** — bounded count (~107), local refactors, but spread across many files. Worth a single repo-wide PR titled "remove `_tag` access and `??` defaults". Candidate for a future strict gate (the detector already flags both `definite`).

### error-management

**Rule reference**: code-style SKILL.md §"Tagged Errors"; `error-management/SKILL.md`.

**Detector volume in firegrid**: 124 (`errors/rule-002` 85 + `errors/rule-004` 3 + `schema/rule-009` 39 — same root issue counted twice).

**Real finding.** A repo-wide **policy** divergence rather than a bug count. Every domain error extends `Data.TaggedError("Name")<{...}>`; the skill recommends `Schema.TaggedError` because it encodes/decodes across the wire. Representative density:

- `packages/substrate/src/subscribers.ts:19,24,30` — three subscriber errors.
- `packages/substrate/src/event-plane/producer.ts` — 10 declarations (densest file).
- `packages/substrate/src/operator-errors.ts` — entire module.
- `packages/runtime/src/runtime/layer.ts` — 6 runtime-boot errors.

**Suggested fix shape.** Migrate `Data.TaggedError("Foo")<{ readonly cause: unknown }>` to `class Foo extends Schema.TaggedError<Foo>()("Foo", { cause: Schema.Unknown }) {}` — `error-management/SKILL.md` explicitly calls this out as the legitimate use of `Schema.Unknown`.

**Backlog priority.** **H if errors will go over a wire (SSE, RPC, persisted DLQ); M otherwise.** Repo context flags `Data.TaggedError` as canonical, so this is a **policy decision**. Either codemod toward `Schema.TaggedError` or add an ESLint rule banning `Schema.TaggedError` and document the choice in CLAUDE.md.

### imperative

**Rule reference**: code-style SKILL.md §"0. No Imperative Logic".

**Detector volume in firegrid**: 132 (`imperative/rule-005` + `-004` + `-002` + `-006` + `code-style/rule-008` function-expression count); ~26 imperative-loop violations after filtering tests.

**Real findings.**

- `packages/substrate/src/schema/state-machine.ts:321-339` — `foldFirstValidTerminalWinner` is a `for…of` over records with `let winner` reassignment and `continue`. Replaceable with `Array.reduce` returning the first terminal-or-current. The site is annotated `STATE_MACHINE_CORRECTNESS.5` so any rewrite must preserve the "first valid winner" semantics; an `Array.reduce` that ignores subsequent records once `isTerminal(winner)` is true does that exactly.
- `packages/substrate/src/event-plane/producer.ts:86` — `for (const [k, v] of Object.entries(metadata.extra)) merged[k] = v` plus three preceding `if (metadata.X !== undefined) merged.X = metadata.X` mutations on `merged`. Should be `Record.fromEntries` over `Object.entries` filtered by `Predicate.isNotNullable`, then a single spread.
- `packages/substrate/src/retained-records.ts:54` — `for (const event of items) {…}` with `result.push(decoded.right)` (`imperative/rule-005` + `imperative/rule-002` + `native-apis/rule-001-array-operations`). Triple-violation single block; canonical form is `Array.filterMap(items, decodeOrSkip)`.
- `packages/substrate/src/event-plane/projection.ts:105`, `packages/substrate/src/event-plane/define.ts:43`, `packages/substrate/src/projection/ready-work.ts:15` — `new Map<…>()` constructions accumulated by mutation. Should be `HashMap.empty()`/`HashMap.fromIterable` per `data-types/SKILL.md`.
- `packages/runtime/src/runtime/internal/operation-handler.ts:200`, `runner.ts:74`, `event-stream-materializer.ts:161` — `for…of` over Effect outputs; all three are inside `Effect.gen` and would translate cleanly to `Effect.forEach`/`Effect.reduce`.

**Suggested fix shape.** For the substrate `for…of`-with-mutation cases that are pure, `Array.reduce`/`Array.filterMap` are drop-in replacements. For Effect-yielding loops, `Effect.forEach(items, item => Effect.gen(...))` (with `discard: true` when the result list isn't needed) is the canonical refactor.

**Backlog priority.** **M** — fewer than 30 source-side `for…of`s, all definite, but several (the `foldFirstValidTerminalWinner` and the two-pass projection rebuilds) sit on hot paths and need careful behavior preservation. Excellent candidate for a future ESLint `no-restricted-syntax` strict gate **after** these sites are fixed, since the detector already classifies them as `definite`.

### discriminated-unions

**Rule reference**: code-style SKILL.md §"NEVER access `._tag` directly"; `pattern-matching/SKILL.md` §"Match.tag".

**Detector volume in firegrid**: 59 in packages, 7 in non-test source.

**Real findings.**

- `packages/substrate/src/choreography/triggers.ts:85` — `switch (trigger._tag)` on a discriminated union; should be `Match.type` + `Match.tag` + `Match.exhaustive`.
- `packages/runtime/src/runtime/internal/operation-handler.ts:134,161` — `if (exit._tag === "Success")` and `failure._tag === "Some"`; should be `Exit.match` and `Option.match`.
- `packages/substrate/src/projection-service.ts:75` — `opt._tag === "Some"`; should be `Option.match`.
- `packages/client/src/firegrid/client.ts:16` — `export type OperationState<Op>` is a TS discriminated union with `_tag` literals; should be `Data.TaggedEnum` or `Schema.Union` of `Schema.TaggedClass` arms.

**Suggested fix shape.** `switch(x._tag)` → `Match.type` + `Match.exhaustive`. Native `Exit`/`Option`/`Either` `_tag` checks → built-in `match` helpers.

**Backlog priority.** **M** — small site count, mechanical, and `Match.exhaustive` adds compile-time exhaustivity that switch's `default: throw` does not. Candidate for a future strict gate.

### native-apis

**Rule reference**: code-style SKILL.md §"NEVER use native `Object.keys/values/entries`", "NEVER use `array[index]`"; `data-types/SKILL.md` (HashMap, HashSet); `platform/SKILL.md`.

**Detector volume in firegrid**: 230 (`-001` + `-001-array-operations` + `-003` + `-007` + `-012` + `-013` + `-015` + `-002`); ~75 in non-test source.

**Real findings.**

- `packages/substrate/src/projection.ts:32-34` — three `new Map(db.collections.X.state)` in projection rebuild; should be `HashMap` (paired with the row decoder).
- `packages/substrate/src/schema/state-machine.ts:50,60` — `new Set<CompletionState>([...])`; should be `HashSet.fromIterable`.
- `packages/substrate/src/schema/state-machine.ts:74` — `machine[from ?? "absent"].includes(to)`; should be `Record.get` + `Array.contains`.
- `packages/substrate/src/subscribers.ts:205,367,401` — three `buildOrSkip(cancelCompletion(...))` nested-call sites; refactor to `flow(cancelCompletion(...), buildOrSkip)`.

**Suggested fix shape.** Replace `Map`/`Set` with `HashMap`/`HashSet` for repo-owned types; leave external `Map` (DB-row state, `URLSearchParams.entries()`) alone.

**Backlog priority.** **M** — highest-leverage subset is the `new Map`/`new Set` cluster (~30 sites). `Object.entries`/`Object.keys` rides along with the schema refactor.

### services / requirements-management

**Rule reference**: code-style SKILL.md §"Service Definition Pattern"; `requirements-management/SKILL.md`.

**Detector volume in firegrid**: 16 (`services/rule-005` 11 + `services/rule-001` 5).

**Real findings.** Sparse and largely false-positives in this codebase. The flagged sites at `Layer.succeed(FiregridRuntime, runtimeService)` (test-layer construction) are the recommended canonical form for stateless test layers. The `services/rule-005` flags on inline `Effect.gen` inside `Layer.effect` are noise — that **is** the canonical pattern.

**Backlog priority.** **L** — the historical mixing of `Effect.Service` and `Context.Tag + Live` mentioned in the repo context is consistent within each module; flipping convention now would cost more than it saves.

### code-style (function expressions, `as const` casts)

**Rule reference**: code-style SKILL.md §"Generator Syntax (Effect.gen)" (note the skill itself uses `function*()` inside `Effect.gen` — that is the recommended form, so most `code-style/rule-008` flags are noise).

**Detector volume in firegrid**: 215 `code-style/rule-008` (function expressions), 193 `code-style/rule-002` (`as const` casts).

**Real findings.** The 215 `code-style/rule-008` hits are overwhelmingly `Effect.gen(function* () {…})` — that is canonical and should be filtered out at the detector level. The `code-style/rule-002` `as const` cluster (`packages/substrate/src/subscribers.ts:165,185,186,217,…`) constructs discriminated-union literals (`"timer" as const`, `"pending" as const`); these dissolve naturally once the union arms become `Schema.TaggedClass`.

**Backlog priority.** **L** — naturally resolved by the schema migration.

### Tests

~2900 violations live in `packages/**/__tests__/**`, dominated by `async/rule-005/-008/-003`, `testing/rule-007` (`async`/`await`/`Effect.runPromise` in test setup), `code-style/rule-002` (`as const` fixtures), and `testing/rule-012` (hand-crafted test data). Repo context explicitly carves these out; the skill-side recommendation (`@effect/vitest`, `it.effect`, `Arbitrary.make(Schema)`) is a separate larger refactor not gated by the strict baseline.

## Out of scope

- React lifecycle bridge: `apps/lab/src/lab/RawStreamInspector.tsx`, `LabEventStreamPanel.tsx`, `App.tsx` — uses `Effect.runFork`/`runPromise` to stitch React `useEffect` to Effect-managed streams.
- Vite app entrypoint: `apps/lab/src/main.tsx`.
- Node entrypoint: `packages/runtime/bin/firegrid.ts` (documented `NodeRuntime.runMain` boundary).
- Test files: `**/__tests__/**` and `**/*.test.ts` everywhere.
- Source-grep regression guards: `apps/lab/src/__tests__/browser-bundle-guard.test.ts`.
- Substrate `producer.ts`, `internal-claim.ts`, `waits.ts`, `operator.ts` direct `node:crypto` import — open R9-class follow-up.
- `packages/substrate/src/state-machine.ts` `runUnsafe`/`Effect.runSync` shim — documented transitional throwing-API shim.
- Lab `nextEventId = Date.now() + Math.random()` — known L-priority follow-up.

## Top 10 highest-leverage idiomatic improvements (ranked)

1. **`Data.TaggedError` → `Schema.TaggedError` (or codify `Data.TaggedError` policy explicitly).** Action: pick one, lint the other out. Cost: 1 codemod PR or 1 ESLint-rule PR. Strictifiable.
2. **Schema-ify boundary interfaces in `subscribers.ts`, `waits.ts`, `stream-resolver.ts`.** Convert `interface XInput`/`XResult` to `Schema.Class`. Cost: 2 PRs. Strictifiable (rule against `interface` in non-`/types/` files).
3. **Replace `_tag` checks with `Match.tag` / `Option.match` / `Exit.match` / `Either.match`.** ~7 source-side sites + `client.ts:16` `OperationState` union. Cost: 1 PR. Strictifiable (already `definite` flags).
4. **Convert `?? "default"` and `if (x === undefined)` to `Option`.** Return `Option` from decoders. Cost: 1 PR. Strictifiable (`??` ban excluding React/main.tsx boundary).
5. **Refactor the `for…of`-with-mutation accumulators in `state-machine.ts`, `event-plane/producer.ts`, `retained-records.ts`** to `Array.reduce`/`Array.filterMap`/`Record.fromEntries`. Cost: 1 PR plus property-test coverage of `foldFirstValidTerminalWinner`. Strictifiable.
6. **`new Map<>()`/`new Set<>()` → `HashMap`/`HashSet` for repo-owned types.** ~10 substrate sites. Cost: 1 PR. Strictifiable within `packages/substrate/src/projection*.ts`.
7. **Schema-ize completion `data` payload at `subscribers.ts:219,238,354`** so manual `if (data === undefined || typeof data.X !== "number")` collapses into a decode + `Effect.mapError → SubscriberDataError`. Cost: 3 schema declarations. Strictifiable via #4.
8. **Replace `o.kind === "resolved" ? [o.id] : []` partition at `subscribers.ts:334-335`** with `Array.partition`/`Array.filterMap` keyed by `Schema.is`. Cost: small; rides with #2.
9. **`Object.entries(metadata.extra)` mutation in `event-plane/producer.ts:75-87`** → `Record.fromEntries` + `Predicate.isNotNullable` + spread. Cost: trivial. Strictifiable.
10. **Document the `code-style/rule-008` "function expressions inside `Effect.gen`" detector noise.** Add a detector-config exclusion or note in CLAUDE.md. Cost: docs. Not strictifiable.

## What the strict-baseline already enforces (and what it doesn't)

**Already CI-blocked** (per repo context — ESLint `--max-warnings 0`, Semgrep `--error`, jscpd 0, knip strict zero, depcruise at error):

- knip strict zero prevents schema/Match conventions forking into dead alternatives.
- jscpd 0 prevents copy-pasted `_tag` switches from spreading.
- depcruise enforces the intentional non-Effect-surface partition.
- Custom ESLint blocks `Effect.runSync`/`runFork` outside documented suppressions (R-CUTOVER baseline).

**Not yet enforced (candidates for future strict gates).**

- `no-restricted-syntax: ForOfStatement, ForStatement, WhileStatement` outside tests.
- ESLint rule against bare `_tag` member access on Schema/Effect data types.
- ESLint rule against `Data.TaggedError` (or `Schema.TaggedError`, depending on item #1).
- ESLint rule against `??` outside `apps/lab/src/main.tsx` and `bin/firegrid.ts`.
- ESLint rule against `interface X` in `packages/*/src/**` (excluding `types/`).
- ESLint rule against `new Map<>()`/`new Set<>()` in `packages/substrate/src/projection*.ts`.

None should be merged before the corresponding remediation PR — they're listed as natural follow-ons after the top-10 list is worked through.
