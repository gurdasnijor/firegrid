# effect-durable-streams · maintainer's reference

This is the document a future maintainer should read when picking up
the package cold. It captures architecture, build, perf characteristics,
and the design decisions that aren't obvious from reading the code.

The companion [`BACKLOG.md`](./BACKLOG.md) tracks pending and shipped work
items; this doc explains *why* things are the way they are.

---

## 1. Scope and packages

One package remains intended for independent npm publication (unscoped
name, framed per [`docs/proposals/SDD_FIREGRID_WORKFLOW_REACTOR.md`](../proposals/SDD_FIREGRID_WORKFLOW_REACTOR.md)):

| Package | Purpose |
|---|---|
| `effect-durable-streams` | Protocol client for [Durable Streams](https://github.com/durable-streams/durable-streams). `Stream`-shaped reads, `Sink`-shaped writes, schema-validated decode/encode at the wire boundary, retries, live modes (SSE + long-poll), idempotent batched producer. |

The upstream reference is `@durable-streams/client`. This package is protocol-
compatible — it speaks the same wire format against the same server — but the
surface is Effect-shaped.

State Protocol table semantics are not owned here. Use
`effect-durable-operators` `DurableTable` at the package that owns the rows.
Direct upstream `@durable-streams/state` usage belongs at the DurableTable
implementation boundary, not in runtime/client/app/scenario source.

---

## 2. Package layout

```
packages/effect-durable-streams/
├── src/
│   ├── DurableStream.ts      ← All public type definitions (Bound, Endpoint, ReadOpts, etc.)
│   ├── Bound.ts              ← define() — curried "endpoint + schema" wrapper around Reader + Writer
│   ├── Reader.ts             ← read / collect / snapshotThenFollow / tail / head
│   ├── Writer.ts             ← append / producer / create / close / delete
│   ├── errors.ts             ← All typed error classes (Data.TaggedError) + ReadError/WriteError/ProducerError unions
│   ├── namespace.ts          ← Re-exports under a single `DurableStream.*` namespace
│   ├── index.ts              ← Public entry point
│   ├── protocol/
│   │   ├── constants.ts      ← Wire header / query-param names
│   │   ├── Http.ts           ← The HTTP layer: header resolution, retry classifier, onError hook, request shaping
│   │   ├── Producer.ts       ← Idempotent batched producer (the hot path)
│   │   └── Read.ts           ← catchUpLoop / longPollLoop / sseLoop / readStream / catchUpAll
│   └── internal/
│       ├── schema.ts         ← encodeUnsafe / arrayDecoder helpers
│       └── sse.ts            ← eventsource-parser bridge + reconnect loop
└── test/
    ├── conformance/
    │   ├── smoke.test.ts           ← Basic lifecycle (create/append/collect/snapshot/close)
    │   ├── live.test.ts            ← Long-poll, SSE, snapshotThenFollow, producer, eager-emission, tail()
    │   ├── retry-classification.test.ts ← Retry classifier sweeps + onError contract + per-call headers + 410 → Gone
    │   ├── sse-edge-cases.test.ts  ← SSE parser + reconnect + offset-on-reopen
    │   └── test-server.ts          ← Wraps @durable-streams/server for in-process tests (no Docker)
    ├── unit/
    │   └── types.test.ts           ← expect-type assertions pinning the public type surface
    └── bench/
        ├── harness.ts                       ← startBenchServer + makeEffectRuntime helpers
        ├── one-shot.bench.ts                ← Single append, no batching
        ├── read.bench.ts                    ← HEAD + catch-up read
        ├── read-matrix.bench.ts             ← Catch-up read across 1k/10k/100k item streams
        ├── producer.bench.ts                ← Producer with default config
        ├── producer-matrix.bench.ts         ← Producer matrix (per-iter stream creation — has higher RME)
        ├── producer-matrix-tight.bench.ts   ← TIGHT matrix (pre-created streams, N=2000, RME < 7%)
        ├── snapshot-then-follow.bench.ts    ← snapshotThenFollow
        └── firegrid-payloads.bench.ts       ← Realistic Firegrid event shapes

```

---

## 3. Hot-path architecture (Producer)

The producer is the perf-critical path. Reading `Producer.ts` cold can
miss the layering, so here's the contract:

### 3.1 Queue + drain fiber

```
caller fiber              drain fiber                  HTTP
─────────────┐           ┌──────────────┐           ┌──────────┐
   append    │──offer──▶│   take +      │──POST───▶│  server  │
   append    │──offer──▶│   takeUpTo    │           │          │
   …         │           │   sendOne     │──ack────│          │
─────────────┘           └──────────────┘           └──────────┘
                              │
                              ▼
                          MutableRef state
                          (failure, offered, epoch+lastSeq)
                          SubscriptionRef sent
```

- **`Queue.bounded(maxQueueSize)`** (default 10 000). `append` backpressures on a full queue. Bounded by choice — the original PR #148 used `Queue.unbounded` and could accumulate unbounded work after a downstream stall.
- **Drain fiber** is `Effect.forever(drainOnce)` forked into the producer's scope. Single fiber, sequential sends, no pipelining — pipelining requires per-`(epoch, seq)` state and 409-retry tracking, deferred-by-design (see §10).
- **`MutableRef`** (not `Ref`) for `failure` and `offered` since the append hot path reads them on every event and `Ref.get` costs one microtask per access. `MutableRef.get` is synchronous. `sent` stays a `SubscriptionRef` because `flush` consumes its `.changes` stream.

### 3.2 `append` hot path

PR #155 collapsed the per-event microtask count from 4 to 1. The current shape:

```ts
const append = (event) =>
  Effect.suspend(() => {
    const f = MutableRef.get(failure)                 // sync
    if (Option.isSome(f)) return Effect.fail(f.value) // fast-fail
    return Queue.offer(queue, event).pipe(            // 1 microtask
      Effect.flatMap(() => {
        const f2 = MutableRef.get(failure)            // sync, post-offer recheck
        if (Option.isSome(f2)) return Effect.fail(f2.value)
        MutableRef.increment(offered)                 // sync
        return Effect.void
      }),
    )
  })
```

Net cost: **one microtask per event** (the `Queue.offer`).

**⚠ DO NOT use `Queue.unsafeOffer`.** An interim PR-155 version did, for a fully-sync fast path. `unsafeOffer` does **not** wake suspended takers — combined with `Stream.run`'s per-item yield, this lets the drain race ahead and observe an empty queue between appends, which fires the eager-emission linger path inappropriately. Empirically: `batch=1000, linger=5` regressed from 6× to 9.6×. Keep `Queue.offer` (async, still 1 microtask, wakes the taker).

### 3.3 Eager-emission heuristic

`Stream.groupedWithin(maxBatch, lingerMs)` was the original draining shape (PR #148). It always waits the full `lingerMs` between window opens, even when items are queued. The eager loop replaced it (PR #150):

```ts
const drainOnce = Effect.gen(function* () {
  const first = yield* Queue.take(queue)                // suspend until ≥1 event
  const tail = yield* Queue.takeUpTo(queue, maxBatch - 1) // sync drain whatever's there
  let batch = [first, ...Chunk.toReadonlyArray(tail)]

  const isFull = batch.length >= maxBatch
  const isBurst = batch.length > 1
  // Skip linger when: batch is full OR caught a burst.
  // Linger only fires on TRUE single-event trickle.
  if (!isFull && !isBurst && lingerMs > 0) {
    yield* Effect.sleep(Duration.millis(lingerMs))
    const stragglers = yield* Queue.takeUpTo(queue, maxBatch - 1)
    if (Chunk.size(stragglers) > 0) batch = [...batch, ...Chunk.toReadonlyArray(stragglers)]
  }
  // … failure check, sendOne
})
```

The `isFull` and `isBurst` checks must BOTH be there:
- Without `isFull`, `maxBatch=1` producers always linger (every batch is 1 item).
- Without `isBurst`, a burst that produces a partial batch (< `maxBatch`) lingers unnecessarily.

### 3.4 Terminal-failure semantics

When `sendBatch` fails non-recoverably (the cause is recorded in `failure`):

1. The drain fiber doesn't exit — it keeps reading and **no-ops each batch** (still advancing `sent` so `flush` exits and backpressured `append` fibers wake).
2. New `append` calls fast-fail on `checkFailure` before queue interaction.
3. `flush` sees the failure ref set via the `takeUntilEffect` predicate and exits via the post-loop `checkFailure`.

The shutdown-the-queue alternative was tried and abandoned: `Queue.shutdown` interrupts suspended offerers, which masks the typed failure with an interrupt cause.

### 3.5 maxBatchBytes splitting

`sendOne` measures each event's encoded byte cost (re-encoding through the schema) and splits the count-bounded chunk into sub-batches each within `maxBatchBytes` (default 1 MiB). A single event > cap is sent alone (may exceed cap). Each sub-batch gets its own producer-seq.

### 3.6 Producer error policy

| Server response | Outcome |
|---|---|
| 200 / 204 | Advance `lastSeq`. If `stream-closed: true`, fail with `StreamClosed` (terminal). |
| 403 | If `autoClaim` AND attempts < `maxAutoClaimAttempts` (default 16): bump epoch to `serverEpoch + 1`, retry. Otherwise: typed `StaleEpoch`. |
| 409 | If `stream-closed`: `StreamClosed`. Otherwise: `SequenceGap` (terminal — local `lastSeq` diverged from server's). |
| 404 | `NotFound`. |
| 410 | `Gone` (PR #156 added explicit mapping; previously fell through to `TransportError`). |
| 400 | `Conflict`. |
| 5xx / 429 | Retried via the HTTP-layer retry classifier — caller never sees these unless retries exhaust. |
| Other | `TransportError`. |

Note: `StaleEpoch` and `SequenceGap` are **typed failures**, not defects. This was wrong in the original PR #148 (they were `Effect.die`) and reconciled in #150.

---

## 4. HTTP layer (`protocol/Http.ts`)

### 4.1 Header pipeline

```
endpoint.headers       (resolved per request — function values re-evaluated)
   ⊕  call headers     (per-call overrides; resolved per request)
   ⊕  protocol extras  (e.g., producer-seq, if-none-match, retry-after)
```

Later layers win on collision. The protocol extras layer can override caller headers it needs to set for correctness (e.g., `producer-seq` must reflect the producer's view of the world, not the caller's).

Function-valued headers (`HeaderValue = string | () => string | Promise<string> | Effect<string>`) are resolved inside `executeWithRetry`, so they fire **per HTTP attempt**. This is the contract for auth-token-refresh patterns.

### 4.2 Retry classifier

Pre-PR-#153 only retried `RequestError` (network errors). 5xx and 429 came back as successful HTTP exchanges with bad status, were mapped to `TransportError` *after* the retry layer, and never retried.

Now:

1. Each request wrapped in `Effect.flatMap` that maps retryable statuses (5xx + 429) to a typed `RetryableHttpStatus` failure.
2. `Effect.retry` with `while: isTransient` sees both `RequestError` and `RetryableHttpStatus` as transient.
3. On the final attempt, `Effect.catchTag("DurableStream/RetryableHttpStatus", e => Effect.succeed(e.response))` passes the bad response through to per-op code, which maps status → typed protocol error.

**`Retry-After`** (RFC 7231 §7.1.3) is honored. Both delta-seconds and HTTP-date formats are parsed; HTTP-date is **capped at 1 hour** to defend against hostile servers. The `Retry-After` wait happens **before** the fail-and-retry, so it adds to the schedule's per-step delay rather than overriding it. In practice the schedule's cap (3 s default) is small relative to typical `Retry-After` values.

### 4.3 Default retry schedule

```ts
Schedule.exponential("100 millis").pipe(
  Schedule.either(Schedule.spaced("3 seconds")),  // cap per-step delay at 3 s
  Schedule.intersect(Schedule.recurs(4)),         // limit to 4 retries
)
```

The original PR #148 used `Schedule.compose(recurs)` which selects the **shorter** delay — composing with `recurs` (delay 0) collapsed the entire backoff to 0-delay retries, then `either(spaced)` re-extended forever. The current shape ordering matters: `either` first caps the per-step delay, then `intersect` limits the count.

### 4.4 `onError` hook

Per-endpoint `onError` invoked after transport retries exhaust. Returns `RetryOpts` to retry with merged headers (truthy = retry, void/undefined = propagate). Bounded by `onErrorMaxRetries` (default 4).

The hook receives **all** typed errors after retry exhaust, not just transport — that includes `NotFound`, `Gone`, `Conflict`, etc. Documented behavior. Use case: refresh a signed URL on 403, retry once.

---

## 5. SSE pipeline (`internal/sse.ts`)

### 5.1 Termination contract

The previous shape (PR #148) was `Stream.repeat(forever).takeUntilEffect(closedRef)`. The predicate only fires after an element flows through. A control event that sets the closed flag without producing items wedges the loop into infinite reconnect.

Current shape: a **self-recursive `loop`** that checks `closedRef` between rounds:

```ts
const loop = (): Stream.Stream<...> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const closed = yield* Ref.get(closedRef)
      if (closed) return Stream.empty
      return sseConnection(...).pipe(Stream.concat(Stream.suspend(loop)))
    }),
  )
```

This bug was invisible against the bench server (which always closes with trailing data). Caught when porting the upstream `streamClosed:true` SSE tests.

### 5.2 Reconnect with offset propagation

On byte-stream end **without** `streamClosed: true`, `loop` reopens from `offsetRef.get()`. Control events that arrive mid-connection update `offsetRef` synchronously inside `mapConcatChunkEffect`, so the reconnect picks up from the right place.

### 5.3 Base64 SSE data encoding

Per protocol §5.8, when the server sets `stream-sse-data-encoding: base64`, every data payload is base64-encoded raw bytes (multi-line `data:` lines are concatenated with newlines stripped before decoding). The flag is captured once per connection and threaded through `parseDataPayload`.

### 5.4 What the SSE parser does NOT do

- Unknown event types are **silently ignored** (forward-compat with protocol extensions).
- Invalid control event JSON raises a typed `DecodeError`.
- Empty streams (server returns just a `streamClosed:true` control + nothing else) terminate cleanly via §5.1.

---

## 6. State library (`Store.ts`)

### 6.1 Ordered log

The original PR #148 design had two separate buffers: per-type typed events + a global control log applied **after** all typed events on late registration. This loses ordering: a `reset` between two updates would replay at the end and clear state incorrectly.

Current design: a **single ordered log** (`Array<LogEntry>`) of raw wire entries in arrival order, capped per-kind:
- `maxBufferedEventsPerType` (default 10 000) bounds changes per type, FIFO drop on overflow.
- `maxBufferedControlEvents` (default 1 024) bounds controls, shared across all types.

On `collection({ type, schema })` registration, walk the log replaying `(this type ∪ all controls)` in arrival order — so a `reset` between two updates clears state at the correct position. Asserted by the `state-smoke.test.ts > late registration replay preserves typed/control ordering` test.

Controls stay in the log even after a type registers — a *future* type registration must also see the prior snapshot/reset boundaries.

### 6.2 Schema decode at the value boundary

`dispatchChange` decodes `msg.value` / `msg.old_value` through the **registered collection's schema** before applying — not the top-level wire schema (which is `Schema.Unknown`). Decode failure is captured as a materialization failure observable via `State.failure` / `State.events`.

`writeChange` encodes through the schema **first**; encode failure surfaces as a typed `DecodeError` before the wire write. Collection write error channel is widened to `CollectionWriteFailure = ProducerFailure | DecodeError`.

Late-registration replay decodes buffered raw messages with the registering schema. The pre-#150 design cast `msg.value as V`, which technically compiled but bypassed validation.

### 6.3 Materialization failure surfacing

The materialization fiber's read failure is captured in `Ref<Option<ReadError>>` instead of `catchAll(() => Effect.void)`. Exposed two ways:
- `State.failure: Effect<Option<ReadError>>` for polling.
- `State.events: Stream<...>` is `interruptWhen`-merged with the failure ref so subscribers observe the death rather than silently going idle.

### 6.4 SchemaConflict

Registering a type with a schema that doesn't reference-equal the previously-registered schema fails with `SchemaConflict`. Reference equality is intentional — Effect Schemas with identical structure but different identities should *not* conflict in practice because callers reuse the schema object, but a deep-equal check would be both slow and surprising.

---

## 7. Public API surface

### 7.1 Imports

```ts
import { DurableStream } from "effect-durable-streams"
```

`DurableStream.*` is the namespace re-exported from `namespace.ts`. Includes `define`, `head`, `read`, `collect`, `snapshotThenFollow`, `tail`, `append`, `producer`, `create`, `close`, `delete`, plus error classes and core types.

### 7.2 Curried form (`Bound`)

```ts
const s = DurableStream.define({ endpoint, schema })
yield* s.create({ contentType: "application/json" })
yield* s.append({ n: 42 })
const items = yield* s.collect
const result = yield* s.snapshotThenFollow
const liveStream = yield* s.tail
```

`Bound.head` and `Bound.delete` are direct Effects (not functions) to preserve `yield* s.head` ergonomics. Per-call header overrides on those drop to the function form: `DurableStream.head(endpoint, headers)` / `DurableStream.delete(endpoint, headers)`.

### 7.3 Error taxonomy

```ts
type ReadError      = DecodeError | TransportError | NotFound | Gone
type WriteError     = TransportError | StreamClosed | Conflict | NotFound | Gone
type ProducerError  = StaleEpoch | SequenceGap | TransportError
type ProducerFailure = WriteError | ProducerError
type CollectionWriteFailure = ProducerFailure | DecodeError  // state library
```

All tagged classes via `Data.TaggedError("DurableStream/<Name>")` for `Match.tag` interop.

### 7.4 `live: true` and `tail()`

`read({ live: true })` defaults to `offset: BEGIN` — protocol-correct ("catch up from start, then follow"). For the "subscribe to new events" use case, use `s.tail` (HEAD pins the resume offset, then a live read from there). Documented prominently in `ReadOpts.offset` and `ReadOpts.live`.

---

## 8. Build and test

### 8.1 pnpm scripts (workspace-level)

```
pnpm typecheck                # turbo run typecheck
pnpm test                     # turbo run test
pnpm lint                     # eslint --max-warnings 0 + effect-native-production-cutover-check
pnpm lint:dead                # knip baseline ratchet
pnpm lint:dup                 # jscpd baseline ratchet
pnpm lint:effect-quality      # AST-precise per-pattern metric ratchet
pnpm check:specs              # spec validator
pnpm check:docs               # whitespace + merge-conflict-marker scan
pnpm verify                   # all of the above
```

### 8.2 Per-package

```
pnpm --filter effect-durable-streams typecheck
pnpm --filter effect-durable-streams test
pnpm --filter effect-durable-streams bench   # ONLY effect-durable-streams has bench
```

### 8.3 Quality gates and how they ratchet

| Gate | Baseline file | Bump command |
|---|---|---|
| Dead code | `knip-baseline.json` | `pnpm lint:dead:baseline` |
| Duplication | `.jscpd-report/jscpd-report.json` (threshold in `.jscpd.json`) | `pnpm lint:dup:baseline` |
| Effect-quality | `effect-quality-metrics-baseline.json` | `pnpm lint:effect-quality:baseline` |

**Effect-quality metrics tracked** (AST-precise via ts-morph):
- `extendsErrorCount` — direct `extends Error` (should be 0; use `Data.TaggedError`)
- `processEnvOutsideBinCount` — `process.env` outside `bin/` (should be 0)
- `throwOutsideBinScriptCount`
- `forOfInPackageSourceCount` — for-of loops in package src/ (prefer functional iteration)
- `anyNoContextCastCount`
- `nodeCryptoImportCount`
- `dataTaggedErrorDeclarationCount` (we own one increment from PR #153's `RetryableHttpStatus`)
- `newDurableStreamSiteCount` — direct `new DurableStream(...)` (should be 0; use `DurableStream.define`)
- `perCallLayerProvideSiteCount` — repeated `Layer.provide` calls (should be 0)
- `effectOrDieSiteCount`

The ratchet is **strict**: any regression fails CI. Bumping the baseline is allowed but requires deliberate intent.

### 8.4 Test layout

- `test/conformance/` — talks to the reference `@durable-streams/server` via the in-process test server in `test-server.ts`. No Docker / testcontainers.
- `test/unit/` — type-level + pure-function tests.
- `test/bench/` — `vitest bench` against the same in-process server.

Three benchmark "tiers":
1. **Real-world end-to-end** (`producer-matrix.bench.ts`, `producer.bench.ts`) — per-iter stream creation, higher RMEs, useful for "what does naïve user code measure?".
2. **Tight harness** (`producer-matrix-tight.bench.ts`) — pre-created streams, N=2000, explicit warmup, RMEs < 7%. Use this for perf comparisons across changes.
3. **Synthetic** (`one-shot.bench.ts`, `read.bench.ts`) — focused single-operation throughput.

### 8.5 Mocked-fetch tests

`retry-classification.test.ts` and `sse-edge-cases.test.ts` drive the HTTP layer with `Layer.succeed(FetchHttpClient.Fetch, fakeFetch)` so they can synthesize 5xx / 429 / 410 / SSE bytes / `Retry-After` headers without a real server. Pattern:

```ts
const runtimeWith = (fakeFetch, eff) =>
  Effect.runPromise(
    Effect.scoped(
      eff.pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
      ),
    ),
  )
```

---

## 9. Performance characteristics

Measured on the tight bench (N=2000, RMEs < 7%, two stable runs averaged). Ratios are vs `@durable-streams/client` reference; **lower = we're slower**.

| Cell | Pre-#150 | Post-#150 (eager) | Post-#155 (microtask) | Notes |
|---|---|---|---|---|
| `batch=1, linger=0` | 329× ⚠ | 1.77× | **0.65×** (1.5× faster) | bench-fairness fix (ref had no count cap); we beat ref on per-HTTP-request overhead |
| `batch=1, linger=5` | 355× ⚠ | 2.02× | **0.51×** (~2× faster) | |
| `batch=100, linger=0` | 9.83× | 3.42× | **2.00×** | per-event microtask cost dominant |
| `batch=100, linger=5` | 9.13× | 3.63× | **2.06×** | linger overhead gone after #150 eager emission |
| `batch=1000, linger=0` | 6.99× | 5.31× | **3.37×** | per-event encode + microtask cost |
| `batch=1000, linger=5` | 13.18× | 5.34× | **3.49×** | the original "headline" gap |
| `batch=100000, linger=0` | 6.47× | 5.40× | **4.10×** | residual ≈ Schema.encode per event |
| `batch=100000, linger=5` | 13.83× | 5.19× | **3.74×** | |

### 9.1 Where the residual ~3-4× comes from at large batches

Per-event cost decomposition at `batch=2000-per-batch`:
- Reference: ~0.4 μs/event (mostly array push of a pre-stringified JSON)
- Effect: ~2.5 μs/event = ~0.4 μs (analogous) + ~1.0 μs (`Schema.encode`) + ~1.0 μs (other Effect machinery + JSON.stringify of encoded array)

Closing this further requires either:
- A schema-bypass fast path (`producer.appendEncoded(rawString)`) — breaks the type-safety contract; explicitly deferred.
- `Schema.encode` perf work upstream in Effect — out of scope here.

### 9.2 Where we beat the reference

`batch=1` (one HTTP request per event). Our per-HTTP-request overhead is **lower** than the reference's `IdempotentProducer` machinery. This is why `maxInFlight > 1` pipelining (PR #155-BACKLOG) was de-prioritized: we don't need it.

### 9.3 Things that move bench numbers

- **CPU thermals** — the same M-series Mac can vary 20% between runs depending on background load. The two-stable-runs convention catches this.
- **Stream length per iteration in the non-tight harness** — `producer-matrix.bench.ts` creates a fresh stream per iter; setup variance dominates high-batch cells. Always cross-check with `producer-matrix-tight.bench.ts`.
- **Concurrent vitest processes** — running benches in parallel with other vitest workers (e.g., `pnpm verify`) skews everything. Bench in isolation.

---

## 10. Known pitfalls and landmines

### 10.1 `Queue.unsafeOffer` will break the producer

Don't use it on the append path. See §3.2 for why — `Stream.run` + `unsafeOffer` lets the drain race ahead and triggers the eager-emission linger inappropriately. The empirical regression: `batch=1000, linger=5` from 6× → 9.6×. The current code uses `Queue.offer` (async, 1 microtask, wakes takers).

### 10.2 `Stream.repeat(forever).takeUntilEffect` for SSE termination

Don't reintroduce it. The predicate fires only on emitted elements, so a `streamClosed: true` with no trailing data wedges the loop. Use the self-recursive `loop` in `internal/sse.ts`. See §5.1.

### 10.3 `Schedule.compose(recurs)` collapses delays

Selects the **shorter** delay. Composing with `recurs(n)` (delay 0) zeros the entire backoff. Use `Schedule.intersect(recurs(n))` for "limit retries" (selects the longer delay; recurs has delay 0 so the composite delay stays the exponential).

### 10.4 State library replay must preserve typed/control order

The pre-#150 design buffered typed events and controls separately and applied controls after replay. Don't go back to that — a `reset` between two updates will replay at the end and clear state incorrectly. The single ordered log is the fix.

### 10.5 Schema reference equality, not deep equality, for collection registration

If a caller does `state.collection({ type: "user", schema: User })` and then later `state.collection({ type: "user", schema: { ...User, ...extra } })`, the second call fails with `SchemaConflict`. This is deliberate — deep-equal would be slow and is rarely what callers want. Keep the schema object stable per type.

### 10.6 `WriteError` vs `ProducerError`

`Bound.append` (one-shot) has error channel `WriteError`. `Producer.append` (batched) has `ProducerFailure = WriteError | ProducerError`. Don't pattern-match assuming a one-shot append will produce `StaleEpoch` — that's a producer concept.

### 10.7 `live: true` defaults to BEGIN

Surprising for "subscribe to new events" semantics, but protocol-correct and matches the reference. Use `s.tail` for the ergonomic case. Documented prominently in `ReadOpts`.

### 10.8 Effect-quality ratchet sensitivity

Adding a single `for-of` in package src, a single `Data.TaggedError`, or a single `new DurableStream(...)` will fail CI unless the baseline is bumped. Prefer functional iteration (`Effect.forEach`, `Array.map`, `Chunk.map`) and the curried `DurableStream.define`.

---

## 11. Deferred-by-design items

| Item | Why we stopped pursuing |
|---|---|
| `maxInFlight > 1` pipelining | We already beat reference at `batch=1` (per-HTTP overhead is lower). Pipelining wouldn't help large-batch cells (only 1-2 HTTP requests per iter anyway). Real Firegrid workloads are batched producers. |
| Schema-bypass fast path | Residual ~3-4× at large batches is mostly `Schema.encode`. Bypassing breaks the type-safety contract. |
| `for await...of` async iterable adapter | Effect callers use `Stream.runForEach`. Add if a non-Effect consumer asks. |
| Stream fork operations (`Stream-Forked-From` / `Stream-Fork-Offset`) | Explicitly deferred per SDD. |
| `@tanstack/db` Collection adapter | Reference has it; not requested for Firegrid. |
| `warnIfUsingHttpInBrowser` | Browser-only; we publish a Node library. |
| `DurableStream.connect()` lazy first request | Effect callers defer with `Effect.flatMap`. |
| Producer `onError` callback for fire-and-forget mode | Covered by typed error channel + `failure` Ref. |

---

## 12. P2 features waiting for a consumer

These are real features the reference exposes, intentionally not built yet because no Firegrid workload needs them. If you (the maintainer) get a request, here's the design intent:

| Item | Notes |
|---|---|
| Binary content reads (`Uint8Array` body) | Add a parallel `readBytes` / `collectBytes` typed as bytes. Long-poll path probably translates cleanly; SSE needs the base64-data flag (already wired). |
| `writable()` returning `WritableStream<Uint8Array \| string>` | Wrap the producer in a `WritableStream` so callers can `pipeTo`. |
| `withFetch` convenience | Sugar over `Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, customFetch))))`. Mostly a doc improvement; the swap path already works. |
| `SSEResilienceOptions` | Track consecutive short SSE connections; fall back to long-poll if `>= maxShortConnections` in a row. Useful for misbehaving CDNs. |
| Standard Schema adapter | Accept any [Standard Schema](https://standardschema.dev) (Zod, Valibot, ArkType) by adapting to `effect/Schema` internally. |
| Full upstream conformance suite port | The runtime-behavior layer is already ported (33 cases across `retry-classification.test.ts` + `sse-edge-cases.test.ts`). Remaining upstream tests are API-shape mismatches that don't apply (`subscribe*`, `bodyStream`, `stream-response-state`, etc.) or browser-only (`http-warning`, `visibility`). |

---

## 13. Methodology / instrumentation backlog

Build these when a real signal demands them:

- **SSE + long-poll append-to-observe latency harness**: `tinybench` measures throughput, not per-event p50/p95 latency. A manual loop (`append → observe via Stream.take(1) → record delta`) gives latency distributions.
- **RSS memory snapshots**: `node --expose-gc` + `process.memoryUsage()` at checkpoints. Sentinel for leaks under long-running live reads.

---

## 14. PR history (foundational changes)

| PR | What |
|---|---|
| [#148](https://github.com/gurdasnijor/firegrid/pull/148) | Initial Phase 1 + Phase 2 ship. |
| [#150](https://github.com/gurdasnijor/firegrid/pull/150) | PR #148 review correctness + eager-emit perf. Bounded producer queue, terminal-failure fast-fail, finalizer logging, retry-schedule fix, State materialization-failure surfacing, ordered-log replay, schema decode at boundaries, eager batch emission. |
| [#151](https://github.com/gurdasnijor/firegrid/pull/151) | Cut over production streams to the Effect-native API. |
| [#153](https://github.com/gurdasnijor/firegrid/pull/153) | Conformance hardening: 5xx/429 retry classifier, `Retry-After` parsing, SSE termination bug fix (`streamClosed:true` with no trailing data), `tail()` helper, upstream test ports (retry classification, onError contract, SSE edge cases, catchup→live determinism). |
| [#155](https://github.com/gurdasnijor/firegrid/pull/155) | Append microtask collapse (4 microtasks/event → 1 via `MutableRef`) + tight bench harness. Worst-case bench gap 7× → 4.1×; `batch=1` now ~2× faster than ref. |
| [#156](https://github.com/gurdasnijor/firegrid/pull/156) | DX polish: write paths map 410 → `Gone`, `HeadResult.cursor` exposed, per-call header overrides on `ReadOpts` / `AppendOpts` / `CreateOptions` / `CloseOptions`. |

---

## 15. Quick reference: how to verify a change

For any non-trivial PR touching this package:

```bash
# Per-package quick loop
pnpm --filter effect-durable-streams typecheck
pnpm --filter effect-durable-streams test

# Full quality gates (matches CI)
pnpm typecheck
pnpm lint
pnpm lint:dead
pnpm lint:dup
pnpm lint:effect-quality
pnpm check:specs
pnpm check:docs

# Perf (only when touching the producer/HTTP hot path)
pnpm --filter effect-durable-streams exec vitest bench \
  --run test/bench/producer-matrix-tight.bench.ts
# Run TWICE — bench is noisy; report the range, not a single number.
```

A perf change is "real" only if it's visible in BOTH runs of the tight bench. Single-run results are noise.
