# Effect-TS Core Idioms Review — Firegrid (2026-05-05)

Scope: production code under `packages/{substrate,runtime,client}/src` and
`apps/lab/src` after R0-R-STRICT-BASELINE / R0B. Focus is on the
fundamental `Effect<A, E, R>` composition idioms (Effect.gen vs pipe,
constructor selection, sequencing operators, `Effect.all`, `match` /
`matchEffect`, `tap`, `suspend` / `lazy`, run-boundary placement, type
signatures). Code-style and data-types neighbors are referenced but not
re-litigated.

## Summary

The post-R0B baseline is in good shape on Effect-core fundamentals.
Constructor selection is consistent and at the I/O boundary. Run-
boundary placement is disciplined: production
`Effect.runPromise/runFork/runPromiseExit` calls are confined to the
lab React boundary (`apps/lab/src/lab/LabEventStreamPanel.tsx`), the
bin entry uses `NodeRuntime.runMain` (not `runPromise`), and
`Effect.runSync` survives only inside the documented compat shim
(`packages/substrate/src/state-machine.ts`). Composition is gen-dominant
(58 production `Effect.gen` blocks; ~50 substantive Effect-pipe
chains). `Effect.flatMap`/`map` are used exclusively for Effect
sequencing; `Effect.andThen` is not used anywhere, and `Effect.all` is
not used in production. Remaining gaps are small: a few single-yield
gens that survived R0B, a load-bearing Either-ladder in operator.ts
that should be documented, and one suspect `Effect.suspend` site.

## Findings

### 1. Effect.gen vs pipe consistency

The split tracks the guidance well — multi-step substrate logic uses
`Effect.gen` (e.g. `packages/substrate/src/operator.ts:105`,
`packages/substrate/src/internal-claim.ts:46`,
`packages/substrate/src/choreography/service.ts:154`,
`packages/runtime/src/runtime/internal/operation-handler.ts:114`),
while single-transformation chains use pipe (e.g.
`packages/substrate/src/retained-records.ts:93`,
`packages/client/src/firegrid/event-client.ts:115`).

**Single-yield gens that survived R0B.** A handful of one-yield gens
remain that flatten cleanly to pipe:

- `packages/substrate/src/waits.ts:136-143` — `findExisting` wraps one
  `Effect.tryPromise` then reads `snap.completions.get(completionId)`.
  Flattens to `Effect.tryPromise({...}).pipe(Effect.map(snap =>
  snap.completions.get(completionId)))`.
- `packages/substrate/src/producer.ts:131-140`, `:171-179`, `:182-190`,
  `:193-201` — each producer method is a 3-yield gen (build event →
  append → return literal). The literal-return argues for keeping
  `Effect.gen`, but a strict pipe form
  (`buildEvent.pipe(Effect.tap(append), Effect.as({...}))`) is also
  legitimate. Judgement call.
- `packages/substrate/src/choreography/tools.ts:207-219`, `:225-238`,
  `:244-256`, `:262-270` — each `handle: input => Effect.gen(function*
  () { const choreo = yield* Choreography; return yield*
  wrapSuspending(cfg, opName, choreo.X(...)) })` is a single-yield-of-
  context gen. Could be `Choreography.pipe(Effect.flatMap(choreo =>
  wrapSuspending(...)))`, but the four call sites are structurally
  identical and consistency wins; see Top 5 #5.

**Nested gens.** Several places nest gen inside gen (e.g.
`packages/runtime/bin/firegrid.ts:73,80,93,111`,
`packages/client/src/firegrid/operation-client.ts:209-212`). These
scope an inner `Effect.provide` and are idiomatic.

**Deep pipes converted to gen — none observed.** The longest pipes
compose Stream operators (operation-handler dispatch, event-stream
materializer) where gen doesn't apply.

### 2. Effect constructors at boundaries

Constructor placement is correctly partitioned:

