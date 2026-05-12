# effect-durable-streams · backlog

Running punch list for `effect-durable-streams` and
`effect-durable-streams-state`. Tracks every divergence from
`@durable-streams/client` + `@durable-streams/state`, every review
follow-up, every perf opportunity.

Update as items land. Keep the priority column honest.

**Legend**

- **Priority:** P0 (correctness / blocks Firegrid use), P1 (parity / outsized
  perf), P2 (DX / parity nice-to-have), P3 (out of scope, document why)
- **Effort:** S = under a day, M = 1–2 days, L = multi-day
- **Status:** ⬜ open · 🟡 in progress · ✅ done · ⏸ deferred

---

## P0 — correctness & critical behavior

| Item | Effort | Status | Notes |
|---|---|---|---|
| Bounded autoClaim epoch bumps | S | ✅ | `maxAutoClaimAttempts` (default 16) caps consecutive 403 retries. On exhaustion the producer surfaces `StaleEpoch` with the last-seen server epoch. Test in `live.test.ts` exercises `maxAutoClaimAttempts: 0`. |
| `State.collection` buffer cap | S | ✅ | `maxBufferedEventsPerType` (default 10_000) caps per-type changes; `maxBufferedControlEvents` (default 1_024) caps shared controls. FIFO drop on overflow; one warning per type / one for controls. Test in `state-smoke.test.ts`. |
| Schema decode failure mid-stream → typed `ReadError` | ✅ | ✅ | Already done in PR #148 review pass. Captured here for the audit. |
| `snapshotThenFollow` no-gap, no-duplicate | ✅ | ✅ | Already done. Regression test under concurrent appends in `live.test.ts`. |
| SSE bridge lifecycle-bound (no unmanaged Promise) | ✅ | ✅ | Already done. |
| Producer error policy reconciled | ✅ | ✅ | `StaleEpoch` / `SequenceGap` now typed failures, not defects. |
| State replay race for late-registered collections | ✅ | ✅ | Per-type buffer + shared semaphore. |
| Producer queue bounded + terminal-failure fast-fail | S | ✅ | `maxQueueSize` (default 10_000). `append` backpressures on a full queue, fast-fails after a terminal send failure has been recorded, and re-checks failure after `Queue.offer` so a concurrent failure during a backpressured wait still surfaces. Drain fiber no-ops after failure to release any waiting offers. Test in `live.test.ts` ("Phase 1 producer queue + terminal-failure semantics"). |
| Producer finalizer surfaces flush failure | S | ✅ | Scope finalizer used `catchAll(() => Effect.void)` and silently swallowed `flush` failures. Now `catchAllCause` + `Effect.logWarning` so accidental data loss is at least observable; comment also calls out that explicit `flush` is the durability boundary. |
| State materialization failure not silently swallowed | S | ✅ | `Store.ts` now captures the read/decode fiber's failure in `Ref<Option<ReadError>>` instead of `catchAll(() => Effect.void)`. Exposed as `State.failure` (polling) and the `events` stream is `interruptWhen`-merged with the failure ref so subscribers observe death. Test exercises a decode failure on a registered type. |
| State late-registration replay preserves typed/control ordering | M | ✅ | Replaced two separate buffers (per-type typed + global controls applied AFTER) with a single ordered log of raw wire entries. Per-type drop on overflow for changes; shared cap for controls. On registration, walks the log replaying (this type ∪ all controls) in arrival order — so a `reset` between two updates clears state at the correct position. Test asserts only the post-final-reset entries survive. |
| State collection schema applied at value boundaries | M | ✅ | Reads: `dispatchChange` decodes `msg.value` / `msg.old_value` through the registered collection's schema before applying; decode failure becomes a materialization failure (observable via `State.failure` / `events`). Writes: `writeChange` encodes through the schema first; encode failure short-circuits as a typed `DecodeError`. Late-registration replay decodes buffered raw messages with the registering schema. Collection write error channel widened to `CollectionWriteFailure = ProducerFailure \| DecodeError`. |
| Default HTTP retry schedule shape | S | ✅ | Was `exponential.compose(recurs).either(spaced)` which collapsed delays to 0 (compose selects MIN delay; recurs delay is 0) and then re-extended forever via `either(spaced)`. Now `exponential.either(spaced("3 seconds")).intersect(recurs(4))` — `either` caps the per-step delay (MIN), `intersect` limits the count (continues only while both continue). |
| Retry classifier covers 5xx + 429 + `Retry-After` | S | ✅ | `isTransient` previously only caught `RequestError` (network errors). 5xx and 429 responses landed in `executeWithRetry` as successful Response objects with bad status, fell through to per-op code, and never retried. Fixed by wrapping the request in `Effect.flatMap` that maps retryable statuses to a typed `RetryableHttpStatus` failure, which `Effect.retry` now drives through the schedule. `Retry-After` (delta-seconds and HTTP-date, capped at 1h) is honored pre-fail. Mocked-fetch tests in `retry-classification.test.ts` sweep across 4xx (8 statuses) and 5xx (4 statuses). |
| SSE stream termination on `streamClosed:true` with no trailing data | M | ✅ | Previous shape used `Stream.repeat(forever).takeUntilEffect(closedRef)` — predicate only checked after an element flowed through, so a control event that set `closedRef` without producing items wedged the loop into infinite reconnect. Replaced with a self-recursive `loop` that checks `closedRef` BEFORE each reconnection round. Test in `sse-edge-cases.test.ts` ("completes cleanly on an empty stream that immediately closes"). |
| `tail()` ergonomic helper for new-events-only subscription | S | ✅ | `read({ live: true })` defaults to `BEGIN` (matches reference), which is surprising for "subscribe to new events" semantics. Added `Bound.tail` (HEAD → live read from current end) and prominent docs on `ReadOpts.offset` / `ReadOpts.live` explaining the default. Tests in `live.test.ts` ("tail() observes only events appended AFTER it resolves") and `live.test.ts` ("catchup→live deterministic handoff"). |
| Write paths map 410 → `Gone` | XS | ✅ | `Writer.append` and `Producer.sendBatch` previously fell through to `TransportError` on 410. Added explicit `Gone` mapping at both sites, mirroring the read-side (HEAD/getJson/getStream all already mapped 410). `WriteError` widened to include `Gone`. Tests in `retry-classification.test.ts` cover both read and append. |
| `HeadResult.cursor` exposed (CDN cache busting) | XS | ✅ | Server's `stream-cursor` header was already captured internally for long-poll continuation, never surfaced on `HeadResult`. CDN-aware integrations need it to drive cache invalidation. Added as `HeadResult.cursor: string \| undefined`. |
| Per-call header overrides | S | ✅ | Added `headers?: HeadersRecord` to `ReadOpts` / `CollectOpts` / `AppendOpts` / `CreateOptions` / `CloseOptions`. Merge order in `buildHeaders`: endpoint headers ⊕ call headers (call wins on collision) ⊕ protocol-internal extras (e.g., `producer-seq`, `if-none-match`). Function-valued headers are re-evaluated per request (asserted by long-poll test). `Bound.head` / `Bound.delete` stay as direct Effects to preserve `yield* s.head` ergonomics — per-call overrides on those drop to the function form (`DurableStream.head(endpoint, headers)`). |

