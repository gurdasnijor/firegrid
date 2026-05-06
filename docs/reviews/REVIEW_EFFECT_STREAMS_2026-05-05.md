# Firegrid Effect Streams Review — 2026-05-05

Scope: stream **composition, source/transformation patterns, backpressure, and async iteration** in production code under `packages/{runtime,substrate,client}` and `apps/lab`. Tests, scripts, and docs are excluded. This pass complements the concurrency review (fork/scope semantics) and the sinks review (`Stream.run*` consumers, 0 issues) and does not duplicate their findings; cross-references are made explicit.

## Summary

Firegrid's stream surface is small, tight, and almost uniformly idiomatic. There are exactly four `Stream.async*` constructions, two `Stream.unwrapScoped` consumers, one `Stream.fromAsyncIterable`, and a handful of small `Stream.mapEffect` / `Stream.filterMap*` pipelines. The shape is consistent: every long-running follow loop is built on a scoped subscription primitive (DB `subscribeChanges` or DurableStream `subscribeJson`/`stream`), wrapped with `Stream.asyncScoped` or `Stream.unwrapScoped` so the underlying handle is bound to the consumer's scope, and drained with `Stream.runDrain` or `Stream.runForEach` from inside `Effect.forkScoped`. R-STRICT-BASELINE's extraction of `wakeStream(subscribe)` (`packages/runtime/src/runtime/internal/wake-stream.ts:6-21`) is the high-water mark — both `runner.ts` and `operation-handler.ts` consume it identically, and the bufferSize:1 + sliding strategy on the wake source is exactly the right shape for edge-coalescing.

The findings below are mostly observations and small consistency issues, not bug-grade. The two patterns worth flagging are (a) `event-stream-materializer.ts` constructing a one-off `Stream.async` whose error channel is set to `EventStreamSessionError` even though the constructor body never emits one (the type is structurally over-wide), and (b) divergence between `event-stream-materializer.ts` (Stream.async over `subscribeJson` callback) and `event-client.ts` (Stream.fromAsyncIterable over `jsonStream()`) — they consume the same `StreamResponse` via two different bridging primitives. The materializer's choice (subscribeJson) is the more correct one and should be the canonical bridge for both.

There are no places where `Stream.merge`, `Stream.concat`, `Stream.zip`, or low-level `Channel` would meaningfully simplify current code; the wake-stream design (single async source folding edge wakes and timer-driven wakes through one emit channel — see `runner.ts:137-167`) is intentional and avoids cross-stream coordination.

**Quick stats** (production code under `packages/{runtime,substrate,client}` and `apps/lab`, excluding tests/scripts):

- `Stream.asyncScoped` constructions — 2 (`projection-service.ts:54`, `wake-stream.ts:9`)
- `Stream.async` constructions — 1 (`event-stream-materializer.ts:145`)
- `Stream.fromAsyncIterable` — 1 (`event-client.ts:147`)
- `Stream.unwrapScoped` consumers — 2 (`event-client.ts:133`, `operation-client.ts:284`)
- `Stream.mapEffect` sites — 6
- `Stream.filterMap` / `Stream.filterMapEffect` — 3
- `Stream.merge` / `Stream.concat` / `Stream.zip` / raw `Channel` — 0

## Findings

### 1. `Stream.asyncScoped` vs `Stream.async` — choices are correct, with one wrinkle

`Stream.asyncScoped` is used in the two places where the registration callback itself needs an `Effect` scope (so the finalizer composes with the surrounding bracket): `wakeStream` (`wake-stream.ts:9-21`) and `buildProjectionCore.stream` (`projection-service.ts:54-64`). Both wrap an `Effect.acquireRelease` whose acquire returns the unsubscribe handle and whose release runs it; the `emit.fromEffect` / `emit.single` callback is closed over the live db handle. That is the canonical shape from the streams skill, and it integrates cleanly with the surrounding `Effect.scoped` blocks in `runner.ts:130-187` and `operation-handler.ts:113-219`.