- `Effect.tryPromise` — used at every async I/O boundary (Durable
  Streams `head`/`stream`/`json`, `rebuildProjection`, `appendChange`).
  Examples: `packages/substrate/src/internal-claim.ts:50`,
  `packages/substrate/src/retained-records.ts:29,38`,
  `packages/substrate/src/event-plane/producer.ts:116`,
  `packages/runtime/src/runtime/internal/event-stream-materializer.ts:96`,
  `packages/runtime/src/runtime/internal/stream-resolver.ts:60,100`.
- `Effect.promise` — only at finalizers where cancellation is
  non-failing (`packages/runtime/src/runtime/internal/event-stream-materializer.ts:113`,
  `packages/runtime/src/runtime/internal/stream-resolver.ts:75`). Correct
  use: a cancel/stop call's error policy is "best-effort during teardown".
- `Effect.sync` — used only for synchronous side-effects (subscribe
  handlers, unsubscribe functions). All sites (e.g.
  `packages/substrate/src/projection-service.ts:56,62`,
  `packages/substrate/src/stream.ts:59`,
  `packages/runtime/src/runtime/internal/wake-stream.ts:13`) are
  legitimately impure operations. None are masquerading for
  `Effect.succeed`.
- `Effect.try` — exactly one site:
  `packages/substrate/src/choreography/service.ts:207`. The `blockRun`
  builder is itself an Effect; here the call wraps a defensive
  re-throw against an expected non-Effect mistake. Worth flagging:
  `blockRun` already returns `Effect<ChangeEvent, IllegalRunTransition>`
  (see `packages/substrate/src/state-machine.ts` re-export). Wrapping it
  in `Effect.try` discards the typed `IllegalRunTransition` channel and
  re-types the failure as a `ChoreographyVerificationError` via
  `catch:`. The intent is to remap any thrown defect, but `blockRun`
  doesn't throw — it returns a failed `Effect`. This collapses to
  `yield* blockRun(...).pipe(Effect.mapError(cause => new
  ChoreographyVerificationError({ ... })))`. Worth verifying whether the
  re-export shim in `state-machine.ts` (which DOES throw via
  `runUnsafe` lines 39-45) is what's being defended against — if so,
  swap to importing from `./schema/state-machine.ts` directly to get
  the Effect-channel form.
- `Effect.succeed` / `Effect.fail` — used cleanly to lift literal
  results / typed errors into the channel. No misuse spotted.
  `Effect.failCause` is used once
  (`packages/substrate/src/choreography/tools.ts:180`) to re-raise a
  non-interrupt cause inside a `matchCauseEffect`, which is the correct
  primitive for that situation.

### 3. andThen vs flatMap vs map

**`Effect.andThen` is not used anywhere in production.** All chaining is
`Effect.flatMap` (with `Effect.map` for pure transforms). Strictly this
is fine — `andThen` has slightly nicer ergonomics for the dual case
where the next step is a value, an Effect, or a thunk-returning-Effect,
but the codebase consistently uses `flatMap`/`map`/`succeed` and the
result is unambiguous. No churn warranted unless a future case wants the
union behavior.

`Effect.zipRight` appears at
`packages/runtime/src/runtime/internal/runner.ts:163-164` (chaining two
finalizer effects) and `apps/lab/src/lab/LabEventStreamPanel.tsx:58`
(panel mount → stream follow). Both are appropriate uses where the left
result is `void` and is genuinely discarded.

`Effect.as` appears at
`packages/substrate/src/schema/state-machine.ts:127` (validate-then-
emit-event), `packages/substrate/src/facade/work.ts:168`
(record-outcome shape), and
`packages/runtime/src/runtime/internal/operation-handler.ts:128,142`
(after a `.catchTag` returns a logged error, replace with `undefined`
sentinel). All idiomatic.

`Effect.asVoid` is used appropriately at
`packages/client/src/firegrid/event-client.ts:127` and
`packages/runtime/src/runtime/internal/runner.ts:146`.

### 4. Effect.all variants

**`Effect.all` is not used in production.** The codebase models its
parallel/sequential work through `Stream` (with `Stream.runDrain` /
`Stream.runForEach` / `Stream.mapEffect`) and through `Effect.forEach`
(`packages/substrate/src/subscribers.ts:183`). For the workloads here
that's the right shape — the candidates being processed are finite per
wake but the wake source is a stream, so a Stream-based loop is
correct and `Effect.all` would have nothing to combine.