## P1 — parity gaps with outsized impact

| Item | Effort | Status | Notes |
|---|---|---|---|
| Concurrent batch pipelining (`maxInFlight > 1`) with per-`(epoch, seq)` tracking + out-of-order 409 retry | M | ⏸ | **De-prioritized.** Per the clean tight bench, our per-HTTP-request overhead is already LOWER than the reference's at `batch=1` (we win by ~1.5-2x). Pipelining would only widen that lead. Real-world Firegrid workloads are batched producers — where this wouldn't help. Revisit if a small-batch high-RTT use case emerges. |
| Append per-event microtask collapse | S | ✅ | Pre-collapse `append` ran an `Effect.gen` with 4 `yield*` hops per event (`checkFailure` → `Queue.offer` → `checkFailure` → `Ref.update`) ≈ ~4 µs of pure Effect overhead per event. New shape: a single `Effect.suspend` with `MutableRef` for `failure`/`offered` (synchronous get/set/increment) and one `Queue.offer` call — net ~1 microtask per event. Note: an interim attempt used `Queue.unsafeOffer` for a fully-sync fast path, but `unsafeOffer` doesn't wake suspended takers and triggered an eager-emission linger race against `Stream.run`'s per-item yield. Kept the async offer to retain the wakeup semantics. **Measured impact (tight bench, N=2000): `batch=1000/linger=5` 6.07x → 3.49x, `batch=100000/linger=5` 6.98x → 3.74x, `batch=100/linger=10` 2.62x → 1.48x. `batch=1` widened from ~1.5x faster to ~2x faster than ref.** |
| Eager batch emission | S | ✅ | Replaced `Stream.groupedWithin(maxBatch, lingerMs)` with an explicit `Queue.take` + `Queue.takeUpTo` loop. After waking on the first event we synchronously drain whatever's queued, then send immediately if the batch is full OR caught a burst (>1 item). Linger only fires for true single-event trickle. Cut the worst-case bench gap from 13.5x → 5.2x — linger=5 rows now match their linger=0 counterparts. Regression test in `live.test.ts` ("eager-emission semantics"). |
| `onError(error) → { headers }` retry hook | M | ✅ | Per-endpoint `onError` invoked after transport retries exhaust. Returns `RetryOpts` to retry with merged headers; bounded by `onErrorMaxRetries` (default 4). Tests in `live.test.ts` cover retry-with-new-headers and the bounded-retry path. *Params merging deferred — Endpoint doesn't carry params today; revisit if needed.* |
| `maxBatchBytes` byte-cap on producer | M | ✅ | `ProducerOptions.maxBatchBytes` (default 1 MiB). `sendOne` pre-measures encoded byte cost and splits the count-bounded chunk into sub-batches each within the cap. Each sub-batch gets its own producer-seq. Test exercises a 32-byte cap with 20 items. |
| Auto-select live mode (SSE for JSON, long-poll for binary) | S | ✅ | `live: true` now picks SSE; `live: "long-poll"` is the opt-in for proxy-unfriendly environments or binary streams. |

