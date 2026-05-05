# Effect-TS Batching & Caching Review — Firegrid

Date: 2026-05-05
Reviewer: Effect-TS batching-caching skill pass
Scope: `packages/substrate/src`, `packages/client/src`, `packages/runtime/src` production code (lab and `__tests__` skipped).
Baseline: post R0-R-STRICT-BASELINE; R1 introduced `acquireSubstrateDb`; R4 introduced `buildProjectionCore` but did NOT propagate it to the carry-forward per-call rebuild sites.

## Summary

Firegrid has **zero** usages of `Effect.cached`, `Effect.cachedWithTTL`, `Cache`, `Request`, or `RequestResolver` across the entire production codebase (verified by ripgrep). All read paths re-derive state from the durable stream, with `acquireSubstrateDb` (in `packages/substrate/src/stream.ts:67`) being the only structural mitigation in long-running fibers. This is a deliberate post-R1 posture for runtime hot paths, but it leaves three classes of one-shot snapshot/retained-records readers paying full O(stream) cost on every invocation — these are the highest-leverage candidates for adoption.

This review identifies seven candidates ranked by leverage. The substrate's "first-valid-terminal authority" semantics (as documented in `claim-and-operator-authority.OPERATOR_INVOCATION.15` and `choreography-facade.SUSPENSION.1`) constrain *where* caching is safe: pre/post-handler reads in the operator and choreography facade exist precisely to detect concurrent terminal races, so any TTL caching there would silently break correctness. The recommended adoption is `Effect.cached` (per-fiber-scope memoization within a single operation handler tick) and `Request`/`RequestResolver` (cross-tool batching within one handler), with `Effect.cachedWithTTL` reserved for the `client.work` snapshot path where read-after-write is the documented contract but cross-snapshot freshness is bounded by client expectation.

## Findings

### 1. `Effect.cachedWithTTL` opportunity — substrate `rebuildProjection` per-call sites

Three sites still rebuild the entire projection per call, all carried as A4 in the original review and explicitly punted to R4:

- `packages/substrate/src/waits.ts:139` — `findExisting` rebuilds for every `awakeable()` / `awakeableGlobal()` idempotency lookup.
- `packages/substrate/src/producer.ts:159` — `loadCurrent` rebuilds for every `resolveCompletion` / `rejectCompletion` / `cancelCompletion`.
- `packages/client/src/client/work.ts:123` — `snapshotEffect` rebuilds for every `client.work.observe(workId).snapshot()`.

Each call opens a `StreamDB`, calls `db.preload()` to the no-gap boundary, builds a typed snapshot, and closes — work that grows linearly with stream length. Under a hot path with N awakeables / N completions in a single operation handler tick, this is O(N · stream).

**Tradeoff — read-after-write semantics**: `client/work.ts:78-82` documents the explicit contract that snapshot reads see writes performed immediately before. A `Effect.cachedWithTTL(rebuild, "1 second")` would break that contract. However:

- **`waits.ts findExisting`** is an *idempotency lookup* — by definition, the caller is asking "has this awakeable key been recorded *previously*?", so a slightly-stale read is acceptable IF the cache is invalidated immediately after each `append()` of a pending completion event. The append site is local (`waits.ts:160`), so an `Effect.cachedInvalidateWithTTL` paired with a post-append invalidate is structurally clean and preserves first-write-wins semantics.
- **`producer.ts loadCurrent`** is a *terminal transition* — the state machine (`buildResolveCompletion` etc.) rejects illegal `from` states, so a stale snapshot would surface as `IllegalCompletionTransition`. Caching here is safe in steady state but increases noisy rejections under contention. **Not recommended** for TTL caching; recommended for `Effect.cached` per-fiber scope so a single operation handler that issues multiple completions on the same run pays the rebuild once.
- **`client/work.ts snapshotEffect`** is the most defensible TTL candidate: callers drive read-after-write via `until` (which uses the live Projection facade); `snapshot()` is documented as a one-shot point-read. A 200-500ms TTL would coalesce burst-polling without breaking the existing contract — but the contract says "fresh", so any TTL would need an explicit doc/feature flag change.

**Recommendation**: prefer `Effect.cached` (per-fiber, per-operation-tick) over `cachedWithTTL` for all three. This eliminates within-tick redundancy without introducing time-based staleness — the safer foothold for first-valid-terminal authority.

### 2. `Effect.cached` opportunity — `readJsonItems` per-handler

`packages/substrate/src/retained-records.ts:25` opens a fresh `live: false, offset: "-1"` session per call. It is consumed by:

- `readRetainedClaimAttempts` (called from `internal-claim.ts:73` in `attemptClaim`).
- `readRetainedRunRecords` (called from `readAuthoritativeRun`).
- `readAuthoritativeRun` (called from `operator.ts:134` and `:153`, `choreography/tools.ts:112` and `:154`, `choreography/service.ts:156` and `:221`).

A single `processReadyWorkItem` invocation (`operator.ts:102`) issues at minimum:
1. `attemptClaim` → 1 retained-stream read (claim attempts).
2. `readAuthoritativeRun` pre-handler → 1 retained-stream read (run records).
3. `readAuthoritativeRun` post-handler → 1 retained-stream read (run records).

