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
| `State.collection` buffer cap | S | ✅ | `maxBufferedEventsPerType` (default 10_000) and `maxBufferedControlEvents` (default 1_024) bound the pre-registration buffers. FIFO drop on overflow; one warning per type via `Effect.logWarning`. Test in `state-smoke.test.ts`. |
| Schema decode failure mid-stream → typed `ReadError` | ✅ | ✅ | Already done in PR #148 review pass. Captured here for the audit. |
| `snapshotThenFollow` no-gap, no-duplicate | ✅ | ✅ | Already done. Regression test under concurrent appends in `live.test.ts`. |
| SSE bridge lifecycle-bound (no unmanaged Promise) | ✅ | ✅ | Already done. |
| Producer error policy reconciled | ✅ | ✅ | `StaleEpoch` / `SequenceGap` now typed failures, not defects. |
| State replay race for late-registered collections | ✅ | ✅ | Per-type buffer + shared semaphore. |

## P1 — parity gaps with outsized impact

| Item | Effort | Status | Notes |
|---|---|---|---|
| Concurrent batch pipelining (`maxInFlight > 1`) with per-`(epoch, seq)` tracking + out-of-order 409 retry | M | ⬜ | **Highest perf lever.** Currently capped at `concurrency: 1`. Reference uses `fastq` with `maxInFlight: 5` default and tracks seq completions in a `Map<epoch, Map<seq, { resolved, waiters }>>`. Expected win: 2–5x on producer cells where network roundtrip dominates. Closes the largest behavior gap. |
| Append per-event microtask collapse | S | ⬜ | `append` currently issues `checkFailure` (`Ref.get`) + `Queue.offer` + `Ref.update(offered)` via `Effect.gen` — 3 microtasks per event. Fold into one `Effect.sync` block (semantics don't require yielding between them). Expected win: ~50% on the offer hot path. |
| Eager batch emission via `Queue.takeBetween` | S/M | ⬜ | `groupedWithin(maxBatch, lingerMs)` waits the full `lingerMs` even when many items are already queued. Drain up to `maxBatch` immediately when the queue has items; only wait `lingerMs` when the queue is empty or has a partial batch. Expected win: `lingerMs=5` becomes ~as fast as `lingerMs=0` for bursty workloads. |
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
| Bounded conformance suite parity (port `@durable-streams/client/test`) | M | ⬜ | We have a focused subset; the full corpus is a sentinel against regressions. |
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
| producer N=500 batch=1000 linger=0 | 5.44x | within 30% | 4.18x off | pipelining (P1) + eager batch (P1) + microtask collapse (P1) |
| producer N=500 batch=1 linger=0 | 321x | n/a | pathological config | document as anti-pattern |
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
