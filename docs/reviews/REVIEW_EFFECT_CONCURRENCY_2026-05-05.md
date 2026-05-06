# Effect-TS Concurrency Review — 2026-05-05

## Summary

Firegrid's concurrency model is well aligned with idiomatic Effect: every long-running loop is a `Stream.asyncScoped`-driven fiber forked under `Effect.forkScoped` and bound to a `Layer.scopedDiscard`, so layer finalization deterministically tears down the loop fiber and the underlying StreamDB / DurableStream session. The R-STRICT-BASELINE extraction of `wakeStream(subscribe)` removed duplication across the runner / operation-handler / event-stream-materializer trio, and the `bufferSize: 1, strategy: "sliding"` coalescing matches intent — substrate emits "something changed" edges and a sliding 1-buffer drops intermediate wakes while keeping the latest. Where the design departs from canonical Effect is intentional and documented: claim arbitration is durable-fold-driven (substrate is the coordination point, not `Deferred`/`Semaphore`), choreography uses `Effect.interrupt` as a successful-suspension signal, and the React/`bin` boundaries deliberately exit Effect via documented escape hatches. The seams worth attention are tactical: a bare `Effect.fork` for the deadline timer that should be `Effect.forkScoped`, two raw `DurableStream.stream(...)` sessions that leak their reader on interruption (one in production substrate, one in the lab UI), and a serial-dispatch invariant on the operation handler that needs an explicit code-level marker.

**Quick stats** (production source only; tests excluded):

- 4 fork call sites: 3× `Effect.forkScoped` (`event-stream-materializer.ts:81`, `runner.ts:106`, `operation-handler.ts:94`); 1× bare `Effect.fork` (`runner.ts:155`, deadline timer); 1× `Effect.runFork` at the React boundary (`LabEventStreamPanel.tsx:54`, intentional).
- 20 `Effect.acquireRelease` / `Effect.scoped` / `Layer.scoped` / `Layer.scopedDiscard` sites.
- **0** explicit `Semaphore`, `Deferred`, `Latch`, `Queue`, or `PubSub` usages in production source. Coordination is durable (retained-fold + first-valid-claim) or single-fiber-with-coalesce.

## Findings by concept

### Fiber lifecycle (Effect.fork* + Fiber.interrupt + scoped supervision)

The three runtime loops fork their work via `Effect.forkScoped` inside an `Effect.gen` whose surrounding `Layer.scopedDiscard` is the supervising scope:

- `packages/runtime/src/runtime/internal/runner.ts:106` — `runScopedSubscriberProgram` forks the subscriber loop.
- `packages/runtime/src/runtime/internal/operation-handler.ts:94` — `runOperationHandler` forks the dispatch loop.
- `packages/runtime/src/runtime/internal/event-stream-materializer.ts:81` — `runEventStreamMaterializer` forks the materializer loop.

All three terminate cleanly on layer scope close: the fork is scoped to the `Layer.scopedDiscard`'s scope (`firegrid.ts:50,91,117`), and each loop body is itself `Effect.scoped` so inner resources release when the outer scope finalizes. Interruption-on-scope-exit is correct.

**Real finding — bare `Effect.fork` for deadline timer** at `packages/runtime/src/runtime/internal/runner.ts:155` (`Effect.sleep(...).pipe(Effect.tap(wake), Effect.fork)`). It is captured into `deadlineFiber`, explicitly interrupted by `clearDeadline()`, and lives inside the `Stream.asyncScoped` acquire callback, so the surrounding scope eventually claims it. Functionally fine; structurally, the deadline fiber's lifecycle depends entirely on `clearDeadline` running. **Recommendation**: switch to `Effect.forkScoped` so scope linkage is structural rather than comment-asserted.

### Subscriber loops (Stream.asyncScoped + bufferSize:1 sliding + wakeStream)

`wakeStream` at `packages/runtime/src/runtime/internal/wake-stream.ts:6-21` is the correct factoring. Three call sites (`runner.ts:137`, `operation-handler.ts:188`, and implicitly the materializer which uses raw `Stream.async` over a different shape — see below) all consume it. The `bufferSize: 1, strategy: "sliding"` choice is the right primitive for substrate's edge model: substrate emits a wake per `subscribeChanges` notification, but the consumer always reads the *current* live snapshot, so any wakes that arrive during an in-flight scan can collapse into exactly one follow-up rescan. This matches the canonical "drop-oldest-keep-latest" use case from the streams skill and avoids unbounded queue growth.

