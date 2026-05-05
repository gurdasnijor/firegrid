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

**`bufferSize` choices are explicit at the one site that matters; default elsewhere with one latent gap.**

- `wakeStream` (`wake-stream.ts:20`) — `bufferSize: 1, strategy: "sliding"`. Correct for edge-coalescing: substrate emits a wake per `subscribeChanges` notification, the consumer reads the current live snapshot; wakes during in-flight scan collapse to one follow-up. Canonical drop-oldest-keep-latest.
- `projection-service.ts:54-64` — default `bufferSize`. Element type is evaluator output `A`. `Projection.until` reads via `runHead` (one element). No production caller uses `Projection.stream` for a long-running consumer; the runtime uses `wakeStream` directly. Worth watching, not actionable today.
- **Latent gap:** `event-stream-materializer.ts:145` — `Stream.async<unknown, EventStreamSessionError>` with default `bufferSize`. The `subscribeJson` producer fires once per server batch and emits N items synchronously via `void emit.single(item)` — **the boolean return is discarded**. If a user `materialize` Effect is slow, the buffer can fill and items are silently dropped. Risk is small in practice (materialize is app code, expected to be fast) but worth either sizing the buffer with a documented bound or bridging through `Queue.bounded` with `Effect.suspend`-able offer.

**Verdict:** wakeStream exemplary; materializer has a document-or-fix window.

### F6. `Stream.merge`, `Stream.concat`, `Stream.zip`

**Zero uses across production code.** The interesting candidate is the runner: `runner.ts:137-167` is a manual merge — timer wakes (via `Effect.sleep` + `Effect.fork`) and edge wakes (via `input.subscribe(db, wake)`) both feed a single `wake()` callback. A `Stream.merge(timerWakes, edgeWakes)` decomposition would require a separately-issued `Stream.fromEffect(Effect.sleep(...))` per scan (deadline changes per scan), a `Stream.async` for the edge subscription, and `Stream.flatMap(stream, { switch: true })` semantics to swap the timer leg. The current shape (one `wakeStream` + internal Fiber for the timer) is more compact. The concurrency review's `Effect.fork → Effect.forkScoped` fix at `runner.ts:155` lands the same structural guarantee with less surgery. **Recommend: keep the single-stream + internal-timer structure.**

`Stream.concat`/`Stream.zip`: no candidates — Firegrid joins inside `Effect.gen` (e.g. `mapRunToState`'s decode-then-shape), which is correct.

### F7. Channel composition

**Zero `Channel` uses.** `Channel` would be warranted for bidirectional flow, custom protocol framing, or chunk-aware folding. Firegrid has none: every stream is one-way, items are processed one at a time, durable-streams already presents a parsed `JsonBatch` shape. Reaching for `Channel` here would be premature lowering.

### F8. Stream cancellation semantics

Cross-reference resource-management §"Stream cancellation". Streams-side observations:

- `wakeStream` finalization: `Stream.asyncScoped`'s `Effect.acquireRelease` finalizer runs user `unsubscribe` on consumer interrupt. Verified.
- `Stream.unwrapScoped` (event-client, operation-client): consumer interrupt → scope close → `response.cancel()` / layer finalize. Verified.
- `Stream.fromAsyncIterable` cancellation depends on iterator `.return()`; combined with the explicit `response.cancel()` finalizer one layer up, teardown is deterministic.
- `RawStreamInspector` (apps/lab): not an Effect Stream — raw `for await`. The leak is React-side; rewriting to `Stream.fromAsyncIterable` + `Stream.runForEach` (mirroring `LabEventStreamPanel`) would fix it by inheriting the same cancellation chain. Headline lab finding (concurrency + resource-management).

## Out of scope

- React/`bin` boundaries (covered by concurrency + resource-management).
- Custom Sink construction (sinks review confirmed zero need; no change here).
- `Stream.run*` consumer correctness (sinks review, 0 issues).
- `Effect.fork` vs `Effect.forkScoped` for the deadline fiber inside `runner.ts` (concurrency review §"bare Effect.fork").
- Backpressure on the durable-streams client *below* `Stream.fromAsyncIterable` — that lives in the external `@durable-streams/client` package.

## Top 5 improvements (priority order)

1. **Document or fix the materializer `Stream.async` default `bufferSize`** at `event-stream-materializer.ts:145`. `void emit.single(item)` discards back-pressure; a slow `materialize` plus a fast producer silently drops items. Either size the buffer explicitly with a comment, or bridge through `Queue.bounded`. Cost: small.

2. **Refactor `RawStreamInspector` to the typed Effect Stream surface** (`RawStreamInspector.tsx:36-77`). Mirror `LabEventStreamPanel`: `Stream.fromAsyncIterable(session.jsonStream(), errorMap)` inside `Effect.acquireRelease`, run via `Effect.runFork`/`Fiber.interrupt`. CI-enforceable: ESLint rule disallowing `for await` over `DurableStream.stream(...)` outside the documented bridge.

3. **(Style — coordinate with code-style track)** Replace the inline `if undefined` chain in `event-client.ts:158-163`'s `Stream.filterMapEffect` callback with `Match.option`/`Schema.option`.

4. **CI rule: `Stream.async` requires explicit `bufferSize` when the producer fans out** (≥2 items per acquire). Codifies F5; today only the materializer trips it.

5. **(Forward-looking, defer)** When metrics land, add `Stream.tap` before `Stream.runDrain` at `runner.ts:179`, `operation-handler.ts:208`, `event-stream-materializer.ts:179`.

## What strict-baseline enforces vs gaps

**Enforced today:**

- `local/no-fixed-polling` — protects `wakeStream`-vs-`setInterval`. Indirectly streams-relevant.
- `no-restricted-imports` blocks state-machine builders from materializer — keeps materializer read-only.
- `Effect.tapErrorCause(Cause.isInterruptedOnly ? Effect.void : logError)` present at all three drain sites — convention, not lint.

**Gaps strict-baseline could add:**

- `Stream.async`/`asyncScoped` must specify `bufferSize` when producer can emit ≥2 items between consumer pulls (F5).
- `for await` over `AsyncIterable` from `@durable-streams/client` forbidden outside an Effect bridge (F8).
- `Stream.fromAsyncIterable` requires a typed error mapper (already convention).
- `Stream.asyncScoped` callback must return `Effect.acquireRelease(...)` shape — prevents regressions where someone forgets the bracket pattern.

**Gaps strict-baseline cannot enforce** (judgment calls):

- `Stream.async` vs `Stream.asyncScoped` choice depends on whether the subscription is a real resource (F1).
- `Stream.merge` vs internal-fiber multiplexing (F6) — design-level.
- Per-stream backpressure budget (F5) — runtime property, not static.

## Closing

Firegrid's stream surface is small and disciplined. Constructor choices match resource shapes; transformation pipelines are short and use the right primitive (`filterMapEffect` not `filter` + `mapEffect` + `filter`); the one explicit backpressure site uses canonical `bufferSize: 1, strategy: "sliding"` for edge-coalescing. The single substantive streams-side improvement is the materializer buffer-size question; everything else is out of scope (React/lab, covered elsewhere) or forward-looking. Post-R-STRICT-BASELINE this dimension is in good shape.