That's 3 full-stream reads per ready work item. If the handler invokes choreography tools (e.g., `wrapSuspending` in `choreography/tools.ts:140`), each tool adds 1 pre-call read plus the choreography service `blockAndSuspend` adds 2 more (lines 156 and 221 of `choreography/service.ts`) — so a single suspending tool call is 3 retained-stream reads on top of the baseline.

**Recommendation**: introduce a per-fiber-scoped `Effect.cached` over `readJsonItems(streamUrl)` keyed by streamUrl, scoped to the lifetime of one `processReadyWorkItem` invocation (or one operation handler tick). Within that scope, all subsequent reads serve from cache. The cache must NOT outlive the tick: between operator pre- and post-handler reads, a concurrent terminal race is exactly what the post-read is supposed to detect, so the cache must be invalidated (or rebuilt fresh) for the post-handler call.

**Critical correctness boundary**: the operator pre/post-handler pair (`operator.ts:134` and `operator.ts:153`) **must** be excluded from same-fiber cache reuse — these are first-valid-terminal authority verifications and MUST read fresh from the durable stream. Caching here would silently break `OPERATOR_INVOCATION.15`. Practical scoping: cache reads issued *inside* `args.handler` (which may issue many choreography tool calls), but force fresh reads for the operator's own pre/post checks.

### 3. `Request`/`RequestResolver` opportunity — `readAuthoritativeRun` batching across concurrent operations

`readAuthoritativeRun` is called in at least 6 distinct call sites with the same shape `(streamUrl, runId) -> RunValue | undefined`. When the runtime is processing N concurrent `ReadyWorkItem`s on shared streamUrl, each one does its own pre/post `readJsonItems` — that's N×2 full-stream scans even though a single batched read would suffice.

**Pattern**:

```typescript
interface GetAuthoritativeRun extends Request.Request<RunValue | undefined, RetainedReadError> {
  readonly _tag: "GetAuthoritativeRun"
  readonly streamUrl: string
  readonly runId: string
}
```

A `RequestResolver.makeBatched` keyed on `streamUrl` would do one `readJsonItems` per stream and dispatch fold results to all pending requests for distinct runIds. Combined with Effect's automatic request deduplication, this collapses N×2 reads into ~2 reads per batch window.

**Tradeoff — correctness vs. coalescing**: the same first-valid-terminal authority concern from §2 applies. Batching is only safe if all batched callers are reading at the *same* logical "moment" — concretely, if they were going to see the same retained-records snapshot anyway. The pre-handler check and post-handler check must NOT be coalesced (they bracket handler execution in time). This means the resolver scope must be tight: per-fiber, or per-tick, not global.

**Recommendation**: medium leverage. Implement only after §2 (fiber-scoped caching) lands and is validated; the resolver is the cross-fiber generalization of the same idea.

### 4. `Effect.cached` opportunity — choreography tool harness `wrapSuspending`

`packages/substrate/src/choreography/tools.ts:140` (`wrapSuspending`) does a pre-call `readAuthoritativeRun` (`tools.ts:154`). The wrapped `call` (e.g. `choreo.sleep` / `choreo.waitFor` / `choreo.awaitAwakeable`) then internally calls `blockAndSuspend` in `choreography/service.ts:147`, which itself does **two** `readAuthoritativeRun` calls (`service.ts:156` pre-block-write and `service.ts:221` post-block-write verification).

So **a single choreography tool call issues 3 `readAuthoritativeRun` calls**. If an agent invokes 4 tools in a turn, that's 12 full retained-stream reads serializing through the same workId.

**Recommendation**: this is the highest-density N+1 site. Two of the three reads are correctness-required (pre-write check on the started run, post-write verification of blocked state). The first read in `wrapSuspending` is purely a defensive guard against host-cancellation-before-durable-blocking and overlaps semantically with the second-read at `service.ts:156`. **Refactor** would be more impactful than caching: lift the pre-call guard into the choreography service and pass the verified `current` run forward into `blockAndSuspend`, eliminating one of the three reads structurally. After the refactor, the remaining two reads are the durable-write boundary and must stay fresh.

### 5. `Cache` (capacity-bounded LRU) — Schema decoder memoization

`Schema.decodeUnknown(op.input)` / `decodeOutput` / `decodeError` in `packages/client/src/firegrid/operation-client.ts:142,157` and `packages/runtime/src/runtime/internal/operation-handler.ts:77` build a fresh decode `Effect` per call. The `EventStreamValue` decoder in `packages/runtime/src/runtime/internal/event-stream-materializer.ts:123` runs on every materialized record.

Effect's `Schema.decodeUnknown` is reasonably cheap to call but builds a closure each time. For a hot materializer loop emitting thousands of events per second, hoisting the decoder once at descriptor-bind time (i.e., `const decode = Schema.decodeUnknown(descriptor.event)` outside the per-event lambda) is the canonical fix and does not require `Cache`. The current code rebuilds the decoder each time inside `decodeEvent`.