The materializer (`event-stream-materializer.ts:144-167`) intentionally does **not** use `wakeStream`. It uses `Stream.async<unknown, EventStreamSessionError>` because each emission carries a record payload (not a void wake). This is correct — `wakeStream` is for tick-style triggers, while the materializer is producer-style: each `subscribeJson` callback fans out N items via `emit.single`. Using `wakeStream` here would be a category error.

**Real finding — operation-handler serial dispatch.** `packages/runtime/src/runtime/internal/operation-handler.ts:196-208` iterates `snapshot.runs.values()` and `yield* processRun(run)` sequentially inside the for-loop. New runs arriving during a long-running handler are visible only at the next coalesced wake (correct). But all dispatch for the layer serializes behind the prior handler's exit — this is the documented v1 single-runtime-per-operation contract. There is no in-loop concurrency control. A future slice wanting parallel dispatch would land `Effect.forEach({ concurrency: N })` or a `Semaphore.withPermits` here. **Candidate for future strict gate**: code-level pragma documenting the serial invariant.

### Race conditions and arbitration

`packages/substrate/src/operator.ts:102-206` and `packages/substrate/src/internal-claim.ts:43-83` implement claim arbitration entirely on durable substrate — head cursor, append claim attempt, `readRetainedClaimAttempts`, `firstValidClaim` fold. There is no in-process mutex, no `Semaphore`, no `Deferred` — and that is exactly right. Adding any of those in-process primitives would weaken the design: claim authority must be durable across runtime restarts and multiple processes. The retained-fold-as-authority pattern is the substrate's analogue of a distributed leader-election primitive, and Effect's in-process concurrency primitives would only add a layer that could disagree with the durable answer.

The original review's §6c "bound operator concurrency" point applies one level up — at the *consumer* of `processReadyWorkItem`, not inside it. `packages/substrate/src/facade/work.ts:104-150` (`Work.claimedBy`/`perform`) flows candidates one-at-a-time through `Stream.mapEffect`, which is sequential. If many runtime hosts each consume their own ready-work stream, total system parallelism is "number of hosts × 1." A `Stream.mapEffect(..., { concurrency: N })` at `work.ts:104-120` would let a single host attempt N concurrent claims — but most will lose, and the durable contention cost may exceed the benefit. **Candidate for measurement before adoption.**

### Interruption + suspension semantics

`packages/substrate/src/choreography/service.ts:147-246` implements `blockAndSuspend` as: durable pre-write authoritative read → state-machine-build the block event → `appendChange` → durable post-write verification → `Effect.interrupt`. The host fiber is interrupted as the suspension signal; the harness at `packages/substrate/src/choreography/tools.ts:140-200` translates the interrupt into a typed `ChoreographySuspension` via `Cause.isInterruptedOnly`.

Pros: zero in-process state, durable-read-driven invariants, idempotent re-suspension on the same completion is a no-op (`service.ts:199-217`). The pre-call started-state guard at `tools.ts:154-166` is the right defense against the host-cancellation-before-durable-write race (`choreography-facade.SUSPENSION.4`) — without it, an interrupt arriving before the block-row append could be mis-classified by reading a prior blocked state. The discriminator `Cause.isInterruptedOnly(cause)` at `tools.ts:177` is correct: defects and typed failures propagate verbatim; only a pure interrupt becomes a suspension.

Cons: using interrupt for control flow is non-idiomatic. The canonical Effect alternative would be to encode suspension as a typed return value (`Effect<SuspensionMarker | Result, ...>`), making every call site explicitly handle it; `Deferred` cannot help because the suspension must persist across process restarts. The current design buys ergonomics at the cost of one carefully-fenced interrupt translation. The fence (pre-state guard + `isInterruptedOnly` + `wrapSuspending` defect-pass-through) is correct.

### Resource composition

The `Layer.scoped` discipline is consistent. Each long-lived StreamDB or DurableStream session is acquired inside an `Effect.acquireRelease` and bound to a layer scope:

- `packages/substrate/src/facade/projection.ts:108-111` — `ProjectionLive` is `Layer.scoped`.
- `packages/substrate/src/event-plane/layer.ts:41-57` — plane projection is `Layer.scoped` with merged producer (`Layer.succeed`).
- `packages/substrate/src/projection-service.ts:54-64` — `Stream.asyncScoped` for the projection stream subscription.
- `packages/runtime/src/runtime/internal/stream-resolver.ts:159-183` — `embeddedResolverLayer` is `Layer.scoped` over the embedded test server.
- `packages/runtime/bin/firegrid.ts:72,92` — both subcommands wrap their program in `Effect.scoped`.

**Real finding — unscoped DurableStream session in `readJsonItems`.** `packages/substrate/src/retained-records.ts:25-42`: opens `stream<ChangeEvent>({ url, live: false })` and consumes it via `session.json<ChangeEvent>()`, but never calls `session.cancel()`. For `live: false` the stream may auto-close after `json()` exhausts it, but that is not asserted in the code or comments. If the surrounding effect is interrupted *during* the `Effect.tryPromise({ try: () => session.json(...) })`, the underlying HTTP reader is not torn down. This is called from `attemptClaim` (every claim) and `readAuthoritativeRun` (on every choreography suspension and pre/post operator handler), so it's hot-path. **Recommendation**: refactor to `Effect.acquireRelease(stream(...), (s) => Effect.promise(() => s.cancel()))` matching the shape used in `event-stream-materializer.ts:95-114`.

The `resource-management` skill's bracket pattern is the canonical fix here: every `tryPromise` that opens a session-shaped resource should be paired with an `acquireRelease`-bound finalizer that cancels it.

### Concurrent primitives (Queue / PubSub / Semaphore / Latch / Deferred)

Zero usages in production source. The durable substrate is the coordination layer, so most "I need to coordinate fibers" cases dissolve into "I need to coordinate via append + retained fold." Where in-process coordination *would* materially improve the design:

1. **A bounded `Semaphore` around the operation-handler dispatch loop** (`operation-handler.ts:196-208`) if/when v1's single-runtime-per-operation contract relaxes. Today's serial dispatch is intentional, so this is forward-looking only.
2. **A `Latch` on runtime startup readiness** at `bin/firegrid.ts:80-87` would let the dev subcommand wait for "all subscriber/handler layers are scoped and ready" before printing the readiness banner. Today the banner prints immediately after `runtime.streamIdentity` resolves, before subscriber layers have completed their initial scans. Low impact in practice.

Do not adopt for adoption's sake. The current zero-primitive count is a feature of the durable-coordination design, not a gap.

### React boundary

`apps/lab/src/lab/LabEventStreamPanel.tsx:46-84` is symmetric and idiomatic-for-the-boundary: `Effect.runFork(...)` on mount captures the fiber; cleanup runs `Effect.runPromise(Fiber.interrupt(fiber))`. The `// eslint-disable-next-line no-restricted-syntax` suppressions at lines 53 and 81 are documented and correct. The Stream lifecycle inside the forked effect is itself scoped (`labEvents(cfg)` returns a `Stream.unwrapScoped` from `event-client.ts:131-154`), so `Fiber.interrupt` triggers scope finalization, which calls `response.cancel()` on the underlying durable session. Symmetric.

**Still-open finding — RawStreamInspector session leak.** `apps/lab/src/lab/RawStreamInspector.tsx:36-77`. The original review §6b flagged this; it is **still present**. The component opens `await handle.stream({ offset: "-1", live: true })` (line 45) and consumes it via `for await (...session.jsonStream())`. The unmount cleanup sets `cancelled = true` (line 75) which causes the loop to `return` on the next batch — but it never calls `session.cancel()`. The underlying HTTP reader stays open until the durable-streams client times it out. Browser tab churn in development can leak many sessions. **Recommendation**: capture `session` in a ref, and in the cleanup callback call `session.cancel()` before/after setting `cancelled`. Or — more idiomatically — refactor the component to mirror `LabEventStreamPanel` (use the typed client + `Stream.runForEach` + `Effect.runFork`/`Fiber.interrupt`). The latter is preferred: it makes the React boundary use exactly one pattern across both lab panels.

## Out of scope (intentional non-Effect concurrency surfaces)

