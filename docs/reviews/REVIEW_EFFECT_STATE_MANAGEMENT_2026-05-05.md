# Effect-TS State Management Review — 2026-05-05

## Summary

Firegrid's production source contains **zero** `Ref.*`, `SubscriptionRef.*`, `SynchronizedRef.*`, or `TRef.*` call sites. This is **by design, not a gap**. The substrate is a durable kernel: durable rows (Durable Streams + state collections) ARE the authoritative state, and ephemeral fiber-local state inside short-lived loops is carried by closure-captured `let` bindings inside scopes that fully contain those mutations. The lab UI uses React `useState` for view state at the React boundary, where Effect Refs are not the appropriate primitive. The strict-baseline ESLint rule `local/no-module-durable-cache` (`eslint.config.js:286-329`) actively forbids module-scope mutable state for durable-authority-shaped data, so the absence of in-memory state primitives is enforced at lint time.

Per the canonical `Ref` skill: `Ref` is the right tool for *fiber-safe in-process mutable state shared across concurrent fibers*. Firegrid's design points where mutable state appears all disqualify `Ref`: either the state is durable (substrate rows; `Ref` would be a parallel source of truth that diverges across restart), or single-fiber-local (no concurrent reader, so `Ref`'s atomicity is unused), or React component state (managed by React's reconciler, not Effect's runtime).

**Quick stats** (production source only; tests excluded):

- **0** `Ref.make` / `Ref.get` / `Ref.set` / `Ref.update` / `Ref.modify` call sites.
- **0** `SubscriptionRef.*` and **0** `SynchronizedRef.*` call sites.
- **3** `let`-binding sites in production source (`runner.ts:73,132,139`, `RawStreamInspector.tsx:37,48`, `state-machine.ts:326`) — all single-fiber-local or React-effect-local.
- **8** `Ref.*` sites total in tests (e.g. `event-plane-no-authority.test.ts`, `facade-tool-execution.test.ts`, `event-stream-materializer.test.ts`) — recorders and counters in test fixtures, idiomatic.

## Inventory: state-management API usage

Production source: **none.** Search across `packages/{substrate,runtime,client}/src` and `apps/lab/src` for `Ref.`, `SubscriptionRef.`, `SynchronizedRef.`, `TRef.`, `Atomic*`, `TReentrantLock` returned no production hits.

Test source uses `Ref` idiomatically as a recorder/counter primitive in `Effect.gen` fixtures — the skill's "Accumulator" pattern (`packages/substrate/src/__tests__/event-plane-no-authority.test.ts:69,72,94,99`; `facade-launch-dispatch.test.ts:150,201`; `runtime/src/__tests__/event-stream-materializer.test.ts:65,71`). These are appropriate: a `Ref<Array<T>>` accumulating handler invocations across forked fibers in a test harness is exactly what `Ref` exists for.

## Should-it-exist analysis: candidate sites

### `runner.ts:139` — `let deadlineFiber: Fiber.RuntimeFiber<void, never> | undefined`

This is the most plausible candidate for `Ref` migration in the codebase. The `let` binding is captured inside the `wakeStream` subscribe callback and mutated by two closures: `clearDeadline` (reads + nulls) and `scheduleDeadline` (clears + writes). Both run on the *same* loop fiber via `Stream.mapEffect` (`runner.ts:170-178`); `Stream.mapEffect` is sequential per-stream, so there is no concurrent reader/writer. The `let` is closed over inside an `Effect.gen` block that is itself the `subscribe` body of `Stream.asyncScoped`, so the binding lives precisely as long as the scope. **`Ref.make` would buy nothing here**: no concurrent access, no atomic compound operation, no need for the value to outlive the scope. The closure pattern is idiomatic for single-fiber state.

The concurrency review separately flagged that `Effect.fork` at `runner.ts:155` should be `Effect.forkScoped` for structural scope-linkage; that recommendation stands and is independent of state management.

### `runner.ts:132` — `let scheduleDeadline: (...) => Effect.Effect<void>`

The same pattern: a function reference rebound inside a single-fiber gen block. Initialized to `Effect.void`, replaced when the subscribe callback runs, replaced back to `Effect.void` on finalize. Single-fiber, scope-bounded; `Ref` would be ceremony.