`Stream.async` (no scope) is used once, in `event-stream-materializer.ts:145-167`. That site already lives **inside** an `Effect.scoped` block where the `StreamResponse` was acquired with `Effect.acquireRelease`, so the response itself is scope-bound. The `Stream.async` body subscribes via `response.subscribeJson(handler)` and returns a finalizer of `Effect.sync(() => unsubscribe())`. This is fine — the response cancel is independently scope-bound — but it relies on a subtle two-step teardown: stream interruption fires `unsubscribe` first; only later does the surrounding scope finalize and run `response.cancel()`. The comment at lines 152-156 documents the choice. **Recommendation**: this could equivalently be `Stream.asyncScoped` collapsing both finalizers into one acquireRelease, but the current shape is not wrong.

### 2. `Stream.fromAsyncIterable` — correct, but inconsistent with the materializer

`event-client.ts:130-154` builds the raw EventStream follow source as:

```ts
Stream.unwrapScoped(
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => durable.stream<unknown>({ offset: "-1", live: true }), ... }),
    (response) => Effect.sync(() => response.cancel()),
  ).pipe(Effect.map((response) =>
    Stream.fromAsyncIterable(response.jsonStream(), (cause) => new EventStreamReadError({ ... })),
  )),
)
```

The shape is correct: `unwrapScoped` flattens the `Effect<Stream, …, Scope>` so that the StreamResponse's lifetime is bound to the consumer's scope (interrupting the consumer triggers `response.cancel()`). And `fromAsyncIterable` is the canonical bridge for an `AsyncIterable<JsonBatch>`.

The wrinkle is that `event-stream-materializer.ts:145-167` does the **same job** — bridging a `StreamResponse` into an Effect Stream — but uses `Stream.async` over `response.subscribeJson(handler)` instead of `fromAsyncIterable` over `response.jsonStream()`. The materializer comment (lines 150-156) explains why: the `subscribeJson` unsubscribe terminates iteration deterministically, whereas async-iterable + interrupt does not propagate the cancel signal reliably across the HTTP reader. If that comment is accurate, then the **client side has the same problem** — `event-client.ts:133-154` may not propagate consumer interrupts to the `jsonStream()` iterator, only to the outer `acquireRelease` scope (which does run `response.cancel()` on close). In practice, scope finalization fires `response.cancel()` and the client's `jsonStream()` should observe the cancel — but the materializer's distrust of async-iterable cancellation applies symmetrically here. **Recommendation**: pick one bridging primitive; if `subscribeJson` is safer, `event-client.ts` should adopt the same shape.

### 3. `Stream.unwrapScoped` — both uses correct

`event-client.ts:133` and `operation-client.ts:284` both use `Stream.unwrapScoped` to lift an `Effect<Stream, …, Scope>` into a `Stream` whose first pull acquires the scoped resource and whose final pull / interrupt releases it. The bound resource in the first case is the DurableStream handle; in the second it is a `SubstrateClient` Layer (`Stream.provideLayer(SubstrateClientLive(substrateCfg))` at line 292). Both correctly tie resource lifetime to consumer scope.

The `operation-client.ts:284-292` site does have a separate concern not specific to streams — `SubstrateClientLive` is constructed fresh per-call, so each `observe` opens its own StreamDB (this is the same per-call layer construction issue flagged in the resource-management review §6e and not a streams finding).

### 4. `Stream.map` / `Stream.filter` / `Stream.filterMap*` / `Stream.mapEffect` — clean, idiomatic pipelines

The longest pipeline (`event-stream-materializer.ts:168-180`) chains `filterMap` (envelope decode) → `filter` (envelope shape) → `filter` (descriptor binding) → `mapEffect` (schema decode) → `runForEach`. The two consecutive `Stream.filter` calls could collapse to a single predicate with `&&`, but each line documents one decode-stage invariant. `filterMap` doing `Option.fromNullable(eventStreamEnvelopeFromStateRow(record))` is the right shape.

`event-client.ts:158-163` uses `Stream.filterMapEffect` correctly: early `Option.none()` returns short-circuit before the schema decode runs. `facade/work.ts:103-121` uses `Stream.mapEffect` returning `Option` followed by `Stream.filterMap((opt) => opt)` to drop "lost claim" outcomes — the canonical translation of `Effect<Option<A>>` filtering.