`Effect.forEach` at `subscribers.ts:183` runs sequentially (default
concurrency), which is what scan ordering wants (one snapshot's pending
candidates processed left-to-right with shared `Clock` and `stream`
context). No concurrency option is needed.

If a future entry point wants a fan-out — e.g. multiple plane producers
emitting in parallel, or a multi-stream materializer — `Effect.all([...
], { concurrency: "unbounded" | N })` is the idiomatic pick.

### 5. Effect.match vs matchEffect

Exactly one match-family site:
`packages/substrate/src/choreography/tools.ts:169` —
`Effect.matchCauseEffect({ onSuccess, onFailure })`. This is the right
primitive: the operation is supposed to interrupt on success
suspension; the only non-interrupt failure paths are defects to
re-raise and translated `ChoreographySuspension` values. Using
`matchCauseEffect` (vs `matchEffect`) is essential here because the
defect/interrupt distinction lives in the `Cause`, not the typed error
channel.

The data-types review flagged `operator.ts` as a candidate for an
`Effect.match*`-style refactor. Looking at the call sites:

- `packages/substrate/src/operator.ts:148` —
  `const handlerResult = yield* Effect.either(args.handler(args.item))`,
  followed by an `Either.isRight`/`Either.isLeft` pair at lines 168-171
  to choose between `completeRun` and `failRun`. This collapses to
  `Effect.matchEffect(args.handler(args.item), { onSuccess: result =>
  completeRun(postRun, { result }), onFailure: error =>
  failRun(postRun, { error }) })` — but the catch is that the post-
  handler authoritative re-read at lines 153-164 happens BETWEEN the
  handler running and the terminalization decision, so a direct
  `matchEffect` swap doesn't fit. The Either-as-value pattern here is
  load-bearing: the handler's exit-state has to survive the post-read.
  No refactor recommended; document the constraint instead.

- `packages/substrate/src/operator.ts:167-186` — building the terminal
  event uses `Either.isRight(handlerResult)` to dispatch between
  `completeRun` and `failRun`, then `Effect.either` of that build
  followed by `Either.isLeft(buildResult)` to detect a race. The
  Either-of-Either nesting is intentional (handler outcome × build
  outcome are independent) but reads densely. A small win: the
  `buildResult` arm could be `matchEffect`-ed by yielding straight
  through and using `Effect.catchTag("IllegalRunTransition", ...)` to
  funnel the race fallback. Tradeoff: the current shape keeps the
  builder-rejected `from` value visible at the call site (line 175-179),
  which `catchTag` would also expose — net wash.

Plain TS branching that returns Effects (the if-ladders in
`packages/client/src/firegrid/operation-client.ts:172-194` and
`:244-271`) are not Effect.match candidates — they're branching on a
plain TS discriminant before yielding; the right tool is `Match` from
`@effect/Match`, which is the data-types/code-style review's domain.

### 6. Effect.tap / tapErrorCause

Three production tap sites, all correctly used as side-effect-only
observation points:

- `packages/runtime/src/runtime/internal/runner.ts:155` —
  `Effect.tap(() => Effect.sync(wake))`. Wakes the loop after sleep
  completes; data flow continues unchanged.
- `packages/runtime/src/runtime/internal/runner.ts:180`,
  `event-stream-materializer.ts:183`, `operation-handler.ts:209` —
  `Effect.tapErrorCause` paired with `Cause.isInterruptedOnly` to log
  unexpected failures while letting interruption pass silently. This is
  the canonical pattern for a long-running fiber that should die loudly
  on real failure but quietly on shutdown. Three matching sites, three
  correct uses.

No `Effect.tap` is being used to thread data (which would be the wrong
operator — `flatMap` is for data-threading); discipline holds.

### 7. Effect.suspend / Effect.lazy

Two `Effect.suspend` sites, no `Effect.lazy`:

