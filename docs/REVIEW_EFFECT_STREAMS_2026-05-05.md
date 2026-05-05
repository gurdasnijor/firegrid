# Firegrid Effect Streams Review — 2026-05-05

Scope: stream **composition, source/transformation patterns, backpressure, and async iteration** in production code under `packages/{runtime,substrate,client}` and `apps/lab`. Tests, scripts, and docs are excluded. This pass complements the concurrency review (fork/scope semantics) and the sinks review (`Stream.run*` consumers, 0 issues) and does not duplicate their findings.

## Summary

The Stream surface in Firegrid is small (≈10 production sites) and idiomatic. There are no `Stream.fromIterable`, `Stream.repeat*`, `Stream.iterate`, `Stream.unfold`, `Stream.fromQueue`, `Stream.fromHub`, or `Stream.fromEffect` uses; every stream is a pull-from-async-source pipeline fed into a transformation chain and either drained (subscriber loops, materializer) or returned to a caller (client `events`/`observe`). The four constructors in use are `Stream.async`, `Stream.asyncScoped`, `Stream.fromAsyncIterable`, and `Stream.unwrapScoped`/`Stream.unwrap`; the transformation primitives are `Stream.map`, `Stream.filter`, `Stream.filterMap`, `Stream.mapEffect`, and `Stream.filterMapEffect`. Pipelines are short (≤5 steps), composable, and free of typical anti-patterns (no nested `flatMap` with concurrency tuning, no producer-style `Stream.async` with default `bufferSize` *and* unbounded fan-out, no `for await` over an Effect Stream).

R-STRICT-BASELINE's extraction of `wakeStream(subscribe)` (`packages/runtime/src/runtime/internal/wake-stream.ts:6-21`) is the right factoring; `bufferSize: 1` + `strategy: "sliding"` matches the edge-coalescing semantics the runtime wants. The materializer's deliberate departure (raw `Stream.async`, not `wakeStream`) is correct — wake streams emit `void`, the materializer carries record payloads. The two `Stream.unwrapScoped` sites in `client/src/firegrid/{event-client,operation-client}.ts` correctly bind resource lifetime to the consumer's scope. The one remaining gap (RawStreamInspector) sits at the React boundary, not inside any Effect Stream pipeline, and is covered by concurrency + resource-management reviews.

## Findings

### F1. `Stream.async` vs `Stream.asyncScoped`

**Three call sites; both choices correct.**

- `packages/runtime/src/runtime/internal/wake-stream.ts:9` — `Stream.asyncScoped<void>` with `Effect.acquireRelease(subscribe → unsubscribe)` and `bufferSize: 1, strategy: "sliding"`. Correct: the `subscribeChanges` registration is a real resource that must be torn down on scope close, so the scoped variant is mandatory.
- `packages/substrate/src/projection-service.ts:54-64` — `Stream.asyncScoped` wraps `Effect.acquireRelease` over the `subscribeChanges` registrations; release runs `subs.forEach(s => s.unsubscribe())`. The `evaluateAndEmit` callback uses `emit.fromEffect(query.evaluate(...))` to thread the user's evaluator into the element pipeline. Textbook `Stream.async*` shape.
- `packages/runtime/src/runtime/internal/event-stream-materializer.ts:145-167` — `Stream.async<unknown, EventStreamSessionError>`. The session is acquired via `Effect.acquireRelease` *outside* the stream (`acquireSession` at `:87-114`); the `Stream.async` only registers/unregisters a `subscribeJson` handler against an already-scoped session. Using `Stream.asyncScoped` here would conflate two lifetimes (session vs subscription). Current shape is correct — outer `Effect.scoped` at `:142` owns the session; inner `Stream.async`'s `Effect.sync(unsubscribe)` torpedoes the handler when the stream finalizes.

**Verdict:** scoped/unscoped split is correct.

### F2. `Stream.fromAsyncIterable`

**One production site, used correctly:** `packages/client/src/firegrid/event-client.ts:147-152`. `Stream.fromAsyncIterable(response.jsonStream(), errorMap)` wraps the durable-streams `AsyncIterable<JsonBatch>` with a typed error transducer (`EventStreamReadError`) — the canonical bridge from the streams skill. The session itself is acquired one layer up via `Effect.acquireRelease` (`:134-144`), so on consumer interrupt the outer `Stream.unwrapScoped` triggers `response.cancel()` and async iteration terminates.

