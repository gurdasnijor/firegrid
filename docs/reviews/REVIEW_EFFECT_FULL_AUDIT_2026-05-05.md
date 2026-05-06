# Effect-TS Full Audit — 2026-05-05

**Scope:** Full repo (`packages/`, `apps/`, `features/`, `scripts/`) including tests and potential (not just definite) violations.
**Verdict:** NON-COMPLIANT.

This complements the prior `REVIEW_EFFECT_TS_DETECTOR_FINDINGS_2026-05-05.md` (which was source-only, definite-only — 68 files / 277 violations). This run covers a larger surface and adds per-hotspot agent review.

## Headline numbers

| Metric | Value |
|---|---|
| Files analyzed | 118 |
| Total violations | 4,023 |
| Definite | 2,089 |
| Potential | 1,934 |
| Source files | 296 definite / 661 potential |
| Test files | 1,793 definite / 1,273 potential |

Detector JSON: `/tmp/firegrid-detect.json` (2.4 MB).

## Top categories (definite)

| Count | Category |
|---|---|
| 1,267 | async |
| 212 | testing |
| 129 | imperative |
| 126 | errors |
| 122 | conditionals |
| 80 | native-apis |
| 74 | code-style |
| 60 | discriminated-unions |
| 19 | schema |

## Top rules

| Count | Rule |
|---|---|
| 983 | async/rule-005 |
| 383 | testing/rule-007 |
| 284 | async/rule-008 |
| 224 | code-style/rule-008 |
| 213 | async/rule-003 |
| 195 | code-style/rule-002 |
| 156 | native-apis/rule-001 |
| 127 | errors/rule-002 |
| 114 | code-style/rule-005 |
| 114 | schema/rule-010 |
| 109 | conditionals/rule-006 |
| 109 | schema/rule-005 |

## Source hotspots (tests excluded)

| Count | File |
|---|---|
| 58 | packages/substrate/src/schema/state-machine.ts |
| 55 | packages/client/src/firegrid/operation-client.ts |
| 54 | packages/substrate/src/subscribers.ts |
| 45 | packages/substrate/src/waits.ts |
| 45 | packages/substrate/src/event-plane/producer.ts |
| 40 | packages/client/src/firegrid/event-client.ts |
| 37 | packages/runtime/src/runtime/internal/operation-handler.ts |
| 35 | apps/lab/src/lab/RawStreamInspector.tsx |
| 34 | packages/substrate/src/choreography/service.ts |
| 31 | packages/substrate/src/producer.ts |

Test files dominate the absolute counts (subscribers.test.ts 240, state-machine.test.ts 205, choreography-service.test.ts 198, producer.test.ts 179, choreography-tools.test.ts 167) but are tracked in aggregate below since the violation pattern is uniform.

## Required conversions per hotspot

### packages/substrate/src/schema/state-machine.ts (58)
- Plain `function` decls at lines 56, 66, 76, 83, 346, 361, 381 → arrow / `Effect.fn`.
- `Data.TaggedError` at 90–104 → `Schema.TaggedError`.
- Plain TS unions for `CompletionMachineState`, `RunMachineState`, `DerivedRunOutcome` → `Schema.Union` of `Schema.Class` variants.
- Imperative `for` + `let` reducer at 320–339 → `Array.reduce` / `Stream` pipeline.
- `switch` on `awaitedCompletion.state` at 385–400 → `Match.value` / `Match.tag`.

### packages/client/src/firegrid/operation-client.ts (55)
- Four `Data.TaggedError` at 66–92 → `Schema.TaggedError`.
- Plain unions `SendError`, `ResultError`, `ObserveError` at 94–103 → `Schema.Union`.
- Cascading `if` chains at 168–194 and 238–271 → `Match` / `Option.match`.
- Repeated `as Schema.Schema.AnyNoContext` casts → tighten descriptor types upstream.

### packages/substrate/src/subscribers.ts (54)
- Six `interface` declarations → `Schema.Class`.
- Three `Data.TaggedError` → `Schema.TaggedError`.
- `new DurableStream(...)` constructed inline at 88–92 → `Context.Tag` service with test layer.
- Data-shape `as` casts at 218–243 → schema decoding.

### packages/substrate/src/waits.ts (45)
- Seven `interface` declarations at 22–77 → `Schema.Class`.
- `throw new Error(...)` at line 17 → `Effect.fail(new SomeTaggedError(...))`.
- Direct `randomUUID()` import at 108 → `IdService` / `Context.Tag`.