- `packages/substrate/src/projection-service.ts:49` — `snapshot:
  query => Effect.suspend(() =>
  query.evaluate(input.snapshotFromDb(input.db)))`. **Correct.** Each
  `snapshot()` invocation must read the LIVE db (the `db` is held by
  the closure for the layer's lifetime); without `suspend`, the
  evaluated Effect would close over the snapshot taken at
  service-build time. This is exactly what `suspend` is for.

- `packages/substrate/src/event-plane/producer.ts:101` — `revalidate
  = (...) => Effect.suspend(() => { const def =
  collectionsByType.get(event.type); ... })`. **Probably unnecessary.**
  The body branches on `event.type`/`event.value` (immutable inputs)
  and the `collectionsByType` lookup map is built at producer-construct
  time. There is no time-varying state inside the closure, so the
  suspend is preserving nothing — `Effect.gen(function* () { ... })`
  with the same body would build the Effect on call without losing
  anything. Worth flattening to a regular function returning the
  appropriate Effect or a small `Effect.gen`. Low priority.

### 8. Run-boundary audit

All production `Effect.run*` sites land at the documented boundaries:

- `apps/lab/src/lab/LabEventStreamPanel.tsx:54` (`Effect.runFork`),
  `:82` (`Effect.runPromise(Fiber.interrupt(fiber))`), `:92`
  (`Effect.runPromiseExit(emitLabEvent(...))`). Each is preceded by an
  `eslint-disable-next-line no-restricted-syntax` comment explaining
  the React-boundary rationale. Suppression is explicit, narrow, and
  correctly scoped.
- `packages/substrate/src/state-machine.ts:40` (`EffectRuntime.runSync`)
  inside `runUnsafe`, the documented compat shim that re-exports
  state-machine builders as throwing functions for legacy callers. The
  file's intent is bridging only.
- `packages/runtime/bin/firegrid.ts:154` uses
  `NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))`,
  not `Effect.runPromise`. This is the correct CLI-entry primitive
  (handles SIGINT/SIGTERM cleanly via the platform layer).

No production code outside those three locations runs Effects. The
test suites use `Effect.runPromise`/`runPromiseExit` extensively, which
is expected.

### 9. `Effect.gen(this, function* () { ... })`

Zero usages anywhere. The this-binding form is unnecessary outside of
class-method contexts that capture `this`, and the codebase models
services through `Context.Tag` + closure capture, never via class
methods that need their own `this` inside the generator.

### 10. Type signatures

**`Effect.Effect<A>` (1-arg) usage.** ~125 production type annotations
include `Effect.Effect<...>`. Of those, ~7 use the 1-arg shorthand
`Effect.Effect<A>` (e.g.
`packages/substrate/src/subscribers.ts:130`,
`packages/substrate/src/choreography/tools.ts:170,176`,
`packages/runtime/src/runtime/internal/wake-stream.ts:3,7`,
`packages/runtime/src/runtime/internal/runner.ts:135,142`,
`packages/runtime/src/runtime/internal/stream-resolver.ts:123`).

In every spotted case, the value really is `<A, never, never>` — these
are subscriber outcomes, finalizers, and resolver Effects with no
typed errors and no requirements. The 1-arg shorthand is the
documented Effect convention; rewriting to `<A, never, never>` would
add visual noise without information. Keep as-is.

**Inline cast at the schema boundary.** Multiple sites cast through
`Effect.Effect<...>` after `Schema.decodeUnknown` /
`Schema.encodeUnknown` (`operation-client.ts:151,166`,
`event-client.ts:90,101`, `event-stream-materializer.ts:133-136`,
`operation-handler.ts:77`). This is a known artifact of
`Schema.Schema.AnyNoContext` carrying `R = unknown` — the cast is
documented in `operation-client.ts:131-137` and is a sound, intentional
bridge. Not a finding.

## Out of scope

- **Schema decode/encode patterns**, `Match` for plain TS dispatch,
  branded types, `Data.TaggedError` definitions — code-style and
  data-types review territory.
- **`if/else` ladders that return Effects** in `operation-client.ts`
  (mapRunToState, decideTerminal): Match-vs-if is a `with-style`
  concern, not Effect-core.
- **Stream operator selection** (`mapEffect` vs `flatMap` vs
  `filterMap`): Streams skill, not core.
- **Layer composition / requirements management**: requirements-
  management skill.
- **Cause/Exit error handling depth** (`Cause.isInterruptedOnly`,
  `Cause.failureOption`, `Cause.pretty`): error-management skill;
  current uses look correct but a dedicated review would dig deeper
  on `tapErrorCause` vs `tapDefect` etc.
- **The compat shim itself** (`state-machine.ts` `runUnsafe` calling
  `runSync` and rethrowing): listed in repo context as transitional,
  not a finding.

## Top 5 Idiomatic Improvements (ranked)

1. **Flatten `findExisting` in `waits.ts:136-143`** to a pipe over
   `Effect.tryPromise(...).pipe(Effect.map(snap => snap.completions.get(completionId)))`.
   Smallest-payoff item but it's a textbook one-yield gen the R0B pass
   missed and will keep slipping into review queues until it's fixed.
2. **Resolve the `Effect.try(blockRun)` re-throw at
   `choreography/service.ts:207`.** Either route to
   `./schema/state-machine.ts` directly and use
   `Effect.mapError(cause => new ChoreographyVerificationError({...}))`,
   or document explicitly that the import is via
   `../state-machine.ts` (the throwing shim) and the `Effect.try`
   wrap is mandatory. Currently an architectural "why" is missing on
   that single odd `Effect.try` call.
3. **Drop `Effect.suspend` from `event-plane/producer.ts:101`** — the
   closed-over state is immutable, so `suspend` adds nothing. Replacing
   it with a plain `Effect.gen` body or pipe (or returning the Effect
   directly) clarifies intent and removes a small distractor for future
   readers wondering "why suspend here?".
4. **Document the operator.ts Either-pattern as deliberate.** Add a
   comment near `operator.ts:148` and `:167` explaining that
   `Effect.either` here is load-bearing because the post-handler
   authoritative re-read must run between the handler exit and
   terminalization. Without that comment, future review passes will
   keep proposing a `matchEffect` collapse that doesn't fit. (No code
   change.)