The materializer deliberately uses `Stream.async` over `subscribeJson` instead of `Stream.fromAsyncIterable` over `jsonStream()`. Inline comment at `event-stream-materializer.ts:152-156` is explicit: async-iterable + interrupt does not propagate the cancel signal reliably across the HTTP reader boundary. For the long-lived runtime materializer fiber, the callback-style `subscribeJson` API gives deterministic teardown via a synchronous unsubscribe function. **Cross-reference:** `RawStreamInspector.tsx:49` uses `for await … of session.jsonStream()` directly (no Effect Stream); the leak there comes from not calling `session.cancel()`, not a Stream issue.

### F3. `Stream.unwrapScoped` (resource-lifetime binding to consumer scope)

**Two sites; both correct.**

- `event-client.ts:133-154` — `Stream.unwrapScoped(Effect.acquireRelease(openSession, cancelSession).pipe(Effect.map(response => Stream.fromAsyncIterable(...))))`. When the consumer pulls, the scope opens, the session is acquired, and `cancel()` registers as a finalizer. Consumer interrupt → scope close → `response.cancel()`. Correct.
- `operation-client.ts:283-292` — `Stream.unwrapScoped(Effect.gen(... yield* SubstrateClient ...)).pipe(Stream.provideLayer(SubstrateClientLive(substrateCfg)))`. The scoped resource is the SubstrateClient (`Layer.scoped`, opens a `SubstrateStreamDB`). `Stream.provideLayer` outside `unwrapScoped` is the right ordering. Per-call cost: one StreamDB acquisition per `observe()` invocation, accepted for v1.

### F4. Pipeline composition (`map`, `filter`, `filterMap`, `mapEffect`, `filterMapEffect`)

**Reviewed at four sites; pipelines are short, intent-revealing, free of typical bloat.**

- `event-stream-materializer.ts:168-180` — five-step pipeline: `filterMap(envelopeFromStateRow)` → `filter(isEventStreamEnvelope)` → `filter(stream === descriptor.name)` → `mapEffect(decodeEvent)` → `runForEach(materialize)`. Each step has one concern. The two adjacent `Stream.filter` calls could be fused into one combined predicate, but the split preserves readability ("is this an EventStream envelope?" then "is it MY stream?"). Leave.
- `event-client.ts:158-164` — single `Stream.filterMapEffect`. Two early-out cases return `Option.none()`, the matching case returns `Option.some(decodeEvent(...))`. The implementation uses two `if` statements which the code-style review flags elsewhere; `Match.option` would be more idiomatic but is on the existing style track, not a streams issue.
- `facade/work.ts:104-121` — `Stream.mapEffect(value → Option.some|none)` then `Stream.filterMap(opt => opt)`. Standard filter-by-effect-result idiom. Fusing into `filterMapEffect` would save one step but the explicit two-step shape mirrors the documented "attempt → maybe-keep" semantics.
- `operation-client.ts:290` — single `Stream.mapEffect((run) => mapRunToState(op, run))`. Trivially correct.

**`Stream.tap`/`Stream.scan` candidates?** No `tap` candidates today — runtime loops have no metrics surface (sinks review noted this is the right place when metrics land). No `scan` candidates — no pipeline carries accumulator state across elements. The closest is `LabEventStreamPanel.tsx:62-66`'s React `setEvents` reducer, intentionally outside Effect.

### F5. Backpressure semantics

**`bufferSize` choices are explicit at the one site that matters and default-correct elsewhere.**

- `wakeStream` — `bufferSize: 1, strategy: "sliding"` (`wake-stream.ts:20`). Correct for edge-coalescing: substrate emits a wake per `subscribeChanges` notification, but the consumer always reads the *current* live snapshot. Wakes that arrive while a scan is in flight collapse into exactly one follow-up rescan. This matches the canonical "drop-oldest-keep-latest" use case from the streams skill.
- `projection-service.buildProjectionCore` (`projection-service.ts:54-64`) uses `Stream.asyncScoped` with **default** `bufferSize`. The element type here is the user's evaluator output `A`, not a wake — and the `Projection.until` consumer reads at most until the predicate matches, then runs `Stream.runHead`. For a one-shot wait, the default buffer is fine. For long-running consumers using `Projection.stream(query)`, the default (16) is a reasonable starting point, but if a downstream consumer is slow, queue pressure could build. **Today no production caller uses `Projection.stream` for a long-running consumer** — the runtime substrate uses `wakeStream` directly, and the only `until` site is `operation-client.result` which collects exactly one element. Worth watching, not actionable today.
- `event-stream-materializer` (`event-stream-materializer.ts:145`) — `Stream.async<unknown, EventStreamSessionError>` with default `bufferSize`. The producer is `subscribeJson`, which fires once per server batch and emits N items synchronously via `void emit.single(item)`. If the materializer consumer is faster than the producer (typical case), backpressure is irrelevant. If the consumer is slower (e.g. user `materialize` Effect blocks on I/O), the default buffer can fill and `emit.single` returns a `boolean`-ish "rejected" — but the implementation **discards the return value** (`void emit.single(item)`). This is a latent backpressure gap: a stuck consumer plus a fast producer = silently dropped items. The risk is small in practice (materialize Effects are app code, expected to be fast), but if a future user materializer is genuinely slow, items could be lost without diagnostic. **Improvement candidate.** Either: (a) increase `bufferSize` and document the bound, or (b) use `emit.fromEffect(...)`-style flow control, or (c) bridge through a `Queue.bounded` whose offer is `Effect.suspend`-able. Today's right answer is probably (a) with a comment.