## P2 — feature parity, no current Firegrid blocker

| Item | Effort | Status | Notes |
|---|---|---|---|
| Binary content type reads (`Uint8Array` body) | M | ⬜ | I assume JSON. No `bodyStream`/`textStream` equivalent typed as bytes. Add a parallel `readBytes` / `collectBytes` surface. |
| Base64 SSE decoding (`stream-sse-data-encoding: base64`) | S | ✅ | SSE response header inspected once per connection; data payloads base64-decoded (newlines stripped per §5.8) before JSON parse. Binary content reads (typed as `Uint8Array`) are still a separate P2. |
| `Promise<Body>` as `append` argument | S | ⏸ | Effect callers use `Effect.flatMap(promise, append)` — no surface change needed. Documented as the idiomatic pattern; reference's Promise-overload exists because it has no Effect runtime. Deleting from backlog as resolved-by-design. |
| `writable()` returning `WritableStream<Uint8Array \| string>` | M | ⬜ | Streaming upload pattern. Not common in Firegrid today but documented. |
| Producer `restart(epoch)` | S | ✅ | `Producer<A>.restart(epoch)` sets state to `{ epoch, lastSeq: -1 }`. Caller is responsible for picking an epoch strictly greater than the server's. |
| ETag + `If-None-Match` on catch-up reads | M | ✅ | `ReadOpts.ifNoneMatch` is sent on the first catch-up request. 304 short-circuits the stream (completes without emitting). Paired with `HeadResult.etag` for the typical "is anything new since I last looked" loop. |
| `Cache-Control` surfaced on `head()` | S | ✅ | `HeadResult.cacheControl` returned as-is from the server header. Pairs with `etag` for CDN-aware callers. |
| User-tunable `backoffOptions` | S | ✅ | `Endpoint.retrySchedule` accepts any `Effect.Schedule`. Defaults to the existing exponential 100ms × 4 with a 3s cap. |
| User-supplied `fetch` implementation override | S | ⬜ | Reference accepts `opts.fetch`. Document the `Layer.provide(FetchHttpClient.layer)` swap path; potentially add a `withFetch` convenience. |
| `SSEResilienceOptions` (fallback to long-poll on repeated short connections) | M | ⬜ | Reference fallback for misbehaving proxies / CDNs that don't honor SSE flush. Useful in production. |
| `upsert` operation in state library | S | ⬜ | Reference supports it; I have insert/update/delete only. |
| Standalone `MaterializedState` (apply events to a Map, no sync) | S | ✅ | Pure data structure in `effect-durable-streams-state` — `apply(msg)`, `applyBatch(...)`, `applyControl(...)`, `get`/`has`/`size`/`snapshot(type)`. Also `replayFrom(raw, schemas)` for batch replay. |
| Standard Schema input adapter | M | ⬜ | Reference accepts any Standard Schema; mine requires `effect/Schema`. Adapter via `Schema.fromStandardSchema`. |
| Bounded conformance suite parity (port `@durable-streams/client/test`) | M | 🟡 | Ported the runtime-behavior layer: retry classification (4xx-no-retry sweep, 5xx-retry sweep, 429, Retry-After), full `onError` handler contract (7 of 12 cases; remaining 4 are params-related and N/A), and 5 SSE edge cases (data, unknown events, invalid control, empty stream, reconnect-with-offset). Skipped on purpose: `http-warning` / `visibility` (browser-only), `asyncIterableReadableStream` / `stream-api > subscribe*` / `stream-response-state` (different API shape — Effect.Stream replaces them), `fetch.test` (custom fetch is `Layer.provide(FetchHttpClient.layer)`), `headers-params-functions` params half (no params surface). Per-op append/create/delete contract still uses our own smoke + live tests rather than direct upstream port. |
| Public-surface lockdown with `expect-type` | S | ✅ | `test/unit/types.test.ts` pins 8 type-level assertions across read/collect/snapshotThenFollow/append/producer/Producer/HeadResult/Bound. Type-only — no runtime invocations. |