5. **Consider a single helper for choreography tool bindings** in
   `choreography/tools.ts:207-270`. The four `handle: input =>
   Effect.gen(function* () { const choreo = yield* Choreography;
   return yield* wrapSuspending(cfg, opName, choreo.someCall(...)) })`
   blocks are structurally identical except for the operation
   name and the choreo call. A `bindSuspending(opName, callBuilder)`
   helper would cut four near-duplicates to one. (Optional; current
   form is readable.)

## What strict-baseline enforces vs gaps

**Enforced (no follow-up needed):**
- `Effect.runSync` / `runPromise` / `runFork` confined to documented
  boundaries (verified above).
- `try/catch` not used in production for Effect logic.
- `JSON.parse` → Schema decode (verified separately by Schema review).
- Effect.gen blocks contain `yield*` (no async/await mixing).
- `Effect.tap*` used only for side effects.

**Not yet caught by automation (gaps):**
- Single-yield `Effect.gen` collapse to pipe (R0B partial — a few cases
  remain; a lint rule that flags `Effect.gen` blocks containing exactly
  one `yield*` and one `return` would close this).
- Speculative `Effect.suspend` over closed-over-immutable state — there
  is no automated test for "suspend body has no time-varying free
  variables", so case-by-case judgement is required. (Generally fine
  to err on the side of `Effect.suspend`; the cost is one closure
  allocation per call.)
- Forbidden `Effect.try` over functions that already return Effects —
  no rule today; could be a semgrep pattern `Effect.try({ try: () =>
  $FN(...) })` flagged when `$FN` resolves to `Effect`-returning.
- Use of the throwing `state-machine.ts` shim from non-shim production
  code (rather than `./schema/state-machine.ts`) — would benefit from
  an `eslint-plugin-import/no-restricted-paths` rule once the shim's
  retirement is on the roadmap.

Overall verdict: Effect-core idioms are solid post-R0B. The remaining
items are minor style-consistency wins and one architectural question
about the choreography re-throw — none change the runtime shape of any
program.
