# Effect-TS Testing Review — Firegrid

**Date:** 2026-05-05
**Scope:** all `__tests__/` directories under `packages/{substrate,runtime,client}` and `apps/lab`
**Primary skill:** `claude-skill-effect-ts/skills/testing/SKILL.md` (v1.3.0)

## Summary

Firegrid currently runs every test under **plain vitest** (`describe`/`it`/`expect`/`beforeAll`/`afterAll` from `vitest`) and drives Effect programs with raw `Effect.runPromise`, `Effect.runSync`, and `Effect.runPromiseExit` calls. The skill's canonical pattern is `@effect/vitest` — `it.effect`, `it.scoped`, `it.layer`, and `it.prop` — which automatically provides `TestContext`/`TestClock`, manages `Scope` lifetimes, and integrates property-based testing with `Schema.Arbitrary`.

`@effect/vitest` is not declared in any `package.json` (root, `packages/*`, or `apps/*` — `grep` returns zero hits). Across ~50 test files, the harness usage breakdown is:

- **210 occurrences** of `Effect.runPromise` / `runSync` / `runPromiseExit` driving Effect programs from `async () => { await Effect.runPromise(...) }` test bodies (count: `grep -c` across all four package test trees).
- **96 occurrences** of `*Live` factory layers (`ProjectionLive`, `SubstrateProducerLive`, `DurableWaitsLive`, `ChoreographyLive`, `FiregridClientLive`, `FiregridRuntimeBoot.attached/embedded*`) provided per-test via `Effect.provide`.
- **Only 2 files** import `TestClock`/`TestContext`: `packages/substrate/src/__tests__/facade-sleep.test.ts` and `packages/substrate/src/__tests__/choreography-examples.test.ts`. Time-pinning is the exception, not the rule.
- **Zero** uses of `Schema.Arbitrary`, `Arbitrary.make`, `fast-check`, `it.prop`, or `it.effect.prop`.
- **38 occurrences** of `Layer.succeed` / `Layer.effect` in tests, but six of those are `effect-consistency.test.ts:82-83` source-grep guards, not runtime layer construction. Real test-double layer construction is concentrated in `facade-launch-dispatch.test.ts`, `facade-prompt-await.test.ts`, and `facade-tool-execution.test.ts`.
- **79 lifecycle hook usages** (`beforeAll`/`afterAll`/`beforeEach`/`afterEach`), almost all of them the `startTestServer`/`stopTestServer` pair from `test-support/durable-streams-server.ts`.

**Net judgement: a partial migration is worthwhile, but a wholesale rewrite is not.** The repo's tests are integration-heavy: ~30 of them run a real `DurableStreamTestServer` on a fresh port, append real bytes, and `rebuildProjection({ url })` against the wire format. That is intentional — it is what makes the substrate's durable-row contract tested at the level the feature spec requires (e.g. `durable-records-and-projections.SUBSTRATE_SCOPE.7`, `firegrid-event-streams.CLIENT_API.1-.3`). For those tests, swapping `Effect.runPromise` for `it.effect` is a stylistic improvement (cleaner `Effect.gen` body, no manual `await` indirection) but adds zero test power. The high-leverage migrations are: time-dependent tests → `it.effect` + `TestClock`, the state-machine matrix → `it.prop` over `Arbitrary.make`, and the per-test `Effect.provide(*Live(...))` chains → a shared `it.layer` block.

## Findings by concept

### 1. `Effect.runPromise` in test bodies

The dominant pattern is:

```ts
it("...", async () => {
  const result = await Effect.runPromise(
    program.pipe(Effect.provide(SomeLive({ streamUrl: url }))),
  )
  expect(result.kind).toBe("timer")
})
```

This appears ~210 times. The skill (`testing/SKILL.md` lines 462-483) calls this an **anti-pattern** when `it.effect` is available, because `it.effect` removes both the `async` wrapper and the `Effect.runPromise` call:

