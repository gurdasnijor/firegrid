# Effect-TS Resource Management Review — 2026-05-05

## Summary

Firegrid's resource-management posture is broadly aligned with canonical Effect Scope / `acquireRelease` / `Layer.scoped` idioms in the places that matter most: the long-lived `SubstrateStreamDB` is uniformly opened through the shared `acquireSubstrateDb` / `acquireStreamDb` helpers (`packages/substrate/src/stream.ts:46-71`), and every long-running runtime fiber is `Effect.forkScoped`'d inside a `Layer.scopedDiscard`, so finalizing the providing layer reliably tears down the StreamDB, the wake subscription, and any in-flight deadline fiber. R1 + R4 moved the kernel decisively in the right direction, and the runtime side (`runner.ts`, `operation-handler.ts`, `event-stream-materializer.ts`) models long-running loops as scoped programs. The `Stream.asyncScoped` shape in `wakeStream` and `projection-service.buildProjectionCore` is exactly the bracket pattern the skill prescribes.

The weaker side is the `DurableStream` constructor surface: the substrate kernel still constructs `new DurableStream({...})` from inside `Layer.succeed` / `Layer.effect` / `Layer.sync` factories and from per-call `Effect.gen` bodies (10 sites in production code), with no `acquireRelease` and no scope binding. The original review §7 note that "DurableStream is a thin HTTP client wrapper, no resource needs cleanup" appears still true today (no `close()` / `dispose()` exists on the imported value), so these are not bug-grade leaks — but they break the invariant that resource handles are scope-bound, which is fragile against future evolution of the upstream client. The bigger remaining structural finding is per-call layer construction in `firegrid/operation-client.ts` (original review §6e): `withSubstrate` rebuilds a fresh `SubstrateClientLive(cfg)` on **every** `send` / `result` invocation, which wraps `Layer.scoped(SubstrateClient, …)` over `ProjectionLive` — every operation call opens and closes a fresh StreamDB. R-CUTOVER did not fix this; it is still an open finding.

**Quick stats** (production code, excluding tests, scripts, and `test-support/`):

- `Effect.acquireRelease` sites: 6 distinct sites — `packages/substrate/src/stream.ts:50`, `packages/substrate/src/projection-service.ts:55`, `packages/runtime/src/runtime/internal/event-stream-materializer.ts:95`, `packages/runtime/src/runtime/internal/stream-resolver.ts:59`, `packages/runtime/src/runtime/internal/wake-stream.ts:11`, `packages/client/src/firegrid/event-client.ts:134`.
- `Layer.scoped` / `Layer.scopedDiscard` / `Layer.unwrapScoped` sites: 8 — substrate `facade/projection.ts:108`, substrate `event-plane/layer.ts:41`, runtime `firegrid.ts:50`, `:91`, `:117`, runtime `internal/stream-resolver.ts:159`, runtime `runtime/layer.ts:51`, client `client/service.ts:57`.
- `new DurableStream({...})` constructors in production code: **10** — substrate `producer.ts:118` and `:147`, `subscribers.ts:89`, `waits.ts:125`, `internal-claim.ts:48`, `operator.ts:107`, `choreography/service.ts:121`, `event-plane/producer.ts:158`; runtime `event-stream-materializer.ts:98`, `operation-handler.ts:116`; client `event-client.ts:109`. **Zero** of the substrate-side ones are paired with `acquireRelease`. The runtime `event-stream-materializer.ts:98` constructor is acquired-released because the *session* (`handle.stream({...})`) is the actual resource — the bare handle is a throwaway.
- `Effect.forkScoped` long-running daemons: 3 — runner, operation-handler, event-stream-materializer.

## Findings by concept

### acquireRelease usage

The six production sites are all symmetric (acquire + release pair, release is `Effect.sync` / `Effect.promise`, never throws) and conform to "keep finalizers simple and infallible":