**Verdict:** wakeStream is exemplary; the materializer has a small documented-or-fix-it window. No other site has a backpressure decision worth changing.

### F6. `Stream.merge`, `Stream.concat`, `Stream.zip`

**Zero uses across production code.** Worth examining whether the `runner` would benefit:

`runner.ts:137-167` schedules timer wakes (via `Effect.sleep` + `Effect.fork` inside the `Stream.asyncScoped` acquire callback) and edge wakes (via `input.subscribe(db, wake)`). Both feed a single `wake()` callback registered with the same emit. This is a **manual merge** — two producers, one consumer. A `Stream.merge(timerWakes, edgeWakes)` decomposition would be theoretically cleaner, but it would require:

- A separate `Stream.fromEffect(Effect.sleep(...))` per scheduled deadline, re-issued each scan (the deadline changes per scan based on `nextDeadlineMs`).
- A `Stream.async` for the edge subscription.
- Some form of "switch the timer leg whenever the edge stream produces" — i.e. `Stream.flatMap` semantics with cancel-previous. That's `Stream.switchMap`-shaped, which Effect Stream doesn't expose directly; you'd build it from `Stream.flatMap(stream, { switch: true })`.

The current shape — one `wakeStream`, internal Fiber tracking for the deadline timer — is more compact than the decomposed merge. The concurrency review's observation (§"bare `Effect.fork` for deadline timer" → switch to `Effect.forkScoped`) is a smaller fix that lands the same structural guarantee without introducing two streams. **Recommend: keep the single-stream + internal-timer structure; apply the concurrency review's `forkScoped` fix.**