```ts
it.effect("...", () =>
  Effect.gen(function* () {
    const result = yield* program
    expect(result.kind).toBe("timer")
  }).pipe(Effect.provide(SomeLive({ streamUrl: url }))),
)
```

**Where the migration helps:** any test body that already starts with `await Effect.runPromise(Effect.gen(function* () { ... }).pipe(Effect.provide(...)))`. Examples:
- `packages/substrate/src/__tests__/waits.test.ts:46-52` — wraps a one-line `yield* waits.sleep(...)` in `Effect.runPromise` via the `runInWaits` helper at line 37-41.
- `packages/client/src/__tests__/firegrid-event-streams.test.ts:57-62` — `Effect.runPromise(Effect.gen(...).pipe(Effect.provide(layerFor(url))))` is exactly the `it.effect`-shaped body.
- `packages/runtime/src/__tests__/operation-handler.test.ts:71-78` — same shape.

**Where the migration does NOT help:**
- Source-grep regression guards: `apps/lab/src/__tests__/browser-bundle-guard.test.ts` (no Effect involved at all), `apps/lab/src/__tests__/eventstream-workbench.test.ts` (the `readFileSync` source-text assertions), and `effect-consistency.test.ts:60-72` which `grep`s source for forbidden patterns. These should remain plain `it()`.
- Boundary tests that need to inspect `Exit` directly across a runtime boundary: `runtime-hot-paths-internal.test.ts:171-190` — the test deliberately runs `Effect.runPromiseExit` and asserts on `exit.cause._tag === "Fail"`. With `it.effect`, `Effect.exit` inside the body achieves the same outcome more cleanly (skill lines 990-1019), so this is migratable.
- Tests that need `ManagedRuntime`-like setup spanning multiple `it`s within a `describe`. Currently every test rebuilds the layer; `it.layer` solves this, see §4 below.

Quantification: of ~210 `Effect.run*` call sites, **roughly 170-180** are pure `it.effect` candidates; the remainder are either source guards or interleaved `await` / `Date.now()` / promise plumbing that genuinely benefits from staying in async vitest territory.

### 2. `TestClock` opportunities

Time-dependent tests currently fall into two camps:

**Already using TestClock (good, but only 2 files):**
- `facade-sleep.test.ts:36` — `yield* TestClock.setTime(0)` then asserts `dueAtMs === 1500` after `waits.sleep({ durationMs: 1500 })`.
- `choreography-examples.test.ts:359, 383` — `Effect.zipLeft(TestClock.setTime(0))` to pin both runtime and tool sleep paths to identical `dueAtMs`.