`Stream.tap` and `Stream.scan` are not used. There are no places where `tap` would clean up a pipeline (the existing `mapEffect`-then-discard handles per-element side effects), and `scan` is not a natural fit (none of the pipelines accumulate state across elements; per-wake state lives on the live StreamDB the loop holds open).

### 5. Backpressure — bufferSize:1 + sliding is intentional everywhere it appears

`wakeStream` is the one site with explicit buffer sizing (`{ bufferSize: 1, strategy: "sliding" }`, `wake-stream.ts:20`). That is the correct configuration for a wake-coalescing source: the consumer always re-reads the latest snapshot when it resumes, so older un-consumed wakes are redundant and dropping them is preferable to backpressuring the producer (who is a `db.subscribeChanges` callback that must not block).

The other `Stream.async*` constructions use the default (unbounded) buffer:

- `projection-service.ts:54-64` — `Stream.asyncScoped` over `subscribeChanges` callbacks. Default buffering is reasonable; `Projection.stream` is documented as observing every change. `until` callers using `runHead` after a predicate filter would not be affected by a sliding strategy.

- `event-stream-materializer.ts:145-167` — `Stream.async` over `subscribeJson` batches. Events must be delivered in order, so coalescing is wrong. But the consumer's `runForEach` runs the user `materialize` Effect sequentially, so a slow materializer could let the unbounded buffer grow without bound. `subscribeJson` is documented as backpressure-aware (comment at line 151). **Recommendation**: confirm that the `subscribeJson` emit-loop can actually suspend, and if not, add an explicit bounded buffer.

### 6. `Stream.merge` / `Stream.concat` / `Stream.zip` — none used, no place obviously needs them

The closest candidate is `runner.ts:137-167`, which folds **two distinct wake sources** (DB `subscribeChanges` edge wakes + scheduled deadline wakes) into a single `Stream.async` emit channel by calling `wake()` from both the `subscribe` callback and the `scheduleDeadline` fiber's `Effect.sleep`-then-tap. A `Stream.merge` of an edge-wake stream and a deadline-wake stream would be a more declarative shape, but:

1. The deadline fiber's lifetime is intricately tied to the loop — it is forked, captured in a closure variable, and interrupted from `clearDeadline()` and the scope finalizer. Lifting this into a `Stream` of deadlines would force re-modeling deadline cancellation through stream interruption.
2. Both sources emit the same `void` payload and the consumer treats them identically, so merge would not yield richer information.

The current shape is concise (~30 lines) and the comment block at lines 21-52 explains it. **No change recommended** — but if a future iteration adds heterogeneous wake sources (e.g. external triggers carrying payloads), `Stream.merge` over typed sources would be the natural refactor target.

### 7. Channel composition — not warranted

Effect's `Channel` is the underlying primitive that `Stream` and `Sink` are built on; it is appropriate when you need bidirectional flow, custom chunking strategies, or to interleave output with explicit control signals. None of Firegrid's stream surface needs that — every stream is a unidirectional follow with simple per-element transformations. Dropping to `Channel` would be a regression in readability for zero benefit.

### 8. Stream cancellation semantics — correct end-to-end

The fork-scope analysis is fully covered in the concurrency review; from the streams perspective, the chain is:

1. Consumer's surrounding `Effect.scoped` finalizes (e.g. layer release).
2. `Stream.runDrain` / `runForEach` is interrupted; the `Stream.async*` constructor's finalizer Effect fires.
3. The finalizer unsubscribes from `subscribeChanges` / `subscribeJson` / cancels the StreamResponse.
4. For `Stream.unwrapScoped` sources, the bound `Effect.acquireRelease` release also fires (a separate path from the inner finalizer — which is why `event-stream-materializer.ts` ends up with two finalizers, each correct).

There is one cross-reference to the resource-management review §RawStreamInspector: the React component at `apps/lab/src/lab/RawStreamInspector.tsx:36-77` uses raw `for await … of session.jsonStream()` rather than an Effect Stream, which is intentional (React boundary). That path's cancel story relies on the `cancelled` flag closing the loop and the `useEffect` cleanup; it does **not** call `session.cancel()`. The resource-management review covers this. From the streams perspective, this confirms why the materializer's choice of `subscribeJson` over `jsonStream()` matters: the durable-streams client's async-iterable does not appear to surface cancellation cleanly, so anything serious should not rely on it.

