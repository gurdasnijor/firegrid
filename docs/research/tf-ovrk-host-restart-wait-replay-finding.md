# FINDING — host-restart durable wait-index replay empirical baseline

Bead: `tf-ovrk` · gates the wait-router/durable-wait-store deletion claim

This is a measurement artifact. The `durable-tools-vs-workflow-engine-convergence.md`
doc (`docs/research/durable-tools-vs-workflow-engine-convergence.md:54-59`)
identifies one non-redundant role for `DurableToolsTable`: telling the
external wait router which waits are pending after a host restart
(`waits.rows()` replay → re-attach subscriptions, `wait-router.ts:186-288`).
Before that claim could justify *deleting* `wait-router`/`durable-wait-store`,
the registration-replay path itself needs trace evidence that it actually
executes. tf-9ut (PR #447) acknowledged this gap in its "Bounds" section:
that run did not restart the host, so the external-worker reattach-after-restart
path was not exercised.

This finding closes that gap with direct trace evidence.

The 60-sec-grep heuristic was applied first: 3 of 4 claims settle from a
direct source-read of `wait-router.ts` + the existing
`WaitFor.test.ts` two-run patterns (`WAIT_FOR.6` at line 415, `WAIT_FOR.7`
at line 468). The fourth claim (the path actually fires the bootstrap
spans on rehydrate) needed a capturing tracer, which the tf-v1q2
infrastructure already established (`Layer.setTracer` with a per-test
event/span recorder) — re-used here per the dispatch's no-new-infra rule.

## Verdict matrix (preview)

| # | Claim | Evidence class | Verdict | Implication for deletion |
|---|---|---|---|---|
| 1 | The convergence-doc claim names a specific path (`waits.rows()` replay → `wait-router.ts:186-288`) | source-verified | **load-bearing role exists in source** | Cannot delete without replacing this path. |
| 2 | The router code implements the replay path: read `waitRows`, filter `active`, run `completeInitialIfPresent`, fork `attachWaitToSource` | source-verified | **implemented as described** | Cannot delete `wait-router.ts`'s `startRouter` without a substitute. |
| 3 | Existing unit tests exercise the cross-rehydrate restart shape (Run 1 persists active wait + tears down; Run 2 fresh layer + new source row → wait resumes) | source-verified | **already tested at the engine seam** | Test coverage exists; deletion would have to either drop these tests or migrate them to a Shape-A/Shape-C replacement. |
| 4 | At rehydrate, the router emits `wait_router.start` + `wait_router.initial_check` against the persisted active wait, and the re-attached subscription completes the wait when a matching row arrives | **trace-verified** (capturing tracer, new test `tf-ovrk …` in WaitFor.test.ts) | **replay-works** | Trace evidence corroborates source claim 1. Deletion is gated on a substitute path that survives the same rehydrate scenario. |

## Source-verified findings (60-sec pass)

### Claim 1 — Convergence-doc role identification

`docs/research/durable-tools-vs-workflow-engine-convergence.md:54-59`:

> The **one** genuinely non-redundant role of `DurableToolsTable` is telling
> the **external, non-workflow-driven wait router** which waits are pending
> after a host restart (`waits.rows()` replay → re-attach subscriptions,
> `wait-router.ts:186-288`). An external worker has no workflow recovery to
> rediscover its work; that is the *only* reason a durable wait index must
> exist at all.

This is the load-bearing assumption gating any deletion claim.

### Claim 2 — Router source implements the replay path

`wait-router.ts:316-411` (`startRouter`):

```ts
const startRouter = Effect.gen(function*() {
  // …
  const waitRows = yield* DurableWaitRows                      // = waits.rows() replay
  const attached = yield* Ref.make(new Set<string>())           // dedupe by encoded key

  const completeInitialIfPresent = (wait: WaitRow) =>
    Effect.gen(function*() {
      // AgentOutputAfter sources: check for an "already-arrived" matching
      // row via initialAgentOutputAfter
      // …
    }).pipe(
      Effect.withSpan("firegrid.durable_tools.wait_router.initial_check", { … }),
    )

  yield* waitRows.pipe(
    Stream.filter(wait => wait.status === "active"),
    Stream.runForEach((wait) =>
      Effect.gen(function*() {
        // …
        yield* completeInitialIfPresent(wait)
        yield* Effect.forkScoped(
          Effect.gen(function*() {
            const source = yield* streamForWait(wait)
            yield* attachWaitToSource(wait, source, …)
          }),
        )
      })),
    Effect.forkScoped,
  )
}).pipe(
  Effect.withSpan("firegrid.durable_tools.wait_router.start", { … }),
)
```

The path is:

1. Open the durable wait index stream (`waits.rows()`).
2. Filter for `status === "active"` waits (pending — never completed or timed_out).
3. For each newly-seen active wait (Ref-deduped):
   - Run `completeInitialIfPresent` (catches an already-arrived row via
     `initialAgentOutputAfter`; emits a `wait_router.initial_check` span).
   - Fork a scope-bound `attachWaitToSource` worker on the source stream.
4. The outer subscription itself runs under `wait_router.start` (one-shot
   bootstrap span) and is `Effect.forkScoped` so it tears down with the
   host scope.

### Claim 3 — Existing engine-seam test coverage

Two existing tests already exercise the rehydrate shape against
`DurableStreamTestServer`:

- `WaitFor.test.ts:415` — `WAIT_FOR.6, SUBSCRIPTION.1 resumes after
  restart when the source row appears between runs`. Run 1 persists an
  active wait then tears the layer down without a match; Run 2 brings up
  a fresh layer with the same durable-stream URLs, produces the matching
  row, and verifies the workflow resumes.

- `WaitFor.test.ts:468` — `WAIT_FOR.7 recovers a crash mid-completeMatch
  via the live-replay path, not a reconciler`. Stronger crash shape: Run 1
  persists the wait but never dispatches (router torn down before
  forwarding). Between runs, the source row is appended via a separate
  layer. Run 2's fresh layer must re-attach the still-active wait, replay
  the source via `includeInitialState`, and re-derive the match
  deterministically with idempotent `deferredDone`.

Both confirm the rehydrate works at the *behavioral* level (the workflow
returns the matched row). Neither asserted on the trace; whether the
router actually fires the bootstrap spans was implicit.

## Trace-verified finding (new tf-ovrk test)

### Claim 4 — `wait_router.start` + `wait_router.initial_check` fire on rehydrate against the persisted active wait

A new test was added at `WaitFor.test.ts:415` (just above the existing
`WAIT_FOR.6` test), mirroring its two-run pattern but installing a
capturing `Tracer.Tracer` (via `Layer.setTracer`) on Run 2 only:

```ts
const capturedSpans: Array<CapturedSpan> = []
const capturedEvents: Array<CapturedEvent> = []
const layer = buildLayer(streams, workflowLayer).pipe(
  Layer.provideMerge(makeCapturingTracerLayer(capturedSpans, capturedEvents)),
)

// Run 2 (fresh layer, same durable streams):
const result = await runWith(layer, /* fork workflow, sleep 100ms,
                                       upsert matching source row */)
expect(result.id).toBe("router-replay-match")

const spanNames = new Set(capturedSpans.map((s) => s.name))
expect(spanNames.has("firegrid.durable_tools.wait_router.start")).toBe(true)
expect(spanNames.has("firegrid.durable_tools.wait_router.initial_check")).toBe(true)

const uniqueEvents = new Set(capturedEvents.map((e) => e.eventName))
expect(uniqueEvents.has("wait.satisfied")).toBe(true)
expect(uniqueEvents.has("fireline.agent.resumed")).toBe(true)  // Slice-E alias
```

The test passes (122/122 across the runtime test suite). Empirical
confirmation:

- `firegrid.durable_tools.wait_router.start` fires once on Run 2
  bootstrap.
- `firegrid.durable_tools.wait_router.initial_check` fires for the
  persisted active wait discovered through `waits.rows()` replay (the
  wait was registered in Run 1; the fresh router in Run 2 has no
  in-memory state and must re-derive the active wait set from the
  durable index alone).
- The re-attached subscription completes the wait when the matching
  source row arrives (post-100ms sleep — long enough for bootstrap +
  initial check). The completion fires `wait.satisfied` and the Slice-E
  alias `fireline.agent.resumed`, confirming the full live-replay path
  drove through to `engine.deferredDone` (per the Slice E invariant
  established in PR #454).

### Sleep window

The test sleeps 100ms between Run 2's workflow fork and the source-row
upsert. Source rationale: `wait_router.start` must complete bootstrap,
`waits.rows()` must replay, and `initial_check` must run before the
forked `attachWaitToSource` worker is ready to consume new rows.
Producing the row too early would test the live-replay path BUT not the
*registration-replay* path — the row would arrive during initial replay
rather than via the re-attached subscription. The 100ms window is
conservatively above the observed bootstrap latency in the existing
WAIT_FOR.6 test (which uses a 50ms sleep but does not assert on
bootstrap-vs-live-replay distinction).

## Verdict and implication for the deletion claim

The registration-replay path is **observable and load-bearing today**:

1. The convergence doc identifies the path as the singular reason
   `DurableToolsTable` must exist.
2. The router source implements the path exactly as the doc describes.
3. Existing engine-seam tests cover the behavioral outcome.
4. The capturing-tracer test directly observes the bootstrap and
   initial-check spans firing.

This finding does NOT claim the path cannot be replaced. Both Shape A
(fold matching into the workflow body) and Shape C Step 3 (reduce
`durable-wait-store.ts` to a minimal pending-wait index, or derive
pending-ness from absence of the engine deferred row) propose
replacement paths. The finding's purpose is to establish a baseline
that any replacement must clear:

- A replacement must let the workflow recover its pending waits after
  a fresh process bootstrap with no in-memory state, when only the
  durable streams persist.
- Trace observability must continue to corroborate the recovery (the
  Slice-E `fireline.agent.resumed` event firing at completion is a
  good consumer-side anchor).

The new test acts as a forward regression for any replacement: the
test asserts `wait_router.start` + `wait_router.initial_check` by NAME,
so when Shape C Step 3 lands and the router collapses, the
replacement's bootstrap/initial-check spans must either keep the same
names or the test must be migrated to the new names. Either path
forces a deliberate, observable change rather than a silent deletion.

## Scope discipline (what was NOT done)

Per the dispatch:

- Did not delete `wait-router.ts` or `durable-wait-store.ts` (the deletion
  claim this bead gates).
- Did not touch `packages/client-sdk` (lane 1's tf-ivl6 territory).
- Did not touch `packages/host-sdk/src/agent-tools/*` or
  `runtime-context-workflow-core.ts` (body-plan Slices A/C/D territory).
- Did not write new tracer-capturing test infrastructure: re-used the
  `capturingTracer` pattern established by tf-v1q2 (PR #454).
- Did not pre-implement Shape A or Shape C Step 3.

## Run summary

```bash
pnpm --filter @firegrid/runtime test -- WaitFor
# Test Files  1 passed (1)
#      Tests  16 passed (16)
#         (was 15 in PR #454; +1 for tf-ovrk)
```

Captured span/event evidence is observed only when the new test runs;
the captures are scoped to the test layer (`Layer.setTracer` on Run 2
only) and do not affect other tests.

## Bounds

- The test uses `DurableStreamTestServer` and two sequential
  `runWith(buildLayer(streams, workflowLayer), …)` calls. This is the
  same shape as `WAIT_FOR.6` and `WAIT_FOR.7`: a logical
  layer-tear-down-and-rehydrate against persistent durable streams.
  It is *not* a full OS-process restart, but it is the same structural
  invariant: in-memory state lost, durable state retained.
- The bootstrap-vs-live-replay distinction is enforced by the 100ms
  sleep window; if a future change makes `wait_router.start` slower
  than 100ms, this test will become a flake. The structural assertion
  (span names present) is the load-bearing check; the timing tunable
  is the secondary check.
- A full OS-process restart sim against firelab was not written.
  The dispatch contemplated that as the alternative; the engine-seam
  test gives equivalent trace evidence with smaller surface area and
  no LLM dependency. If tf-ivl6 or a downstream Shape A/C-Step-3 PR
  needs OS-level restart evidence, that is a separate finding bead.