**Should use TestClock but currently use real time:**
- `runtime-hot-paths-internal.test.ts:159` — `yield* Effect.sleep("20 millis")` after wake coalescing to "let scheduler settle." This is exactly the case the skill flags (lines 1031-1067): `TestClock.adjust(Duration.millis(20))` after the `Deferred.await` makes the test deterministic and removes the 20ms real-time wait. The current test is structurally fine but slow and theoretically flaky on a loaded CI runner.
- `event-plane-projection.test.ts:104, 113` — two `Effect.sleep(Duration.millis(40))` calls used to give a projection rebuild time to observe an append. These are real-time waits that should either become `TestClock.adjust(Duration.millis(40))` or, more correctly, be replaced by an explicit `Deferred` synchronization (the durable-streams server is real, so the underlying I/O isn't a `TestClock` source — see caveat below).
- `facade-required-action.test.ts:75, 86, 137` and `facade-prompt-await.test.ts:93` — three more `Effect.sleep(Duration.millis(30-50))` patterns of the same shape.
- `runtime-restart-resume.test.ts:92-95` — uses `Effect.retry({ times: 50, schedule: Schedule.spaced("50 millis") })` to poll. This is **the right pattern** for waiting on a real durable-server side effect; do not migrate to `TestClock` here because the clock the projection observes is the test server's wall clock, not Effect's.

**Caveat:** Firegrid's durable server is a real network process (`DurableStreamTestServer` in `test-support/durable-streams-server.ts:13-22`). `TestClock` only controls the *Effect-side* `Clock` reads. Tests that wait for the *server* to materialize a row are **not** `TestClock`-migratable; tests that wait for *Effect's own scheduler* (e.g. coalesced wakes, `Effect.sleep` between two pure Effect operations) **are**. The 5-6 sleep sites listed above need case-by-case review; about half are pure-Effect waits and migratable, half are server-observation waits and should keep `Schedule.spaced`-style polling.

### 3. Property-based tests via `Schema.Arbitrary`

`packages/substrate/src/__tests__/state-machine.test.ts:54-75` manually walks the Cartesian product of `completionStates × {pending, resolved, rejected, cancelled}` (lines 37-42, 69-74) to assert `isLegalCompletionTransition`. The same file repeats this for `runStates`. This is the textbook case for `it.prop` (skill lines 645-689):

```ts
const CompletionState = Schema.Literal("pending", "resolved", "rejected", "cancelled")
const FromState = Schema.Union(Schema.Literal("absent"), CompletionState)

it.prop("transitions are legal iff the matrix says so",
  [FromState, CompletionState],
  ([from, to]) => {
    const legal = legalTransitions.has(`${from}->${to}`)
    expect(isLegalCompletionTransition(...)).toBe(legal)
  })
```

This is no stronger logically (the alphabet is finite) but it is the canonical Effect pattern and would compose with `Arbitrary`-generated `RunValue`/`CompletionValue` for the `foldCompletionRecords` tests at lines 153-192, where today the test hand-constructs sequences like `[pending, fromActorA, fromActorB]`. An `it.prop` over `Arbitrary.make(Schema.Array(CompletionRecord))` would catch any sequence the manual cases miss (e.g. duplicate terminals, interleaved noise IDs).

Other high-value `it.prop` candidates:
- `packages/substrate/src/__tests__/state-schema.test.ts` — round-trip encode/decode test on every row family using `Arbitrary.make(RunValue)` etc. The skill marks this as table-stakes (lines 781-806).
- `packages/substrate/src/__tests__/records.test.ts` and `retained-records.test.ts` — record folding logic is the same shape.

Net: at least two test files (`state-machine.test.ts`, `state-schema.test.ts`) would gain real test power from `it.prop`; the rest of the repo is integration-flavored where Arbitrary mostly buys variety, not coverage.

### 4. Test layers — ad-hoc per-test `Effect.provide` vs. shared `it.layer`

The current pattern, repeated ~96 times: each `it()` body builds its layer inline.

```ts
// facade-launch-dispatch.test.ts:243-247
).pipe(
  Effect.provide(SpyingWorkClaimLive({ streamUrl: url })),
  Effect.provide(ProjectionLive({ streamUrl: url })),
)
```

Because `streamUrl` differs per test (`freshStreamUrl(...)` returns a fresh `${counter}` URL — `helpers.ts:29-32`), a *fully* shared layer is not viable; but a **factory** that returns a composed `Layer` would dedupe the `ProjectionLive + WorkClaimLive + DurableWaitsLive + currentWorkContextLayer` boilerplate that recurs across at least `facade-launch-dispatch.test.ts:243`, `facade-prompt-await.test.ts`, `facade-required-action.test.ts`, `facade-tool-execution.test.ts`, `integrated-path.test.ts`, and `choreography-service.test.ts`. The skill's `it.layer` pattern (lines 524-603) handles this naturally:

```ts
const TestSubstrate = (url: string) =>
  Layer.mergeAll(ProjectionLive({...}), WorkClaimLive({...}), DurableWaitsLive({...}))

layer(TestSubstrate(url))("operator behavior", (it) => {
  it.effect("claim before perform", () => Effect.gen(function* () { ... }))
  it.effect("R requirements preserved", () => Effect.gen(function* () { ... }))
})
```

The win is twofold: (1) the layer is built once per `describe` block, not once per `it`, and (2) the test-vs-prod boundary is documented in one place. There is one implementation friction: the `freshStreamUrl` is currently called *inside* each `it` via `seedReadyRun`/`createSubstrateStream`. Moving it to the `describe` scope means each block gets one stream rather than one per assertion — fine for most tests, but a non-trivial refactor.

### 5. `Effect.runPromise` and the ESLint warn-source

`eslint.config.js:7-15` defines `riskyEffectRuntimeCalls` as `no-restricted-syntax` selectors against `Effect.runPromise` and `Effect.runPromiseExit`. The "production source" config block (line 490, applies to `packages/**/src/**/*.ts`) explicitly **ignores** `packages/**/src/__tests__/**/*.ts` (line 492) and `apps/**/src/__tests__/**/*.ts` (line 493). The matching tests-only block at line 806-823 sets `no-restricted-syntax` to **warn** but loosens unsafe-* rules. CI runs `--max-warnings 0` per `package.json` test script convention; the warns are tolerated in tests because the runtime-call rule is **a separate selector list applied only to non-test code**. The 210 `Effect.runPromise` calls in tests **do not show up** in ESLint output because of the `ignores` clause at lines 492-495.

This is correct behaviour for the current pattern. Migrating to `@effect/vitest` would let the rule apply uniformly and would catch any drift back to manual `runPromise` in newly written tests. **Document this clearly in the migration plan if you proceed.**

### 6. Mock services — Layer.succeed vs. raw object construction

The repo gets this mostly right when it does mock. The three real test-double layers:
- `facade-tool-execution.test.ts:39` — `FakeToolTransportLive = Layer.succeed(FakeToolTransport, { ... })`. Idiomatic.
- `facade-launch-dispatch.test.ts:298-301` — `Layer.succeed(FakeAgentRuntime, { launch: (id) => Effect.succeed(...) })`. Idiomatic.
- `facade-launch-dispatch.test.ts:204-219` — `Layer.effect(WorkClaim, Effect.map(WorkClaim, (live) => ({ attempt: ... })).pipe(Effect.provide(WorkClaimLive(cfg))))` — a spying decorator over the live service. Idiomatic.

What is **missing** is a stateful test layer using `Ref` (skill lines 192-219). The runtime-hot-paths-internal test at line 33-41 hand-rolls a `fakeDb` literal with `subscribeChanges: () => ({ unsubscribe: () => undefined })`. This is typed `as never` to satisfy the call site — a `Layer.effect` with a `Ref<Map<…>>` would be both type-safe and reusable across the three internal-runtime tests in that file. There are no `Layer.succeed` of `Effect.fail("Not implemented")` mocks (the explicit anti-pattern at skill lines 273-313), which is a positive finding.

### 7. Cleanup discipline — `beforeAll`/`afterAll` vs. `it.scoped`

The dominant cleanup pattern is `beforeAll(startTestServer)` + `afterAll(stopTestServer)` (e.g. `waits.test.ts:23-29`, `firegrid-event-streams.test.ts:21-27`, `runtime-restart-resume.test.ts:30-36`). This is correct for a **process-singleton** server: `helpers.ts:13-14` keeps a module-level `server: DurableStreamTestServer | undefined`, and `startTestServer` no-ops if already started. `it.scoped` is **not** the right answer here because the server is shared across the whole test file; per-test `acquireRelease` would tear it down between assertions.

Where `it.scoped` *would* help: the per-test `Effect.scoped(Effect.gen(...))` pattern at `runtime-restart-resume.test.ts:79-107` and `facade-launch-dispatch.test.ts:222-242`. These currently nest `Effect.scoped` inside the `Effect.runPromise` body to manage per-test runtime fibers. `it.scoped` (skill lines 487-501) hoists the scope into the test function signature and removes one level of nesting. This is purely cosmetic, but it's the established Effect convention.

## Out of scope

- The `apps/lab` HTTP / browser surface tests (`browser-bundle-guard.test.ts`, `skeleton.test.ts`, `dev-default-attach.test.ts`) — these are intentionally non-Effect source-grep guards.
- Vitest configuration (`vitest.config.ts`, pool settings, parallelism) — out of scope for a testing-skill review.
- Mutation testing, coverage thresholds, contract-test harness — not addressed by `testing/SKILL.md`.
- Test runtime adoption of `Effect.makeRuntime` / `ManagedRuntime` — separate concern, would be raised by a runtime/lifecycle review.

## Top 5 highest-leverage improvements

1. **Add `@effect/vitest` and migrate the time-dependent tests first.** The 5-6 `Effect.sleep("...")`-as-real-wait sites in `runtime-hot-paths-internal.test.ts:159`, `event-plane-projection.test.ts:104,113`, `facade-required-action.test.ts:75,86,137`, `facade-prompt-await.test.ts:93` are the only places that today trade test time for "scheduler settle" hopes. Migrating just these to `it.effect` + `TestClock.adjust` removes ~150ms of real-time waits per run and eliminates the only flake risk.
2. **Convert `state-machine.test.ts` to `it.prop`.** The exhaustive-matrix tests at lines 54-75 and `foldCompletionRecords` tests at 153-192 are the cleanest property-test candidates in the repo. Define `Schema.Literal` unions for run/completion states (which arguably should already exist in `schema/state-machine.ts`) and let `Arbitrary` walk the space. This both raises confidence and demonstrates the pattern for future schemas.
3. **Extract a `TestSubstrateLive` factory.** The 96 inline `Effect.provide(*Live(...))` chains in `facade-*.test.ts` and `integrated-path.test.ts` collapse to a single `Layer.mergeAll` keyed by `streamUrl`. Even without `it.layer`, factoring this in `helpers.ts` would dedupe ~200 lines of provider noise. Pair with `it.layer` once `@effect/vitest` lands.
4. **Document the test-vs-prod ESLint boundary.** Add a one-paragraph note in the test directory `README` (or a top-of-file comment in `helpers.ts`) explaining that `Effect.runPromise` is allowed *only* in test files because `eslint.config.js:492-495` ignores the test glob. Without this note, a new contributor reading the lint config sees `runPromise` flagged as risky and may "fix" tests unnecessarily.
5. **Replace `fakeDb` cast in `runtime-hot-paths-internal.test.ts:33-41` with a `Layer.effect`/`Ref`-backed test double.** The `as never` cast at line 41 is the only hand-rolled `as never`-typed mock in the test suite; a `Ref<Map<string, CompletionValue>>`-backed `Layer.effect` would give the runner-coalescing test a real, type-safe collection it can mutate from the test body — and it would generalize to the three other internal-runtime tests in the same file.

## What strict-baseline already enforces

The strict-baseline detector (cached results, `/tmp/effect-detect-packages.txt`) flags 474 violations across the production source. The testing-rule violations specifically (testing-package category, codes `testing/rule-007` 379, `testing/rule-012` 45, `testing/rule-004` 30, `testing/rule-003` 14) cover the surface area this review addresses. The detector does not mandate `@effect/vitest` migration, does not require `Schema.Arbitrary`, and does not flag `beforeAll`/`afterAll`. So the strict baseline is **necessary but not sufficient**: the items above are skill-level guidance, not lint-enforced floors. A future detector pass that codifies "no `Effect.runPromise` in `__tests__/`" would close the loop, but that ESLint rule does not exist today (see §5).

---

**Migration risk summary:** the test suite is integration-heavy and depends on a real durable-streams server lifecycle. `@effect/vitest` is a non-breaking superset — `it.effect` and `it()` coexist in the same file, so adoption can proceed file-by-file without a flag day. Start with `state-machine.test.ts` (pure logic, zero server dependency) to prove the pattern, then move to the time-pinned tests, then to the `*Live`-heavy facade tests.