- `apps/lab/src/lab/LabEventStreamPanel.tsx:54,82` — React lifecycle bridge via `Effect.runFork` + `Fiber.interrupt`. Documented escape hatch.
- `packages/runtime/bin/firegrid.ts:154` — `NodeRuntime.runMain` + `Effect.scoped` at the binary entrypoint. Documented runtime boundary.
- `packages/substrate/src/choreography/service.ts:245` — `Effect.interrupt` as suspension signal. Documented design decision (`choreography-facade.SUSPENSION.2`); the discriminator and pre-call guard fence the translation correctly.
- `packages/substrate/src/facade/work.ts:143` — `Effect.uninterruptibleMask((restore) => Effect.exit(restore(...)))` ensures the handler runs interruptibly while the `Effect.exit` capture itself is uninterruptible. This is the canonical pattern from the concurrency skill's "Uninterruptible Regions" section, applied correctly.

## Top 5 highest-leverage idiomatic improvements (ranked)

1. **Fix `RawStreamInspector` session leak** (`apps/lab/src/lab/RawStreamInspector.tsx:36-77`). Refactor to mirror `LabEventStreamPanel` — a single `Effect.runFork`/`Fiber.interrupt` pattern across both lab panels. Cost: small, ~30 lines. CI-enforceable: candidate for an ESLint rule that disallows `for await` on `DurableStream.stream(...)` results outside the documented React-runFork bridge pattern.

2. **Fix `readJsonItems` unscoped session** (`packages/substrate/src/retained-records.ts:25-42`). Wrap in `Effect.acquireRelease` with `session.cancel()` finalizer. Cost: small, ~15 lines. Hot path (claim arbitration + choreography suspension) so the cleanup matters under interruption. CI-enforceable: extend the existing `firegrid-tryPromise-stream-append` semgrep rule shape to also catch unscoped `stream(...)` opens.

3. **Switch `runner.ts` deadline timer to `Effect.forkScoped`** (`packages/runtime/src/runtime/internal/runner.ts:155`). One-token change that makes scope linkage structural rather than comment-asserted. Cost: trivial. CI-enforceable: candidate for a custom ESLint rule banning bare `Effect.fork` outside test files (the only legitimate non-scoped uses are at `Effect.runFork` boundaries which are already a separate disable).

4. **Wrap the `LabEventStreamPanel` runFork→interrupt pair in a small utility hook** (e.g. `useScopedEffect(effect, deps)`) so any future Effect-to-React boundary in the lab gets the symmetric cleanup for free. Cost: small, single hook + rewrite both panels. CI-enforceable: post-fix, a rule that limits `Effect.runFork` direct usage to that hook.

5. **Document the operation-handler serial dispatch invariant explicitly in code** (`packages/runtime/src/runtime/internal/operation-handler.ts:196-208`). Add a comment naming the future-slice expansion path (Semaphore/forEach concurrency) and the strict-baseline guard pragma. Cost: comment-only, no runtime change. CI-enforceable: not directly, but a semgrep rule that flags any `for (const … of snapshot.runs.values())` pattern outside this file would prevent the loop from being copy-pasted without the same supervisory discipline.

## What strict-baseline already enforces

The current ESLint + semgrep rules cover *substrate-shape* invariants but not *concurrency* invariants directly:

- ESLint `local/no-fixed-polling` (`eslint.config.js:244,498`) — protects the wakeStream-vs-polling distinction.
- ESLint `local/no-production-js-timers` (`eslint.config.js:218,500`) — bans `setTimeout`/`setInterval` in production code, forcing `Effect.sleep`.
- Semgrep `firegrid-tryPromise-stream-append` (`.semgrep.yml:3`) — catches raw `tryPromise` around stream appends, forcing `appendChange` helper.
- Semgrep `firegrid-acquire-db-shape` (`.semgrep.yml:34`) — catches raw `openSubstrateDb` + `db.preload()` outside the canonical `acquireSubstrateDb` helper.
- Semgrep `firegrid-retained-fold-by-field` and `firegrid-authoritative-run-call` — protect the retained-fold authority shape.

**Not yet protected** (candidates for future strict gates):

- Bare `Effect.fork` outside `Effect.runFork` boundaries (would catch future regressions of the `runner.ts:155` style).
- Unscoped `DurableStream.stream(...)` opens outside `acquireRelease` (would catch the `retained-records.ts` and `RawStreamInspector.tsx` shapes).
- Unscoped `stream(...)` opens (the exported convenience function from `@durable-streams/client`) — same shape, used in `retained-records.ts:30`.
- Direct `Effect.runFork`/`Fiber.interrupt` usage outside the documented React-boundary hook (after improvement #4 above).

These are all good candidates for *future* strict gates once the corresponding fixes land — do not flip the gates pre-fix.
