# Effect-TS Sinks Review — Firegrid

**Date:** 2026-05-05
**Scope:** Production stream-consumer call sites in `packages/` and `apps/lab/`. Tests, scripts, and docs excluded by request.
**Branch baseline:** post R0-R-STRICT-BASELINE.

## Summary

Firegrid's sink surface is intentionally small. There are exactly **five** `Stream.run*` consumer call sites in production code, and **zero** custom `Sink` constructions or references. Every consumer is one of three idiomatic, side-effect-shaped patterns: `Stream.runDrain` for reactive subscriber loops, `Stream.runForEach` for materializers/UI projection, and `Stream.runHead` to convert a filtered stream into a one-shot wait. None of these would be improved by introducing a `Sink.fold` / `Sink.zip` / leftover-aware sink — there are no aggregations, no batched writes, no multi-target tee patterns, and no places where state is folded across stream elements via `Ref.update`. The prompt's expected verdict — "small surface, mostly correct usage of standard Stream consumers" — is confirmed.

The two `client/firegrid/{event-client,operation-client}.ts` files do not consume streams; they construct and **return** streams to callers (the React lab and downstream services). The "Stream.runForEach implicit" note in the prompt refers to those callers, not the clients themselves; this is accurate and is the correct boundary — clients hand back a `Stream.Stream<…>` rather than committing to a sink shape.

## Findings by concept

### 1. Stream consumers in use

Catalog of every production `Stream.run*` site (file:line):

| # | Site | Consumer | Pipeline shape |
|---|------|----------|----------------|
| 1 | `packages/substrate/src/projection-service.ts:73` | `Stream.runHead` | `stream(query) ▸ filter(predicate) ▸ runHead` — one-shot "wait until predicate matches" |
| 2 | `packages/substrate/src/facade/work.ts:180` | `Stream.runDrain` | Generic `runScoped` helper that drains a fully-decorated work pipeline; caller owns the scope |
| 3 | `packages/runtime/src/runtime/internal/runner.ts:179` | `Stream.runDrain` | `wakes ▸ mapEffect(snapshot+scan+scheduleDeadline) ▸ runDrain` — subscriber loop |
| 4 | `packages/runtime/src/runtime/internal/operation-handler.ts:208` | `Stream.runDrain` | `wakes ▸ mapEffect(processRun for each matching run) ▸ runDrain` — operation dispatch loop |
| 5 | `packages/runtime/src/runtime/internal/event-stream-materializer.ts:179` | `Stream.runForEach` | `records ▸ filterMap(envelopeFromRow) ▸ filter(isEventStreamEnvelope) ▸ filter(streamMatch) ▸ mapEffect(decode) ▸ runForEach(materialize)` — materializer fan-out |
| 6 | `apps/lab/src/lab/LabEventStreamPanel.tsx:60` | `Stream.runForEach` | `labEvents ▸ runForEach(setState)` — React UI projection |

Files that **define** but do not run streams (correctly returning a `Stream.Stream<…>` to callers):

- `packages/substrate/src/facade/projection.ts:47` — `ProjectionService.stream` signature.
- `packages/substrate/src/event-plane/projection.ts:65` — `PlaneProjectionService.stream` signature.
- `packages/client/src/firegrid/event-client.ts:130–158` — `rawEvents` builds a `Stream.unwrapScoped(...)` via `Stream.fromAsyncIterable` + `Stream.filterMapEffect`; does not run it.
- `packages/client/src/firegrid/operation-client.ts:283–292` — `observe` returns a `Stream.unwrapScoped` with a `Stream.mapEffect` decorator; does not run it.
- `apps/lab/src/lab/RawStreamInspector.tsx` — does not import `Stream`; consumes a `for await` over `session.jsonStream()` directly inside a React `useEffect` (a deliberate non-Effect surface for the raw protocol view, separate from sink concerns).

Verdict: every consumer is the right primitive for its job. `runHead` correctly expresses "first match"; `runDrain` correctly expresses subscriber loops where each element triggers an `Effect` and there is no aggregate result; `runForEach` correctly expresses "side-effect per element" where the side effect (materialize / setState) is a plain effectful action.

### 2. Custom Sinks — present and missing

**Present:** none. Zero `Sink.` references in production. `grep -r 'Sink\.' packages apps` (excluding tests/scripts/docs) returns nothing. This is fine.

**Should there be any?** No. The criteria for reaching for `Sink` are:

- An aggregate result (sum / count / fold / collectAll). Firegrid has none — the closest are subscriber loops whose "result" is `void`.
- Multi-target observation in one pass (`Sink.zip` / `Sink.zipPar`). The runtime never observes a single stream from two consumers; each subscriber owns its own `Stream.async*`.
- Batched downstream writes (`Sink.collectAllN(n) ▸ Sink.mapEffect(insertMany)`). Firegrid writes events through `appendEvent` per element — there is no batch boundary that would benefit from `collectAllN`. The substrate's `JsonBatch` shape comes from durable-streams **inbound**; the materializer at `event-stream-materializer.ts:160–164` already flattens batches (`for (const item of batch.items) emit.single(item)`) before the Effect stream begins, which is the correct point for batch-flattening.
- Custom termination logic (`Sink.fold` with continue predicate). The one "stop when X" site is `projection-service.ts:73`'s `Stream.filter ▸ Stream.runHead`, which is more direct than a `Sink.fold(none, isNone, takeFirstMatching)`.