### `runner.ts:73` — `let min: number | undefined` inside `minPendingDueAtMs`

Pure-function-local `let` inside a synchronous reducer over a `Map.values()` iterator. No fiber, no Effect, no concurrency. Out of scope for `Ref`. (Could be written as `Iterable.reduce` for style; that's a code-style point, not a state-management one.)

### `operation-handler.ts:121-208` — no in-process processedRuns set

The dispatch loop iterates `snapshot.runs.values()`, filters to `state === "started"` runs whose envelope matches the operation, and dispatches them. There is **no in-process `processedRuns` set** that a naive implementation might keep — and that is correct. Idempotency is delegated to the substrate state machine: a second attempt to `completeRunEffect` / `failRunEffect` on an already-terminal run produces an `IllegalCompletionTransition` (or analogous) through the typed error channel. The state-machine builders are the source of truth for "has this run been processed." A `Ref<Set<runId>>` would be a parallel, restart-fragile authority that disagrees with the substrate after process restart. **Intentionally absent.**

### `subscribers.ts` — no batch-state Ref

`runDueTimeSubscriberFromSnapshot` (`subscribers.ts:155-211`) collects pending completions, processes them via `Effect.forEach`, returns the resolvedIds array via `Option.toArray`. Pure return-channel accumulation — the `Effect.forEach` result IS the accumulator. The skill's `Ref<Array>` "Accumulator" example targets state shared across forked fibers; here the success channel is sufficient.

### `state-machine.ts:326` — `let winner: A | undefined`

Inside the `firstValidTerminal` fold reducer (synchronous, single-fiber, pure). Same as `runner.ts:73` — fine as `let`.

## Lab React state

`apps/lab/src/lab/RawStreamInspector.tsx:30-32`:
- `useState<ReadonlyArray<RawRecord>>([])` — record list
- `useState<string | undefined>(undefined)` — error message
- `useState<"connecting" | "live" | "error">("connecting")` — phase

`apps/lab/src/lab/LabEventStreamPanel.tsx:36-43`:
- 6× `useState` for form inputs, phase, emit status, error message, events list

These are React component state, not Effect state. Migrating to `SubscriptionRef` would require a React-Effect bridge per value or running React inside an Effect runtime — unjustified for ephemeral UI state reconstructed on mount and discarded on unmount. The data-fetching side stays in Durable Streams' async-iterator idiom (`RawStreamInspector.tsx:42-72`). The `let cancelled = false` pattern (line 37) is the standard React-effect cleanup guard; `Ref` would not improve safety because the read is synchronous inside the same useEffect tick.

## Strict baseline already enforces

- `local/no-module-durable-cache` (`eslint.config.js:286-329`) — bans top-level `let` and bans `new Map/Set/WeakMap/WeakSet/[]/{}` initializers for identifiers matching the `durableAuthorityNamePattern` at module scope. Scoped to production lints only (warn level at `eslint.config.js:499`). This is the structural guarantee that `Ref` won't be reintroduced as a module-scope cache by accident.
- `local/no-host-authority-registry` (`eslint.config.js:330+`) — bans host-owned authority registries entirely. Compatible: any `Ref<Map<runId, ...>>` in host code would be flagged by the `no-durable-cache` companion check via the durable-authority name pattern.

## Top recommendations

**Zero state-management migrations recommended.** No production code path would be improved by introducing `Ref`, `SubscriptionRef`, or `SynchronizedRef`. The substrate-authoritative-state design is the right answer for a durable kernel; the React boundary correctly uses React state.

For the record, the only `let`-shaped pattern with a non-trivial alternative is `runner.ts:139`'s `deadlineFiber`. A `Ref<Option<Fiber.RuntimeFiber<void, never>>>` would type-clean the "cleared vs scheduled" states, but introduces ceremony for a single-fiber-local binding. **Not recommended unless it converges with the concurrency review's `Effect.fork` → `Effect.forkScoped` change** (in which case the surrounding refactor could thread a `Ref` naturally; otherwise the `let` is fine).
