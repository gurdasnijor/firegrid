# tf-q1j3 — Durable Streams Effect client (PR #218) vs our `effect-durable-streams` wrapper

**Date:** 2026-06-05
**Class:** sidecar (investigation → ergonomic adoption; no production migration)
**Recommendation:** **KEEP the typed core + ADOPT upstream's ergonomics** (PO direction 2026-06-05, after a design gut-check). We retain `packages/effect-durable-streams`'s `Reader`/`Writer`/`Producer` as the authoritative `Stream<A>`/`Sink<A>` typed core, and ADD a URL-keyed, optional-schema `DurableStreamClient` facade that copies upstream's *surface* ergonomics by delegating to that core — see §14. We did NOT replace internals, copy the global-`fetch` hardwire, the untyped `Error` producer channel, or the dead follow loop.

---

## 0. TL;DR

Upstream PR [durable-streams/durable-streams#218](https://github.com/durable-streams/durable-streams/pull/218) adds a NEW package `@durable-streams/client-effect` (an Effect-flavoured client). It is an **OPEN, single-commit, empty-description PR** that is **less capable and less idiomatic than what we already ship**. The single decisive fact:

> **Upstream's live/follow read is non-functional.** `makeStreamSession` accepts a `_fetchNext` continuation and **never calls it** (the parameter is underscore-prefixed dead). The session emits the **initial HTTP response only** — no long-poll loop, no SSE wiring (the bundled `SSE.ts` parser is never used by the session). The package's own conformance adapter sidesteps this by **re-implementing reads with raw `fetch`**, so the broken path ships unverified.

Our wrapper already has a real, typed, Effect-idiomatic follow loop (`catchUpLoop` / `longPollLoop` / `sseLoop` via `Stream.paginateChunkEffect` / `Stream.unfoldChunkEffect`), a Schema boundary, a Sink-shaped idempotent producer, branded offsets, narrowed typed-error unions, a pluggable `@effect/platform` `HttpClient`, and `close`/`delete`/`tail`/`snapshotThenFollow`/`onError` retry hooks that upstream lacks.

Perf (same server, same effect/platform versions): **append at parity, snapshot read at parity, producer ~5× faster on our side.** No performance reason to adopt upstream either.

**Epistemic tier: source-verified** — every claim below is read directly from PR #218's diff (extracted to per-file sources) and our `packages/effect-durable-streams/src`, plus a runnable microbench against the reference `DurableStreamTestServer`.

---

## 1. Scope & method

- **Upstream sources:** fetched via `gh pr diff 218` and split per-file (PR is +4,748 / −1, 22 files, branch `effect-client-refactor`, base `main`, **state OPEN**, empty body). pkg.pr.new tarball for `@durable-streams/client-effect@218` 404'd at the guessed URL, so the bench **vendors the PR sources verbatim** (they import only `effect` core + global `fetch`, so no extra install / lockfile risk).
- **Our sources:** `packages/effect-durable-streams/src/**` and `docs/effect-durable-streams/**` at worktree base `origin/main`.
- **Perf:** isolated microbench (`bench-q1j3/compare.ts`, not committed — see Appendix B) running both clients in one process against one `DurableStreamTestServer` (`@durable-streams/server@0.3.7`) on identical `effect@3.21` / `@effect/platform@0.96`, so the delta reflects **client design, not version noise.**

---

## 2. API surface parity

| Capability | ours `effect-durable-streams` | upstream `@durable-streams/client-effect` (#218) |
|---|---|---|
| create | `create(opts)` → `void` (+ `closed`, `body`, ttl/expiresAt, per-call headers) | `create(url, opts)` → `CreateResult{offset, contentType}` (no create-closed) |
| head | `head` → rich `HeadResult` (offset, contentType, **streamClosed**, ttl, expiresAt, **etag**, **cacheControl**, **cursor**) | `head(url)` → `{exists, offset, contentType, etag, cacheControl}` (no streamClosed/ttl/cursor) |
| delete | `delete` → typed `NotFound`/`TransportError` | `delete(url)` → typed |
| append (one-shot) | `append(event, {seq, headers})` schema-encoded; returns `{offset}` | `append(url, data, {seq, contentType})`; **requires explicit `content-type` every call** (see §8) |
| read / follow | `read({live,offset,headers})` → `Stream<A, ReadError>`; `collect`; `tail`; `snapshotThenFollow` | `stream(url, {live,offset,json})` → `StreamSession` — **follow is non-functional (§7)** |
| idempotent producer | `producer(opts)` → **`Sink`** + `append`/`flush`/`restart`; bounded backpressure queue, byte+count batching, autoClaim w/ cap, pipelining | `producer(url, id, opts)` → object `append`/`flush`/`close`/`restart`; byte-only batching, autoClaim, **error type = `Error`** (§4) |
| close (terminate stream) | **`close(opts)` → `{finalOffset}`** | **absent** |
| onError / auth-refresh retry hook | **`Endpoint.onError` + `onErrorMaxRetries` + custom `retrySchedule`** | absent (fixed `Schedule.recurs` on 429/5xx only) |
| branded `Offset` | **yes** (`Brand`) | no (`type Offset = string`) |
| Schema boundary | **yes** (`Schema.Schema<A,I>` decode on read / encode on write) | **no** (`JSON.parse`, `T = unknown`) |
| transport | pluggable `@effect/platform` `HttpClient` (provide `FetchHttpClient` or any layer) | **hard-wired global `fetch`** inside its own service |
| fork / subscriptions | not exposed (neither side) | not exposed |

**Net:** upstream is a strict subset minus several capabilities we depend on (close, schema, Sink-producer, onError, branded offset, pluggable transport) — and its headline feature (live read) doesn't work.

---

## 3. Effect idioms vs `repos/effect/AGENTS.md`

`AGENTS.md` is thin (workflow/test conventions: `it.effect`, `assert` not `expect`, zero-tolerance checks). Against broader Effect idiom both packages use `Effect.gen`, `Ref`, `Queue`, `Deferred`, `Stream`, `Schedule`, `Data`/`Schema.TaggedError`. Divergences that matter:

| Idiom | ours | upstream |
|---|---|---|
| Typed error channel | narrowed per-op unions (`ReadError`, `WriteError`, `ProducerError`) | producer surface is **`Effect<…, Error>`** — the entire point of typed errors discarded (`IdempotentProducer.append/flush/close/restart` all `, Error>`); `client.producer` returns `Effect<…, Error>` too |
| Errors-as-defects | follow loop keeps `ReadError` **in the channel** | `stream()`'s `fetchNext` is `Effect.orDie` — would convert live-read transport errors to **defects** (if it were wired at all) |
| Streaming primitives | `Stream.paginateChunkEffect` / `Stream.unfoldChunkEffect` drive the follow loop natively | session uses `Stream.fromEffect(singleBody)` — a one-shot, not a loop |
| Transport composition | requires `HttpClient.HttpClient` in `R` → swappable, traceable, testable | calls global `fetch` directly → not swappable, not traced through platform, `@effect/platform-node` peer dep is **dead weight** (never imported) |
| Mutable state in `Ref` | avoided | `IdempotentProducer` mutates `Map` entries in place inside `Ref.update` (`entry.resolved = true`) and rebuilds `pendingMessages` arrays `O(n)` per append — patterns our effect-quality gate flags |
| Producer as data | `Sink` (composes with `Stream.run`) | bespoke object; to batch you must fork a fiber per message because `append` blocks until sent (§8) |

Ours is materially more idiomatic on the dimensions Effect cares about (typed errors, layer-provided services, native stream combinators).

---

## 4. Error model

- **Ours:** `Data.TaggedError` classes (`DurableStream/*` tags) composed into **narrow operation-specific unions** — `ReadError = Decode|Transport|NotFound|Gone`, `WriteError = Transport|StreamClosed|Conflict|NotFound|Gone`, `ProducerError = StaleEpoch|SequenceGap|Transport`. Callers `catchTag` on exactly what an op can raise.
- **Upstream:** `Schema.TaggedError` classes (nice — serializable) but funneled into one flat `ClientError` 14-member union for most ops, **and the producer abandons typing entirely (`Error`)**. A caller can't exhaustively match a producer failure.
- Upstream's `StreamSession.json()` adds a `ParseError` (good), but ours surfaces a structured `DecodeError{cause, raw}` from Schema with the offending payload — strictly more debuggable, and it actually *validates* shape, not just JSON-parses.

Edge note (potential bug, source-verified): upstream's producer treats HTTP **204 as an error branch** (`error.status === 204` inside `catchAll`), but 204 is a success status that won't arrive as an `HttpError` from its own `HttpClient` (which only fails ≥400). The duplicate-detection path there looks unreachable.

---

## 5. Read / follow streaming behaviour — **the decisive gap**

Source-verified in `StreamSession.ts`:

```ts
export const makeStreamSession = <T>(
  initialResponse: DurableStreamsResponse,
  _fetchNext: (offset, cursor) => Effect.Effect<DurableStreamsResponse>,  // ← never referenced
  options: { live; isJsonMode; startOffset },
) => Effect.gen(function* () {
  ...
  const bodyStream = () => Stream.fromEffect(getCachedBody)  // ← emits ONE chunk (the initial body)
  ...
})
```

- `_fetchNext` is dead. `bodyStream`/`textStream`/`jsonStream`/`jsonBatches`/`body`/`text`/`json` all terminate after the **first** response.
- `SSE.ts` (`parseSSEStream`, `filterDataEvents`, `collectSSE`) is exported but **never imported by the session** — `grep` across `src/` confirms zero call sites outside `index.ts` re-exports.
- Therefore `live: true | "long-poll" | "sse"` is advertised (README §"Live Modes") but **does nothing past the first response**; multi-batch catch-up that spans more than one server response **silently truncates**.
- The package's `test/adapter/effect-adapter.ts` **bypasses the session** and re-implements SSE + non-live reads with its own `fetch`/`buildStreamUrl` (lines ~494–645), so conformance is green while the real surface is unexercised.

Ours, by contrast (`protocol/Read.ts`): three real loops — `catchUpLoop` (paginate to up-to-date, with `If-None-Match`/304 short-circuit), `longPollLoop` (cursor-carrying unfold until stream-closed), `sseLoop` — all typed `Stream<A, ReadError, HttpClient>`, plus `tail` (HEAD-pinned new-events-only) and `snapshotThenFollow` (gap-free handoff). This is the capability Fluent depends on for claimed-wake / follow semantics.

---

## 6. Append / producer / idempotency

Both implement the `(producerId, epoch, seq)` exactly-once protocol with autoClaim-on-403 and sequence-gap-on-409 handling. Differences:

- **Shape:** ours is a `Sink` (pour a `Stream` straight in, compose with the rest of an Effect pipeline) + convenience `append`/`flush`/`restart`. Upstream is an object whose `append` **blocks per message** until that message's batch is sent — batching only happens if the caller concurrently forks appends.
- **Batching bound:** ours = byte cap **and** count cap (`maxBatchSize`, default 1000) with sub-batch splitting; upstream = byte cap only.
- **Backpressure:** ours has a bounded queue (`maxQueueSize`, default 10k) that suspends `append`; upstream uses an **unbounded** `Queue` (no backpressure ceiling).
- **Content type:** ours sends it from the bound schema/stream; upstream's producer issues an **extra HEAD round-trip** to discover content type (cached after first), and its one-shot `append` requires the caller to pass `contentType` every call.
- **autoClaim safety:** ours caps consecutive epoch bumps (`maxAutoClaimAttempts`, default 16) to avoid infinite 403 loops; upstream has no such cap.
- **Error typing:** ours `ProducerFailure = WriteError | ProducerError`; upstream `Error` (§4).

---

## 7. close / fork / subscriptions

- **close (stream termination):** ours has `close()` (POST with `streamClosed`, returns `finalOffset`). **Upstream has none** — only the *producer* has a local `close` (flush + shutdown queue), not stream termination.
- **fork:** neither package exposes stream fork. (Our broader `FluentStore` has fork elsewhere; not in scope here.)
- **subscriptions / pull-wake:** neither exposes a subscription primitive; both model "follow" as a live read — except upstream's live read doesn't loop (§5).

So for the close/fork/subscription axis upstream adds **nothing** and loses `close`.

---

## 8. Conformance test reuse

- Upstream ships a shared `@durable-streams/client-conformance-tests` harness + an `effect-adapter.ts`. The adapter drives create/append/producer **through the client**, but **reads/SSE through its own `fetch`** — so adopting upstream would NOT give us conformance coverage of the Effect read surface (the part that's broken).
- Ours has `test/conformance/*` (smoke, live, classified-producer-append, retry-classification, sse-edge-cases) running against the **same reference `DurableStreamTestServer`** and exercising the **actual public API** including the follow loops.
- **Reusable idea, not code:** the shared command-protocol harness (`protocol.ts` command/response shapes) could be a useful cross-check fixture for our client too — that's the one thing worth borrowing, and it's independent of #218 landing.

---

## 9. Dependency / version compatibility

- Upstream `package.json` peers: `effect ^3.0`, `@effect/platform ^0.70`, **`@effect/platform-node ^0.70`** (the last is never imported — dead). Our repo runs `effect 3.21` / `@effect/platform 0.96`. `^0.70` does **not** semver-satisfy `0.96` (caret pins minor on 0.x) → installing the published package as-is yields peer-range warnings.
- Because upstream's transport is global `fetch`, it **runs** fine on our versions regardless (the bench proves it) — but that's exactly why its platform peers are misleading.
- Upstream is `version 0.0.1`, single PR, OPEN, empty description, one author — **early/unproven**. Ours is wired into `@firegrid/fluent-firegrid` (`effect-durable-streams: workspace:*`) and gated by our CI.

---

## 10. Perf evidence

Microbench, two runs, median ms (lower = better), one shared `DurableStreamTestServer`, identical effect/platform:

| Operation | ours | upstream | verdict |
|---|---:|---:|---|
| 200 sequential single appends (fresh stream/iter) | ~32 ms | ~32 ms | **parity** (HTTP-RTT bound) |
| Idempotent producer: 500 appends + flush | **~3.1 ms** | ~15.7 ms | **ours ~5× faster** |
| Snapshot read 1000 JSON items (`live:false`) | ~1.5 ms | ~1.2 ms | parity (ours pays Schema decode; both returned 1000 ✓) |

Notes / fairness:
- Producer gap is partly upstream's **HEAD round-trip** for content type + partly the **fork-per-message** pattern its blocking `append` forces to achieve batching. Both are real design costs, not artifacts.
- The follow/multi-response read was **not benchmarkable** for upstream — its session doesn't follow (§5). For the single-response snapshot the missing loop didn't bite (server returned all 1000 at once), so the read row is a best-case for upstream.
- No operation favors upstream beyond noise. There is **no perf incentive** to adopt.

Reproducer: `bench-q1j3/compare.ts` (Appendix B) — vendors PR #218 `src/**` and runs `tsx`. Not committed (vendoring upstream into a gated package trips knip/dep-cruiser); re-create from the PR diff to reproduce.

---

## 11. Migration cost (if we hypothetically replaced)

High and net-negative:
1. Re-introduce a **Schema boundary** upstream doesn't have (every Fluent read/write is schema-typed today) — large.
2. Restore a **working follow loop** (port ours into theirs) — i.e. we'd be fixing their bug to reach today's behaviour.
3. Restore **`close`**, **branded `Offset`**, **`onError`/retry hooks**, **Sink producer**, **typed producer errors**, **count-based batching + bounded backpressure**.
4. Swap call sites in `@firegrid/fluent-firegrid` from `DurableStream.define(...)` curried surface to a `Context.Tag` service + `DurableStreamClientLiveNode` layer — different ergonomics, ripples through fluent benches/tests.
5. Accept hard-wired `fetch` (lose pluggable/traced `@effect/platform` transport).

The "migration" is mostly **us re-implementing our own features inside a less-typed shell**. There is no slice where upstream saves us work.

---

## 12. What to keep / delete / adopt

- **KEEP** `packages/effect-durable-streams` and `docs/effect-durable-streams` unchanged. It is strictly ahead of #218 on capability, typing, and (for the producer) speed.
- **DELETE** nothing on our side as a result of this PR.
- **ADOPT (idea only, optional, decoupled from #218):** the shared **conformance command-protocol fixture** as an extra cross-check for our client. Low priority; does not require #218 to merge.
- **DO NOT** add `@durable-streams/client-effect` as a dependency or vendor it into production.

---

## 13. Recommendation — **KEEP**

REPLACE ✗ (upstream is a less-capable subset with a broken core read path).
PARTIAL-ADOPT ✗ (nothing in #218 is both working and better than ours; the one borrowable artifact — conformance fixtures — is not gated on this PR).
WAIT ⟂ (we don't need to wait on anything; ours is already in use). Revisit only if upstream later ships: (a) a **wired follow loop** (calls `fetchNext` / consumes `SSE.ts`), (b) **typed producer errors**, (c) a **Schema boundary**. Until all three land, there's nothing to reconsider.
**KEEP ✓** — retain our wrapper; treat #218 as a positioning reference, not a dependency.

### Concrete next steps
1. **No production change.** Close tf-q1j3 with this doc as the deliverable.
2. (Optional, separate bead) Lift the upstream **conformance command-protocol** shapes into a fixture under `packages/effect-durable-streams/test/conformance/` as an extra cross-check. Independent of #218.
3. If anyone re-raises "should we use the official Effect client?", point here: re-run the bench + re-check the three gating conditions in §13 before reopening.

---

## 14. Ergonomic adoption (IMPLEMENTED 2026-06-05)

Per PO direction — "copy the better ergonomics of the library instead" + a design gut-check (the "schema at the wire" property is kept but made *optional*, not mandatory) — we ported upstream's ergonomic surface as a thin facade over the existing typed core. New code is `packages/effect-durable-streams/src/Client.ts`; everything else is additive.

**Added (delegates to `Reader`/`Writer`/`protocol` — no parallel transport):**
- `DurableStreamClient` — a `Context.Tag` service. Provide one layer, call `client.<op>(url, …)`; methods carry **no `HttpClient` in `R`** (captured by the layer); the producer keeps `Scope`.
- `DurableStreamClientLayerFetch` — batteries-included (bundles `FetchHttpClient`; Node 18+/Bun/Deno/browser). The analog of upstream's `DurableStreamClientLiveNode()`, but the transport stays a swappable `@effect/platform` `HttpClient`. `DurableStreamClientLayer` is the bring-your-own-client variant.
- **Optional schema.** Raw ops skip Schema for quick use — `client.append(url, string | Uint8Array)`, `client.stream(url)` → a lazy `RawStreamSession` with `json` (accumulate `unknown[]`), `jsonStream`, and `jsonBatches` (per-response `{ items, offset, upToDate, cursor }` metadata, backed by a new `protocol/Read.ts#batchStream`). `client.withSchema(schema)` returns the fully typed `TypedClient<A>` (`append`/`read`→`Stream<A>`/`collect`/`snapshotThenFollow`/`tail`/`producer`→`Sink<A>`).
- **Producer accessors** (parity with upstream's object producer, added to the `Producer<A>` interface without weakening `ProducerFailure`): `close` (flush + stop accepting; append-after-close fails typed `TransportError`), `pendingCount`, `epoch`, `nextSeq`.

**Deliberately NOT copied:** global-`fetch` hardwire (kept pluggable `HttpClient`); the untyped `Error` producer channel (ours stays `WriteError | ProducerError`); the dead follow loop (our reads actually follow); `body()`/`text()` raw-byte session accessors (ill-defined over the JSON-array wire — documented on `RawStreamSession`); `cancel()` (interrupt the consuming fiber — idiomatic Effect).

**Verification:** `test/conformance/client-facade.test.ts` (6 tests: raw append + `Uint8Array`, `jsonBatches` metadata, `withSchema` typed round-trip, producer `Stream.run` + accessors + `close`-then-append-fails, typed `NotFound`). Full suite **76/76**. Gates green: tsc, eslint (`--max-warnings 0`), knip, dep-cruiser, jscpd (0 clones), effect-language-service (0 errors), and `@firegrid/fluent-firegrid` (the `workspace:*` consumer) typechecks unchanged — no trap from the service-Tag addition.

### Why keep `DurableStream.define` too? (surface decision — adjudicated)

The facade overlaps `define`, so we explicitly asked: consolidate to one surface (delete `define`) or keep both? Decision: **keep both as intentional siblings** (Agent1 design review, 2026-06-05, source-grounded), driven by two facts:

1. **`define` is not redundant.** It's a tiny `Endpoint + Schema → Bound` builder, and the load-bearing part is the **full `Endpoint`**: `headers`, `params`, `onError` (+ `onErrorMaxRetries`), and `retrySchedule` thread through the entire `Reader`/`Writer` stack. The facade's `endpointOf(url, headers)` drops everything except URL + per-call headers — materially less.
2. **`define` has real production consumers** — `fluent-runtime/src/Store.ts` (×2), `fluent-firegrid/src/durable-journal.ts` (which accepts a caller-supplied `Endpoint`), plus `effect-durable-operators/src/DurableTable.ts`. These are library/runtime layers, not app scripts; forcing the service-Tag idiom onto them would either lose endpoint policy or force the facade to grow a second "bound endpoint" API that just re-creates `define`. Migrating them is also out of tf-q1j3's scope.

Positioning (now reflected in the README): **`define` = primary low-level typed core (library/runtime idiom)**; **`DurableStreamClient` = optional app/edge facade**. Consolidation is deferred — and if ever pursued it should be **"C-lite" (a bound `client.endpoint(endpoint).withSchema(schema)` form), not deletion of `define`**: once a bound facade preserves `onError`/`retrySchedule`/`params` it is "`define` plus a captured `HttpClient`," so collapsing buys less API text, not less conceptual surface. Revisit only when real production code wants the service-Tag style **and** the facade supports a full `Endpoint`.

**Facade overhead (perf evidence):** the facade delegates to the same core, so per-op cost is within noise. Median ms, same server/runtime (`test/bench/client-facade.bench.ts`, plus a tsx timing harness):

| Operation | `define(...)` | facade |
|---|---:|---:|
| 200 typed appends | ~31 ms | ~28 ms |
| producer 500 events | ~2.3 ms | ~2.2 ms |

(Differences are run-to-run variance — the facade is zero-overhead delegation, confirming the §10 numbers carry over to the new surface.)

## Appendix A — source provenance

- PR #218 metadata: `OPEN`, base `main`, head `effect-client-refactor`, +4748/−1, 22 files, empty body. Adds package `@durable-streams/client-effect@0.0.1`.
- Files read in full: upstream `index.ts`, `types.ts`, `errors.ts`, `DurableStreamClient.ts`, `StreamSession.ts`, `IdempotentProducer.ts`, `HttpClient.ts`, `internal/retry.ts`, `package.json`, `README.md` (grep), `test/adapter/effect-adapter.ts` (grep); ours `DurableStream.ts`, `namespace.ts`, `errors.ts`, `Reader`/`protocol/Read.ts`, `Writer.ts`, bench harness.
- Key dead-code proof: `grep -rn fetchNext packages/client-effect/src` → defined+passed in `DurableStreamClient.ts`, parameter `_fetchNext` in `StreamSession.ts`, **no use**. `grep -rn 'parseSSE\|from "./SSE'` → only `index.ts` re-exports.

## Appendix B — bench harness (`bench-q1j3/compare.ts`)

Standalone `tsx` script; vendors PR #218 `src/**` into `bench-q1j3/upstream/`, boots one `DurableStreamTestServer`, and times append / producer / snapshot-read for both clients on identical effect/platform. Not committed (vendored upstream would trip knip/dep-cruiser in a gated package). Recreate by splitting `gh pr diff 218` into `bench-q1j3/upstream/` and running `tsx bench-q1j3/compare.ts` from `packages/effect-durable-streams`. Output (two runs):

```
[1] 200 sequential single appends   ours ~32ms   upstream ~32ms
[2] producer 500 appends + flush     ours ~3.1ms  upstream ~15.7ms
[3] snapshot read 1000 items         ours ~1.5ms  upstream ~1.2ms   (counts: 1000/1000 ✓)
```