### 9. `Stream.runFold` vs `runForEach` + `Ref` — currently a non-issue

No `Stream.runFold` calls exist in production, and no `Ref`-backed accumulators are driven by a stream consumer. If a future consumer needs to fold across a stream, `Stream.runFold` is the correct primitive over `runForEach` + `Ref.update` where atomicity does not matter.

## Out of scope

Deferred to other reviews (and not duplicated here):

- `Stream.runDrain` / `Stream.runForEach` / `Stream.runHead` consumer correctness — covered by sinks review (0 issues).
- `Effect.forkScoped` placement around stream drains, deadline fiber lifecycle, scope nesting — covered by concurrency review.
- `acquireRelease` choices around DurableStream construction, per-call layer construction in `operation-client.ts` — covered by resource-management review.
- The React `for-await` pattern in `RawStreamInspector.tsx` — intentionally non-Effect; covered by resource-management review.
- Schema decode error channel structure (the `Schema.Schema.AnyNoContext` casts) — orthogonal to stream composition.

## Top 5 improvements

1. **Unify the StreamResponse → Stream bridge.** `event-client.ts:133-154` (Stream.fromAsyncIterable over `jsonStream()`) and `event-stream-materializer.ts:145-167` (Stream.async over `subscribeJson`) do the same job two ways. The materializer's comment claims the subscribeJson path is more cancel-safe; if true, the client should adopt the same shape. Extract a shared `streamFromDurableResponse(response)` helper. (~20 LOC; medium impact, touches both runtime and client.)

2. **Add an explicit bounded buffer to the materializer's `Stream.async`** at `event-stream-materializer.ts:145-167`, or document why the default unbounded buffer is acceptable given subscribeJson's backpressure behavior. A slow user `materialize` Effect against a high-throughput stream is the realistic failure mode. (~5 LOC; low impact, defensive.)

3. **Tighten the materializer's `Stream.async` error type.** It is parameterized as `Stream.async<unknown, EventStreamSessionError>` (`event-stream-materializer.ts:145`), but the constructor body never emits that error — session errors come from `acquireSession` which has already run. Use `Stream.async<unknown, never>` to make the contract honest. (~1 LOC; trivial; clarifies the type.)

4. **Collapse the two consecutive `Stream.filter` calls** at `event-stream-materializer.ts:172-175` into a single predicate. Minor readability tradeoff — current form documents two invariants, one filter would compose them. (~3 LOC; trivial; style choice.)

5. **Consider `bufferSize: 1, strategy: "sliding"` on `projection-service.ts:54-64` for `until`-only consumers.** Currently every `subscribeChanges` notification triggers `evaluate` and emits; a `until` caller using `runHead` only needs the latest evaluation. As `Projection.stream` is also a public consumer surface, this would need a separate variant or an option flag. (~10 LOC; small impact; only worth it if `until` is hot.)

## What strict-baseline enforces vs gaps

**Enforced by R-STRICT-BASELINE / current ESLint posture:**

- All `Stream.async*` constructors return finalizer Effects (the code-review checklist for `wake-stream.ts` extraction makes this explicit).
- All long-running stream consumers run inside `Effect.forkScoped` under a `Layer.scopedDiscard` or `Effect.scoped` block (concurrency review confirms).
- `Stream.unwrapScoped` is preferred over manual `Effect.flatMap(Stream.fromIterable…)` for resource-bound streams.
- `Stream.run*` consumers always live inside an Effect (no top-level `Stream.runPromise`); sinks review confirms 0 issues.

**Gaps not enforced (these are stylistic, not correctness):**

- No rule enforces a single canonical bridge from `StreamResponse` to `Stream` (improvement #1).
- No rule on explicit buffer sizing for `Stream.async` (improvement #2). Default unbounded buffering is the silent default.
- Error-channel widening on `Stream.async` is not lint-checked; hand-tightening is the only path (improvement #3).
- No rule discourages multiple consecutive `Stream.filter` over `&&` composition (improvement #4) — and reasonably so; this is stylistic.

Overall, the streams surface in Firegrid is in good shape. The findings above are refinements, not corrections.