`Stream.concat` and `Stream.zip` have no current candidates. `Stream.zip` would only matter for join-style flows; Firegrid joins inside `Effect.gen` blocks (e.g. `mapRunToState`'s decode-then-shape) which is correct.

### F7. Channel composition

**Zero `Channel` uses across the codebase.** Effect's `Channel` primitive sits below `Stream` and is warranted when you need bidirectional flow, custom protocol framing, or chunk-aware folding that the `Stream` API doesn't expose. Firegrid has none of these: every stream is a one-way pipe from a subscription source to a consumer, items are processed one at a time (no chunk-fold optimization opportunities), and there is no protocol framing under the durable-streams client (which already presents a parsed `JsonBatch` shape). Reaching for `Channel` here would be premature lowering. **No remediation.**

### F8. Stream cancellation semantics (consumer interrupt → upstream teardown)

**Cross-reference, do not duplicate.** Resource-management review §"Stream cancellation" already enumerates this. The relevant streams-side observation is:

- `wakeStream` finalization: `Stream.asyncScoped` runs the `Effect.acquireRelease` finalizer on consumer interrupt; the user `subscribe` returns a finalizer Effect that runs `unsubscribe`. Verified.
- `Stream.unwrapScoped` (event-client, operation-client): consumer interrupt → outer scope close → `acquireRelease` release → `response.cancel()` / layer finalize. Verified.
- `Stream.fromAsyncIterable` cancellation: depends on the underlying iterator honoring `.return()`. Combined with the explicit `response.cancel()` finalizer registered around the `acquireRelease`, teardown is deterministic for the durable-streams session.
- `RawStreamInspector` (apps/lab): not an Effect Stream — uses raw `for await` over `session.jsonStream()`. The leak is on the React side; a `Stream.fromAsyncIterable` rewrite + `Stream.runForEach` (mirroring `LabEventStreamPanel`) would fix it by inheriting the same cancellation chain. Concurrency review and resource-management review both list this as the headline lab finding; it is the single highest-leverage change in the lab UI.

## Out of scope

- React/`bin` boundaries (covered by concurrency + resource-management).
- Custom Sink construction (sinks review confirmed zero need; no change here).
- `Stream.run*` consumer correctness (sinks review, 0 issues).
- `Effect.fork` vs `Effect.forkScoped` for the deadline fiber inside `runner.ts` (concurrency review §"bare Effect.fork").
- Backpressure on the durable-streams client *below* `Stream.fromAsyncIterable` — that lives in the external `@durable-streams/client` package.

## Top 5 improvements (priority order)

1. **Document or address the materializer `Stream.async` default `bufferSize`** at `packages/runtime/src/runtime/internal/event-stream-materializer.ts:145`. The `void emit.single(item)` discards the back-pressure signal, so a slow `materialize` Effect plus a fast producer can silently drop items. Either size the buffer explicitly with a comment ("bufferSize: 64 — materialize is expected to complete in <100ms; raise if user materialize is heavy"), or migrate to a `Queue.bounded`-based bridge. Cost: small.

2. **Refactor `RawStreamInspector` to use the typed Effect Stream surface** (`apps/lab/src/lab/RawStreamInspector.tsx:36-77`). The current `for await` + `cancelled` flag pattern leaks the durable-streams session on unmount (already filed by concurrency + resource-management). The streams-correct fix mirrors `LabEventStreamPanel`: `Stream.fromAsyncIterable(session.jsonStream(), errorMap)` inside an `Effect.acquireRelease` for the session, run via `Effect.runFork` + `Fiber.interrupt`. Cost: small. CI-enforceable: ESLint rule disallowing `for await` over `DurableStream.stream(...)` results outside the documented bridge pattern.

3. **(Stylistic — coordinate with code-style review)** Replace the inline `if undefined` chain in `event-client.ts:158-163`'s `Stream.filterMapEffect` callback with `Match.option` or `Schema.option`. Not a streams issue per se, but a code-style remediation that intersects this site. Defer to the code-style track.

4. **Add a CI assertion that no production file calls `Stream.async` without explicit `bufferSize`** when the producer fans out items (i.e. emits more than once per acquire). This codifies the F5 finding above; today only the materializer trips it. A simple AST check or grep-based lint over `packages/runtime/src/**` and `packages/substrate/src/**` would suffice.

5. **(Forward-looking, defer)** When the runtime gains a metrics surface, add `Stream.tap` calls before `Stream.runDrain` at `runner.ts:179`, `operation-handler.ts:208`, and `event-stream-materializer.ts:179` to emit per-element counters. Sinks review noted this; reaffirmed here. Today neither is required.

## What strict-baseline enforces vs gaps

**Enforced today:**

- `local/no-fixed-polling` (eslint.config.js:244, 498) — protects the `wakeStream`-vs-`setInterval` distinction. Indirectly streams-relevant.
- `eslint(no-restricted-imports)` blocks substrate state-machine builders from materializer (`event-stream-materializer.ts` file scope) — keeps the materializer read-only.
- `Effect.tapErrorCause(Cause.isInterruptedOnly ? Effect.void : logError)` is present at all three drain sites; this is a code-pattern enforced by review, not by lint.

**Gaps strict-baseline could add:**

- Lint rule: `Stream.async` / `Stream.asyncScoped` must specify `bufferSize` when the producer can emit ≥2 items between consumer pulls. Closes F5.
- Lint rule: `for await` over a value typed as `AsyncIterable` from `@durable-streams/client` is forbidden outside an explicit Effect bridge. Closes F8 (RawStreamInspector).
- Lint rule: `Stream.fromAsyncIterable` requires a typed error mapper (no `() => unknown`). Already true today by usage convention; codify.
- AST rule: `Stream.asyncScoped` callback must return `Effect.acquireRelease(...)` (or a value that has been built that way). Today this is convention; making it structural would prevent regressions where someone writes `Stream.asyncScoped` but forgets the bracket pattern, getting a leak.

**Gaps strict-baseline cannot directly enforce** (require human review or design discipline):

- Choice of `Stream.async` vs `Stream.asyncScoped` based on whether the subscription is a real resource. F1 documents the right call at each site, but it is a judgment, not a syntactic invariant.
- Choice of `Stream.merge` vs internal-fiber multiplexing (F6) — design-level, not lint-level.
- Backpressure budget per Stream (F5) — requires understanding the relative throughput of producer and consumer, which is a runtime property, not static.

## Closing note

Firegrid's stream surface is small and disciplined. Every constructor choice (`async` vs `asyncScoped` vs `unwrapScoped` vs `fromAsyncIterable`) is correct for the resource shape it wraps; every transformation pipeline is short, intent-revealing, and uses the right primitive (`filterMapEffect` not `filter` + `mapEffect` + `filter`); the one explicit backpressure site (`wakeStream`) uses the canonical `bufferSize: 1, strategy: "sliding"` for edge-coalescing. The single substantive streams-side improvement is the materializer buffer-size question; everything else is either out of scope (React/lab, covered elsewhere) or forward-looking (metrics, claim-arbitration parallelism). Post-R-STRICT-BASELINE, this dimension of the codebase is in good shape.