### packages/substrate/src/event-plane/producer.ts (45)
- Mutating `for...of` + `if (x !== undefined)` ladder at 61–89 → `Array.filterMap` / `Stream`.
- Nested `if` ladder + `result instanceof Promise` + async/throw block at 96–147 → `Match` + `Effect.tryPromise`.

### packages/client/src/firegrid/event-client.ts (40)
- Non-deterministic id `Date.now() + Math.random().toString(36)` at 103 → `IdService`.
- Inline `new DurableStream(...)` → `Context.Tag` service.

### packages/runtime/src/runtime/internal/operation-handler.ts (37)
- Direct `exit._tag === "Success"` at 134 → `Exit.match`.
- Ternary `failure._tag === "Some" ? ... : ...` at 159–161 → `Option.match`.
- `for...of` + 3-stage `if-continue` at 198–206 → pipeline combinator.

### apps/lab/src/lab/RawStreamInspector.tsx (35)
- Top-to-bottom non-Effect React: `async/await`, `try/catch`, `for await`, ternaries in `setState`, `Array.prototype` mutation, `JSON.stringify`. Rewrite as a `Stream`-driven component.

### packages/substrate/src/choreography/service.ts (34)
- Four-branch `if` ladder at 165–241 → `Match.value` / `Match.tag`.
- `Effect.try` wrapping an existing `Effect` at 207–215 (double-wrap) → remove outer `Effect.try`.

### packages/substrate/src/producer.ts (31)
- Five DTO interfaces → `Schema.Class`.
- Direct `randomUUID()` → `IdService`.
- `as unknown as Record<string, string>` header cast → schema-typed headers.

## Critical cross-cutting violations

1. `Data.TaggedError` everywhere instead of `Schema.TaggedError` (~88 source instances).
2. `interface` for domain types → `Schema.Class` (103 source instances).
3. Imperative `if` ladders → `Match` / `Option.match` / `Schema.is` (94 source instances).
4. `switch` and ternaries in business logic.
5. `for...of` in business logic.
6. Direct `_tag` access — use `Match.tag` / `Schema.is` / `Exit.match` / `Option.match`.
7. Plain `function` declarations (~88 source instances) — should be arrow or `Effect.fn`.
8. Service & testability gaps: `new DurableStream(...)`, `randomUUID()`, `Date.now()`, `Math.random()` called inline. None are behind a `Context.Tag` with a test layer.
9. Tests import `it` from `vitest` instead of `@effect/vitest` and call `Effect.runPromise` inside test bodies (~3,066 violations across 21 test files).
10. `throw new Error(...)` at `waits.ts:17` and inside the async-block of `event-plane/producer.ts`.

## Warnings

- `as Schema.Schema.AnyNoContext` and `as unknown as Record<string,string>` casts (48+ source instances) — fixing descriptor types upstream collapses ~25 of these in one shot.
- Module-level effectful helpers should be `Effect.fn("…")` for spans.
- Unit-conversion call chains should be modeled via `Schema.transform` / `DurationFromMillis`.
- Requirement IDs encoded only in comments — move into `Schema.annotations`.
- `cfg.contentType ?? "application/json"`-style defaults should be `Schema.optionalWith({ default })`.

## Required actions (priority order)

1. Migrate every `Data.TaggedError` → `Schema.TaggedError` (88 source occurrences).
2. Replace all DTO/config `interface`s with `Schema.Class` (~103 source).
3. Eliminate all `if`/`switch`/ternary in business logic via `Match` / `Option.match` / `Schema.is`.
4. Wrap external I/O construction (`DurableStream`, ids, projection loader) in `Context.Tag` services + `*Test` layers.
5. Migrate the entire test suite to `@effect/vitest` (`it.effect`, `it.layer`, `Arbitrary.make`).
6. Eliminate `for...of` / `for await` in business logic.
7. Rewrite `apps/lab/src/lab/RawStreamInspector.tsx` as a `Stream`-driven component.
8. Convert plain `function` decls to arrow / `Effect.fn`.
9. Replace `throw new Error(...)` with `Effect.fail(new TaggedError(...))`.
10. Tighten descriptor types in `@firegrid/substrate/descriptors` to remove `as Schema.Schema.AnyNoContext` casts.

## How to drill in

Inspect any rule's good/bad examples:

```sh
cd /Users/gnijor/.claude/plugins/cache/effect-ts/effect-ts/2.22.16/effect-agent && bun run detect:examples async/rule-005
```

Replace `async/rule-005` with any rule from the table above.