### 3. Sink composition / leftovers

No call site combines multiple sinks; nothing requires `Sink.zip`, `Sink.flatMap`, `Sink.race`, or `Sink.collectLeftover`. The materializer at `event-stream-materializer.ts:168–180` chains four `Stream` transformations before `runForEach`, but every step is an element-wise transform — there is no aggregation to compose at the sink level. A `Sink.zipPar(observe, recordMetric)` could in principle replace the current "one stream, one consumer" with "one stream, two consumers in one pass," but Firegrid's metrics path does not exist yet at this layer, so it's premature.

### 4. Stream-to-Effect bridge — `runForEach` + `Ref.update` candidates

`grep -r 'Ref\.update\|Ref\.set\|Ref\.modify' packages apps` (excluding tests) returns **zero** hits in production. There are no folds-by-mutation that would be cleaner as `Stream.runFold` / `Stream.runReduce`. The closest analog is the React `setEvents((prev) => [...prev, event])` accumulator at `LabEventStreamPanel.tsx:62–66`, but that is a React state setter consumed via `runForEach` — it lives outside the Effect runtime by necessity (UI lifecycle is owned by React's `useEffect`). It is not a `Ref` and is not a candidate for a sink rewrite.

The only place where `Stream.runFold` would even be representable is the two runtime loops at `runner.ts:179` and `operation-handler.ts:208`. Both could be expressed as `Stream.runFoldEffect(undefined, () => true, (_, _wake) => …)`, but that's strictly worse: the accumulator is `void`, the predicate is constant `true`, and `runDrain` already encodes that exactly.

## Out of scope

- `apps/lab/src/lab/RawStreamInspector.tsx:42–72` consumes durable-streams' `session.jsonStream()` via `for await … of` inside a React `useEffect`. This is intentionally a non-Effect surface (a raw protocol inspector for the lab); it is not a `Stream.run*` site and does not belong in the sink review. Flag-only, no action.
- Tests, scripts, docs (per scope rules).
- Custom-sink opportunities for telemetry aggregation: deferred until a metrics path is wired.

## Top 3 highest-leverage improvements

The surface is too small for three meaningful improvements. There are zero high-leverage moves and one nit; I am explicitly **not padding**.

1. **None — confirm the clean baseline.** Every `Stream.run*` site uses the right consumer for its semantics. No custom `Sink` is warranted today.

2. **(Nit, optional)** `packages/substrate/src/facade/work.ts:178–180` — `runScoped` is a one-line wrapper over `Stream.runDrain` that adds no value beyond a name. It's exported on the `Work` const for consistency with the other facade helpers, but since the call site already operates on a `Stream`, the indirection is a thin alias rather than a meaningful abstraction. This is a code-style observation, not a sinks issue, and is fine to leave as-is for facade symmetry.

3. **(Forward-looking)** When a metrics path lands on the runtime loops at `runner.ts:179` or `operation-handler.ts:208`, the right primitive is `Stream.tap` before `Stream.runDrain` (or, if metrics fan out to a second consumer, `Sink.zipPar` becomes warranted). Today neither is required.

## What strict-baseline already enforces

- No `Sink.unsafe*` constructors used (none referenced anywhere in production).
- No raw `for await … of` over Effect streams in production code paths intended to be Effect-managed (the one `for await` site in `RawStreamInspector.tsx` is a deliberate React-side bridge to durable-streams' `jsonStream()`, not an Effect stream).
- No `Stream.runForEach` with a `Promise`-returning callback (every callback is `Effect.sync` / `Effect.gen` / a returned `Effect`).
- No `Ref.update` driven by `runForEach` — confirmed zero matches in production. State changes flow through the substrate DB and React's `setState`, both of which sit at intentional boundaries.
- Subscriber loops uniformly close over their resources via `Stream.async*` + `Effect.acquireRelease`, so `Stream.runDrain` is run inside a scope owned by the caller (`Effect.forkScoped` per the comment at `work.ts:175–177`). Strict-baseline's resource-management rules already cover this.

## Bottom line

Firegrid uses `Stream.runDrain`, `Stream.runForEach`, and `Stream.runHead` in their textbook shapes across five production sites. There are no custom sinks, no sink compositions, no leftover-handling pipelines, and no `Ref.update` folds masquerading as `runForEach`. The post-R0-R-STRICT-BASELINE state is already idiomatic on the sinks axis. No remediation tasks are warranted from this review.