- `stream.ts:50-60` (`acquireStreamDb`) — canonical `openStreamDb → preload` paired with `db.close()`.
- `projection-service.ts:55-64` — subscription handles wrapped; release iterates `subs.forEach(s => s.unsubscribe())`.
- `event-stream-materializer.ts:95-114` — opens `DurableStream.stream({live:true})` *session* (the actual resource) and releases via `response.cancel()`.
- `stream-resolver.ts:59-77` — embedded `DurableStreamTestServer.start()` paired with `s.stop()`.
- `wake-stream.ts:11-19` — wraps arbitrary `subscribe(wake)` finalizer.
- `event-client.ts:133-153` — browser-safe EventStream session acquisition; release calls `response.cancel()`.

**Resources opened without release pair (real findings):**

1. `packages/substrate/src/producer.ts:118` and `:147` — `buildWorkProducer` and `buildCompletionProducer` each construct `new DurableStream({...})` at `Layer.succeed` factory time. The handle outlives the layer scope and has no release seam.
2. `packages/substrate/src/waits.ts:125` — `DurableWaitsLive` uses `Layer.effect`, builds `new DurableStream({...})` inside the `Effect.gen`, no `acquireRelease` and no finalizer.
3. `packages/substrate/src/choreography/service.ts:121` — `ChoreographyLive` is `Layer.sync`, constructs `new DurableStream` directly. No scope binding.
4. `packages/substrate/src/event-plane/producer.ts:158` — `makePlaneProducer` is a plain factory; the producer it returns is parked in a `Layer.succeed` (`event-plane/layer.ts:34-40`) and the stream handle is constructed eagerly without a finalizer.
5. `packages/substrate/src/operator.ts:107`, `internal-claim.ts:48`, `subscribers.ts:89` — per-call `new DurableStream` inside `Effect.gen` bodies. Each invocation creates a fresh handle, never released.
6. `packages/client/src/firegrid/event-client.ts:109` — browser EventStream client constructs `new DurableStream` at `buildEventStreamService` factory time; the session it opens via `durable.stream(...)` IS bracketed (`:134`), but the long-lived `durable` instance used for `emit` is not.

Whether these are "leaks" hinges on whether `DurableStream` ever holds a disposable. Today the constructor accepts `{ url, contentType }` and the disposable resource is the *session* returned by `.stream(...)`, not the handle itself. So these constructions are intentionally cheap and not bug-grade today — but the pattern is fragile. Recommendation tracked in top-5.

### Layer.scoped vs Layer.effect vs Layer.succeed

Catalog of production layers:

- **`Layer.scoped` / `Layer.scopedDiscard` / `Layer.unwrapScoped`** (correct — resource needs lifetime binding): `facade/projection.ts:108` (StreamDB), `event-plane/layer.ts:41` (per-plane StreamDB), `runtime/firegrid.ts:50,91,117` (daemon fibers), `runtime/internal/stream-resolver.ts:159` (embedded server), `client/service.ts:57` (SubstrateClient aggregator), `runtime/layer.ts:51` (boot resolver). All correct.
- **`Layer.effect`** — only `waits.ts:121` (`DurableWaitsLive`). Builds `new DurableStream` and never closes it. If we treat the handle as needing scope binding defensively, this should become `Layer.scoped` (top-5 #2).
- **`Layer.succeed`** / **`Layer.sync`** — used for "pure config" services: `WorkProducer`, `CompletionProducer`, `PlaneProducer`, `WorkClaim`, `Choreography`, `EventStreamClient`, `FiregridClient`, `EmbeddedDurableStreams`, `DurableStreamAdmin`, attached `RuntimeStreamResolver`, `RuntimeContext`. Six of them also hold a `new DurableStream` in their closure. If/when `DurableStream` becomes disposable, these should migrate to `Layer.scoped`.

### Effect.scoped usage

Effect.scoped wraps in three deliberate places, all correct:

- `bin/firegrid.ts:72,92` — at the binary boundary. Both `runDefault` and `runDev` bind child-process / embedded-server / runtime-fiber lifetimes to one program scope; SIGINT triggers finalizers.
- `runner.ts:119,130`, `operation-handler.ts:113`, `event-stream-materializer.ts:142` — inner `Effect.scoped` inside `*WithAcquire` / `*Loop` shapes. Narrower than the outer `forkScoped`; the inner scope owns the live `SubstrateStreamDB` and wake-stream subscription. Loops cannot exit and leave a dangling DB.

No "too narrow" or "too broad" problems found.

### Per-call vs per-Layer resource construction

This is the largest open finding from the original review. In `packages/client/src/firegrid/operation-client.ts:206-212`:

```
const withSubstrate = <A, E>(f) =>
  Effect.gen(function* () { const c = yield* SubstrateClient; return yield* f(c) })
    .pipe(Effect.provide(SubstrateClientLive(substrateCfg)))
```

`SubstrateClientLive` (`client/service.ts:42-86`) is `Layer.scoped(SubstrateClient, …)` over `ProjectionLive(...)`, which is `Layer.scoped` over `acquireSubstrateDb`. Every invocation of `send` / `result` / `call` therefore opens a fresh scope, opens a fresh `SubstrateStreamDB` (HTTP round-trip + in-memory state rebuild via `openSubstrateDb → preload()`), runs `f`, then closes the StreamDB. R-CUTOVER deleted compatibility code but did not change this structure. **Open finding (carried over from review §6e).**

Same shape in `apps/lab/src/lab/LabEventStreamClient.ts:26-48`: `EventStreamClientLive(cfg)` is built per call. Less expensive (no preload, just a fresh `DurableStream` constructor), but the same structural shape.

The `observe` method (`operation-client.ts:283-292`) uses `Stream.unwrapScoped` + `Stream.provideLayer` — this DOES bracket the layer's lifetime against the caller's stream lifetime. Per-call cost is paid once per `observe`, not once per emit.

### Finalizers (Effect.addFinalizer / Effect.ensuring / Effect.onExit)

No `Effect.addFinalizer` / `Effect.ensuring` / `Effect.onExit` use sites in production code. All cleanup goes through `acquireRelease` or scoped-layer finalization. This is fine — `acquireRelease` is the preferred pattern when the acquire/release pair is symmetric. There is no place where a one-shot finalizer would be more idiomatic than what's there.

### Cleanup-on-interruption

All long-running fibers (`runner`, `operation-handler`, `event-stream-materializer`) are `Effect.scoped` inside their `forkScoped`. On interrupt: `wakeStream`'s finalizer runs the user unsubscribe; the deadline fiber is `clearDeadline()`'d; the `SubstrateStreamDB` is closed via `acquireSubstrateDb` release; the materializer session is `response.cancel()`'d. Coverage is complete. The `Effect.tapErrorCause(... Cause.isInterruptedOnly ? Effect.void : logError)` discipline is consistently applied.

The choreography `blockAndSuspend` ends with `Effect.interrupt` as the in-process suspension signal; the choreography facade holds no resources across the suspension boundary, so there is no leak risk.

### React boundary cleanup

- `apps/lab/src/lab/LabEventStreamPanel.tsx:46-84` — uses `Effect.runFork` + `Fiber.interrupt` in `useEffect` cleanup. The `EventStreamClient.events(...)` stream is fully scoped via `Stream.unwrapScoped` + `acquireRelease` (`event-client.ts:134`), so interrupting tears down the session. Intentional React boundary.
- `apps/lab/src/lab/RawStreamInspector.tsx:36-77` — uses an imperative `let cancelled = false` flag and a `for await` loop over `session.jsonStream()`. The cleanup only flips `cancelled = true`; **the underlying session is never explicitly closed**. The loop checks `if (cancelled) return` after each batch so it exits eventually, but the session is leaked from the durable-streams client's perspective until the iterator is GC'd. Same shape the original review §6b flagged; R1/R4 did NOT fix it. **Open finding.** Fix: mirror LabEventStreamPanel's `Effect.runFork` + `Fiber.interrupt` over a stream that brackets the session via `acquireRelease(durable.stream(...), r => Effect.promise(() => r.cancel()))`.

### node:* direct imports

Production-code direct imports of `node:crypto` (only `randomUUID`):

- `packages/substrate/src/producer.ts:1`, `internal-claim.ts:1`, `waits.ts:108`, `runtime/src/boot/identity.ts:1`.

Detector classifies these `services/rule-001` (potential — should go through a Random/UUID service). The `requirements-management` and `platform` neighbor skills agree: host-touching primitives should be services for mockability. UUID generation is a `Random` concern in Effect's vocabulary. **Carried-over finding (review §L3).** Recommendation: introduce a `UuidService` Context.Tag and provide `node:crypto.randomUUID` in the live layer; tests inject deterministic IDs without `claimIdOverride`-style escape hatches.

Detector also flags `process.env["DURABLE_STREAMS_URL"]` in `runtime/bin/firegrid.ts:74` — should use `Config.string("DURABLE_STREAMS_URL")` per the `configuration` skill.

No `node:fs` direct imports in production code (detector hits are all in `__tests__/` and skeleton helpers, out of scope).

## Out of scope

- `apps/lab/src/lab/LabEventStreamPanel.tsx` — documented React boundary; uses `Effect.runFork` + `Fiber.interrupt` deliberately.
- `apps/lab/src/main.tsx` — Vite app entry.
- `packages/substrate/src/__tests__/**`, `packages/runtime/src/__tests__/**`, `packages/client/src/__tests__/**`, `*.test.ts`, `scripts/` — explicitly skipped per task.
- `test-support/durable-streams-server.ts` — test harness.
- Internal `SubstrateClient` / `SubstrateClientLive` — internal-only after R-CUTOVER deleted the public compat subpath. Reviewable but no public surface to break. The per-call construction issue in `withSubstrate` is the substantive concern; the layer's internal shape is fine.

## Top 5 highest-leverage idiomatic improvements (ranked)

1. **Hoist the `SubstrateClient` layer out of `withSubstrate` in `packages/client/src/firegrid/operation-client.ts:196-212`.** Construct `SubstrateClientLive(substrateCfg)` once at `buildFiregridClientService` time, build a `ManagedRuntime` (or hold a reference to a single scoped layer), and have `send` / `result` / `call` execute against that runtime instead of rebuilding the layer per call. This eliminates the preload-per-call cost and the open-and-close-StreamDB-per-RPC pattern entirely. Cost: medium (touches the public client structure and the existing test scaffolding). CI-enforceable: yes — once fixed, a Semgrep rule forbidding `Effect.provide(SubstrateClientLive(` inside `withSubstrate`-shaped helpers would prevent regression. Mirror the same fix in `apps/lab/src/lab/LabEventStreamClient.ts`.

2. **Migrate the unscoped substrate-kernel `new DurableStream({...})` constructions to a scoped helper.** Introduce `acquireDurableStream(cfg)` in `packages/substrate/src/stream.ts` paralleling `acquireSubstrateDb`. Even if `DurableStream` has no real `close()` today (so the release is `Effect.void`), the *shape* invariant — every resource handle is scope-bound — is what makes the code resilient. Convert `DurableWaitsLive` (`waits.ts:121`) to `Layer.scoped`, convert `ChoreographyLive` (`choreography/service.ts:119`) to `Layer.scoped`, convert `SubstrateProducerLive`'s buildWorkProducer / buildCompletionProducer (`producer.ts:118,147`), `makePlaneProducer` (`event-plane/producer.ts:158`), and the per-call sites in `operator.ts:107`, `internal-claim.ts:48`, `subscribers.ts:89`, `event-client.ts:109`. Cost: medium-low; mostly mechanical. CI-enforceable: yes — Semgrep rule forbidding `new DurableStream` outside `acquireDurableStream` (whitelist `stream.ts`).

3. **Fix the `RawStreamInspector.tsx` session leak.** Replace the imperative `for await` + `cancelled` flag with the same `Effect.runFork` + `Fiber.interrupt` shape used by `LabEventStreamPanel.tsx`, layered over an `Effect.acquireRelease(durable.stream(...), (r) => Effect.promise(() => r.cancel()))` resource. Cost: low (one component, one effect, ~30 LOC). CI-enforceable: partial — could add an ESLint rule forbidding `for await (... of ... .jsonStream())` outside of an `acquireRelease` scope, but this is fragile.

4. **Introduce a `Uuid` / `Random` service for `randomUUID()` calls.** Replace the four `node:crypto` direct imports (`producer.ts:1`, `internal-claim.ts:1`, `waits.ts:108`, `runtime/boot/identity.ts:1`) with a `UuidService` Context.Tag and provide a Live layer that wraps `node:crypto.randomUUID`. Tests can inject deterministic UUIDs without the `claimIdOverride` test-only hatch in `internal-claim.ts:30`. Cost: medium (touches multiple files and forces every call site through `yield*`). CI-enforceable: yes — depcruise `forbidden` rule blocking `node:crypto` from `packages/substrate/src/**` and `packages/runtime/src/**`.

5. **Migrate `process.env["DURABLE_STREAMS_URL"]` in `packages/runtime/bin/firegrid.ts:74` to `Config.string`.** Aligns the binary boundary with the `configuration` skill. Cost: low (a few lines). CI-enforceable: yes — Semgrep rule forbidding `process.env[` outside of `bin/` and `test-support/` would lock it down.

## What strict-baseline already enforces

The existing strict-mode quality gates already cover several resource-lifecycle invariants:

- **depcruise (`.dependency-cruiser.cjs`)** — enforces package-boundary integrity (`client-no-runtime`, `runtime-no-client`, `lab-no-substrate-or-runtime`, `kernel-internals-stay-internal`, `packages-no-apps`). This indirectly protects the layer-composition story: nothing outside the kernel can build a fresh `SubstrateStreamDB` outside of the acquireSubstrateDb helper, since the kernel internals are not importable from runtime/client/apps.
- **Semgrep (`.semgrep.yml`)** — already has `firegrid-acquire-db-shape` (DUP_DETECTION.2) which enforces the canonical shape of the acquire-DB helper, plus `firegrid-tryPromise-stream-append`, `firegrid-retained-fold-by-field`, `firegrid-authoritative-run-call`. These prevent re-introduction of the acquire-DB anti-pattern.
- **Knip (`.knip-baseline.json`)** — orphan/unused code surfacing.
- **The Effect-TS detector (`/tmp/effect-detect-packages.txt`)** — already catches `services/rule-001` (node:fs, node:crypto, process.env outside config services).

What is **not** enforced and would need new rules after the recommendations land:

- A "every `new DurableStream` lives inside an `acquireRelease`" rule (covers top-5 #2). New Semgrep rule.
- A "no `Effect.provide(...)` inside per-call helpers that takes a fresh layer constructor" rule (covers top-5 #1). Hard to write generically; an AST-level lint or a pattern-specific Semgrep rule keyed to `withSubstrate`-shape helpers is the realistic option.
- A "no `process.env[…]` outside `bin/`" rule (covers top-5 #5). Easy Semgrep rule.

The detector's `services/rule-001` already handles `node:crypto` (top-5 #4) — it is "potential" today, but a depcruise `forbidden` rule would lift it from advisory to gate.

No new rules need their strict-mode gates flipped to advance these recommendations; #2 and #5 can be added as advisory Semgrep rules first and promoted to errors once the cleanup lands.