## P3 — deferred / out of scope

| Item | Reason |
|---|---|
| Stream fork operations (`Stream-Forked-From` / `Stream-Fork-Offset`) | Explicitly deferred per SDD. Revisit after consumers ask. |
| `@tanstack/db` Collection adapter | Reference state has it; not requested for Firegrid. Document the bridging shape if a consumer needs it. |
| `for await...of` async iterable adapters | Effect callers use `Stream.runForEach`. Add only if a non-Effect consumer asks. |
| `warnIfUsingHttpInBrowser` | Browser-only; we publish a Node library. Re-evaluate if/when we ship browser builds. |
| `DurableStream.connect()` lazy first request | Effect callers defer with `Effect.flatMap` / `yield*`. No equivalent surface needed. |
| Producer `onError` callback for fire-and-forget mode | Covered by Effect's typed error channel + `failure` Ref. No surface change required. |

## Perf benchmark targets

Baseline from PR #148. Targets are from the SDD; gaps indicate work needed.

| Bench | Current | Target | Gap | Likely fix |
|---|---|---|---|---|
| HEAD round-trip | 1.19x | within 20% | met | — |
| catch-up 1k | 1.98x | within 20% | 1.65x off | schema decode opt-out (P2) |
| catch-up 10k | 1.29x | within 20% | 1.07x off | almost there |
| catch-up 100k | 1.48x | within 20% | 1.23x off | schema decode opt-out (P2) |
| one-shot append | 1.71x | within 30% | 1.31x off | append microtask collapse (P1) |
| snapshotThenFollow 500 | **0.69x** | within 20% | **met (faster)** | — |
| producer N=500 batch=1000 linger=0 | 5.31x | within 30% | 4.05x off | pipelining (P1) + microtask collapse (P1) remain |
| producer N=500 batch=1000 linger=5 | 5.34x | within 30% | 4.08x off | eager-emission closed the linger overhead; remaining is per-batch Effect cost |
| producer N=500 batch=1 linger=0 | 1.77x | within 50% | 1.27x off | per-HTTP-request Effect overhead |
| producer N=500 batch=1 linger=5 | 2.02x | within 50% | 1.52x off | eager emission did NOT regress count-1 producers (heuristic skips linger when batch is full) |
| state replay N=500 | 9.70x | within 30% | 7.46x off | depends on producer + microtask fixes; partly setup-cost |

## Methodology backlog

| Item | Effort | Status | Notes |
|---|---|---|---|
| SSE + long-poll append-to-observe p50/p95 latency harness | M | ⬜ | tinybench measures throughput, not per-event latency. Need a manual loop: append → observe via `Stream.take(1)`, record delta. |
| RSS memory snapshots (retained + live) | M | ⬜ | `node --expose-gc` + `process.memoryUsage()` at checkpoints. Sentinel for leaks under long-running live reads. |

## Tracer-014 migration (separate PR)

| Item | Effort | Status | Notes |
|---|---|---|---|
| Rewire `@firegrid/durable-streams`'s `DurableLog.{append,read,stream,write}Json` over these packages | M | ⬜ | Closes tracer 014's BOUNDARY invariant. Blocks on this PR landing first. |
| Migrate runtime ingress to `DurableLog.streamJson` | M | ⬜ | Tracer 014 scope item. |
| Migrate runtime output writer | M | ⬜ | Tracer 014 scope item. |
| Delete legacy `appendJson` / `readRetainedJson` helpers | S | ⬜ | After ingress + output migrate. |