**Recommendation**: not a `Cache` candidate. It's a closure-hoist refactor — out of scope for batching/caching adoption but worth flagging adjacent. `Schema.decodeUnknown` results (per-input value) are NOT a caching candidate because input identity is not a stable cache key.

### 6. EventStream emit/events deduplication

EventStream emits are documented as at-least-once with downstream materializer idempotency. The emit producer at `packages/substrate/src/event-plane/producer.ts:48` accepts `idempotencyKey` as ProducerMetadata but stores it as a header — substrate readers explicitly ignore it (matches `producer.ts:99-101` in the work producer). Caching here would conflict with the at-least-once semantic.

**Recommendation**: explicitly out of scope. No adoption.

### 7. `Request`-based idempotency for client send/call

The original review's L1 finding noted that `idempotencyKey` is plumbed through `client.work.declare` (`client/work.ts:57`) and `WorkProducer.declareWork` (`producer.ts:34,138`) but the *idempotency itself* is not enforced — duplicate sends with the same key produce duplicate run rows. `Request` is a natural fit: requests with `equal()`-equivalent payloads are automatically deduplicated within a single Effect program scope.

**Tradeoff**: `Request` deduplication is per-fiber-scope and in-memory. It does NOT replace durable idempotency (the original review's L1 needs durable-side enforcement at the substrate). However, for a single client process issuing concurrent sends with the same `idempotencyKey`, `Request` would collapse them at the producer boundary cheaply.

**Recommendation**: pair `Request`-based client-side dedupe with a durable-side enforcement plan; do not adopt `Request` alone (it would create a false sense of idempotency).

## Out of Scope

- **Long-running runtime fibers holding `SubstrateStreamDB`**: post-R1, these are explicitly NOT caching candidates — the live db handle IS the cache, and `acquireSubstrateDb` (`stream.ts:67`) is the right Effect pattern (resource-management/Scope) for this case.
- **EventStream materializer emits**: at-least-once contract precludes deduplication caching.
- **Subscriber wake loops**: `subscribers.ts` already follows the `RUNTIME_HOT_PATH.1` posture (long-lived db handle, no per-wake rebuild).
- **Schema decoder memoization**: closure-hoist refactor, not a `Cache` adoption.
- **Cross-process caching**: would require external store (Redis etc.) — Effect `Cache` is process-local.

## Top-5 Adoption Candidates Ranked by Leverage

1. **§4 — Refactor `wrapSuspending` to eliminate the duplicate pre-call `readAuthoritativeRun`**. Highest density: every choreography tool call drops from 3 retained-stream reads to 2. Mechanism: structural refactor (not caching), threading `current` from `wrapSuspending` into `blockAndSuspend`. Risk: localized; does not touch first-valid-terminal authority.
2. **§2 — Per-fiber `Effect.cached` over `readJsonItems` for handler-internal reads**. High frequency, scoped narrowly enough to avoid the operator pre/post-handler correctness boundary. Mechanism: cache scoped to one `args.handler(...)` invocation (NOT to `processReadyWorkItem` as a whole). Risk: medium; requires careful documentation of which call sites bypass the cache.
3. **§1 — Per-fiber `Effect.cached` over `rebuildProjection` at the three carry-forward sites** (`waits.ts:139`, `producer.ts:159`, `client/work.ts:123`). Mechanism: same-tick memoization without TTL. Risk: low for `waits.ts` (idempotency lookup); medium for `producer.ts` (state-machine `from` rejection noise under contention); requires contract change for `client/work.ts`.
4. **§3 — `RequestResolver.makeBatched` for `readAuthoritativeRun`**. Cross-fiber generalization of §2. Mechanism: per-tick batching keyed on `streamUrl`, dispatching by `runId`. Risk: medium; tight scoping required.
5. **§7 — `Request`-based client-side `send` dedupe paired with durable-side idempotency enforcement**. Lower frequency but addresses the L1 finding. Mechanism: `Request.tagged<DeclareWork>` with `idempotencyKey` in the request key. Risk: must NOT be adopted alone — requires substrate-side enforcement in the same change.

## What This Would Unlock

- **§1 + §2 + §3**: single operation handler tick involving N awakeables, N completions, and M choreography tool calls drops from O((N+M) · stream) reads to O(stream) per tick. Concretely, an agent turn with 4 tool calls drops from ~14 retained-stream reads to ~3.
- **§4** (refactor): saves 1 read per choreography tool call unconditionally — independent of cache adoption.
- **§5 / closure-hoist**: removes per-event decoder allocation in the materializer hot path.
- **§7 + durable-side enforcement**: closes the L1 idempotency gap.

The key constraint: every adoption above must respect the substrate's first-valid-terminal authority. The operator's pre/post-handler reads (`operator.ts:134` and `:153`) and the choreography service's pre/post-write reads (`service.ts:156` and `:221`) MUST observe fresh durable state — they are the authority boundaries, not cache candidates. Cache adoption is safe *between* those reads, not *across* them.

A safe foothold for incremental adoption: start with §4 (pure refactor, no caching primitive introduced), then §1.a (`waits.ts findExisting` — the idempotency lookup is the cleanest semantic match for `cachedInvalidateWithTTL` with paired post-append invalidation). Validate before expanding.
