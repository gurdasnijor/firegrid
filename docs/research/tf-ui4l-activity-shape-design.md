# tf-ui4l — Activity α/β/γ shape design (pre-build paper-design)

**Bead:** tf-ui4l · INV-6 (WAVE 3, P1) — forward-looking; informs future Activity-rethink SDD, NOT the current one-substrate collapse.
**Owner:** lane 6 (sidecar) on branch `sidecar/tf-ui4l-inv6-activity-shape-comparison`.
**Status:** design (pre-impl).

## §0 Load-bearing decision

> Among α/β/γ, which Activity primitive shape best expresses "agent waits for first matching fact on a CallerFact stream + emits a marker on match" — measured on (a) workflow-body LOC, (b) restart-replay span shape, (c) observability span density, (d) engine surface delta from today's `Activity.make`? Or does today's `Activity.make + Stream.runHead` already win?

## §1 Today's baseline (from @effect/workflow + packages/host-sdk + runtime tests)

`Activity.make` (`repos/effect/packages/workflow/src/Activity.ts:85-126`) is a one-shot durable Effect:

```ts
Activity.make({
  name: string,
  success?: Schema,
  error?: Schema,
  execute: Effect<A, E, R>,        // runs ONCE; engine stores exit
  interruptRetryPolicy?: Schedule,
})
```

The engine wraps `activity.execute` via `Workflow.wrapActivityResult`. On a workflow body invocation:

1. If the Activity's exit is already in durable state for this `executionId`, replay returns it without re-running.
2. If not, run the inner Effect; on completion, durably persist the exit; return it.
3. If the inner Effect blocks (e.g., on a `DurableDeferred`), `Workflow.suspend` is called and the workflow goes dormant until reawoken.

Baseline pattern for the use case (workflow-body LOC ≈ 7 if you count both activities + the gen wrapper):

```ts
const FirstMatch = Activity.make({
  name: "first-match",
  success: CallerFactSchema,
  execute: Effect.gen(function*() {
    const streams = yield* CallerOwnedFactStreams
    return yield* Stream.runHead(streams.streamFor(SRC).pipe(Stream.filter(isMatch)))
      .pipe(Effect.map(Option.getOrThrow))
  }),
})
const EmitMarker = (m: CallerFact) => Activity.make({
  name: "emit-marker",
  execute: appendMarker(m),
})
// body:
Effect.gen(function*() {
  const found = yield* FirstMatch
  yield* EmitMarker(found)
})
```

**Engine work on resume (Stream.runHead variant):**
- On resume, if the `first-match` activity's exit is durably stored, replay just yields the stored value. The Stream is NOT re-consumed.
- If the activity was running when the workflow died, on resume the Activity re-runs its `execute` from scratch — which means re-opening the source stream from the head. This is the **restart-replay weakness** that motivates α: no emit cursor.

**Span shape today (per existing sims):** the activity emits one parent span (`firegrid.runtime_context.workflow.session.*` family). Sub-effects inside `execute` add child spans (depends on what the inner Effect annotates). The engine itself adds activity-execute + workflow-instance spans around it.

## §2 α — `Activity.streamed`

```ts
Activity.streamed<A>(name: string, schema: Schema<A>)(
  (seed: Cursor | undefined) => Stream<A, E, R>
): Activity<…>
```

**Semantics (proposed):** the engine consumes the Stream itself, durably checkpointing a cursor after each emit. The success-type is `A` — the workflow body sees one value per `yield*`. On restart, the engine reopens the stream and **skips to the durably-recorded cursor** before resuming consumption (the seed argument is the cursor for the resume case).

Body LOC for the use case:

```ts
const FirstMatch = Activity.streamed("first-match", CallerFactSchema)(
  (_seed) => streams.streamFor(SRC).pipe(Stream.filter(isMatch), Stream.take(1)),
)
// body:
Effect.gen(function*() {
  const found = yield* FirstMatch
  yield* appendMarker(found)
})
```

LOC: ~5. Wins on terseness vs baseline by 1-2 lines.

**Engine surface delta from `Activity.make`:**
- Engine must own stream lifecycle (open/checkpoint/close).
- Engine must persist a per-activity-execution cursor type (`A`'s position descriptor). Today, only the exit is durable; the cursor is a new durable artifact.
- Engine must define what "cursor" means for arbitrary streams — Stream offset? User-supplied keyFn? This is a NON-TRIVIAL design surface; today's `Stream` is provider-agnostic.

**Restart-replay span shape (theoretical):**
- Resume opens the stream with seed=cursor → engine emits `firegrid.activity.streamed.resume {cursor}` span, then 0…n emit spans. Each emit increments the durable cursor.
- For first-match-then-stop, only one durable cursor write happens before `Stream.take(1)` terminates.

**Span density expectation:** medium. Engine emits one resume span + one per-emit-checkpoint span. For "first match" use case, this is ~2-3 engine spans vs today's 1.

**Open design questions:**
- Cursor model: does the engine require `Stream<A, E, R>` to be a Durable-Streams-backed stream so it can use the offset as cursor? Or a user-supplied keyFn? The former limits applicability; the latter pushes complexity onto callers.
- What happens if the cursor's source is no longer at that offset (e.g., compacted)?

## §3 β — `Activity.subscribed`

```ts
Activity.subscribed<E>(name: string, sourceSchema: Schema<E>)(
  (event: E) => Effect<void, Err, R>,
): Activity<…>
```

**Semantics (proposed):** the engine subscribes to the source on the workflow's behalf and invokes the handler per event. After the handler's Effect succeeds, the engine durably acks that event (last-ack cursor). The workflow body doesn't `yield*` to get a value — the activity IS the subscription. The workflow terminates when… **the handler signals completion?** This is ambiguous from the bead description; see open questions.

Body LOC for the use case (assuming termination via `Option<A>` return from the handler — Option.some=done-with-value, Option.none=continue; per OLA-2026-05-20 refinement, avoids semantically-dishonest `Effect.fail` for "we got what we wanted"):

```ts
const Watch = Activity.subscribed("watch", CallerFactSchema, MatchSchema)(
  (event) => isMatch(event)
    ? appendMarker(event).pipe(Effect.as(Option.some({ matched: event })))
    : Effect.succeed(Option.none()),
)
// body:
Effect.gen(function*() {
  const final = yield* Watch       // engine returns the some-value that terminated the fold
})
```

LOC: ~4. Note: this nudges β to LOOK MORE LIKE γ (it has a value channel via the Option), which is exactly what makes β awkward for "find-first-match" — see "Open design questions" + the §3.5 ergonomics-honesty note below.

**Engine surface delta from `Activity.make`:**
- Engine owns subscription lifecycle (subscribe/ack/unsubscribe).
- Engine durably stores a per-activity last-ack cursor.
- Engine needs a `done` mechanism — handler returns a special tagged result? Throws a special "complete" error? Today's Activity is one-shot; β changes the contract to multi-call.
- Side-effect-only handler contract — workflow body sees `void`, can't observe match.

**Restart-replay span shape (theoretical):**
- Resume re-establishes subscription at last-ack cursor → engine emits `firegrid.activity.subscribed.resume {cursor}` span.
- Each event invocation: `firegrid.activity.subscribed.event` span + `firegrid.activity.subscribed.ack` span (per durable ack).
- Span density is high — one+ per event, even non-matching ones, until termination.

**Span density expectation:** highest of the three. Per-event durability is expensive on noisy streams.

**Open design questions:**
- Termination mechanism. The proposed shape (per OLA-2026-05-20) is **`(event) => Effect<Option<A>>`**: `Option.none` continues, `Option.some(a)` terminates and surfaces `a` to the workflow body. This is the idiomatic Effect answer and avoids `Effect.fail`-for-termination dishonesty.
- That mechanism, however, demonstrates β's structural mismatch with "find-first-match": once you add the value channel, β collapses ergonomically toward γ (fold-with-done-state). β's natural home is **subscribe-forever** patterns where the handler genuinely returns `void` and the engine durably acks every event.

### §3.5 β ergonomics-honesty note

The Option-returning sugar layer (per Q3) IS a fair stand-in for an engine-integrated β when the question is "ergonomic LOC + body shape". But it BIASES β favorably for this use case in a subtle way: the sugar can implement the Option-based termination as `Stream.runFold`-with-early-exit inside an `Activity.make`, which is exactly today's baseline pattern in a different syntactic suit. The FINDING must call this out: if the comparison were "subscribe + side-effect every event forever, no termination" — the most natural β use case — β would be the runaway winner on LOC and engine-integration cleanliness, but it would be measuring a use case the bead doesn't ask about.

## §4 γ — `Activity.folded`

```ts
Activity.folded<S, E>(name: string, stateSchema: Schema<S>, sourceSchema: Schema<E>)(
  seed: S,
  step: (state: S, event: E) => S,
): Activity<S, …>
```

**Semantics (proposed):** the engine drives the fold. Per event, it durably stores the next state. The workflow body sees the final state (when does the fold end? — see open questions).

Body LOC for the use case:

```ts
const Find = Activity.folded("find", FindStateSchema, CallerFactSchema)(
  { found: false } as FindState,
  (state, event) => state.found ? state : isMatch(event) ? { found: true, match: event } : state,
)
// body:
Effect.gen(function*() {
  const final = yield* Find
  if (final.found) yield* appendMarker(final.match!)
})
```

LOC: ~5-6. Comparable to α.

**Engine surface delta from `Activity.make`:**
- Engine owns subscription + per-event durable state write.
- Engine owns termination predicate (`step` returns same state ⇒ no-op? `step` returns a tagged "done"? caller passes an explicit `isDone` predicate?).
- State schema is a new durable artifact (vs today's exit-only).

**Restart-replay span shape (theoretical):**
- Resume reads last-saved state + last-ack cursor; re-establishes subscription.
- Per-event: `firegrid.activity.folded.step {prev → next}` span + durable state write.

**Span density expectation:** highest with state-write semantics, but informative — each step is a structured state transition.

**Open design questions:**
- Termination: identical question to β. Possible answers:
  - `step` returns `{ _tag: "Continue", state: S } | { _tag: "Done", state: S }`.
  - Caller passes separate `isDone: (state: S) => boolean`.
  - Run the fold until the source stream closes (impossible for unbounded streams).
- State-write cost: every non-matching event writes durable state. On a noisy stream waiting for one match, this is N writes for 1 useful result.

## §5 Comparison summary (pre-build, theoretical)

| dimension | today (`Activity.make + Stream.runHead`) | α (`streamed`) | β (`subscribed`) | γ (`folded`) |
|---|---|---|---|---|
| body LOC (use case) | ~7 | ~5 | ~3 (if `done` mechanism) | ~5-6 |
| value channel to body | ✅ direct `yield*` | ✅ direct `yield*` | ❌ side-channel needed | ✅ direct `yield*` |
| engine surface delta | 0 (baseline) | +cursor model | +subscription + ack + termination | +state schema + subscription + ack + termination |
| restart-replay correctness | ❌ re-opens stream from head if activity was in-flight | ✅ skips to cursor | ✅ skips to last-ack | ✅ resumes from state |
| span density per-event | 1 (per emit, in caller code) | 2-3 (engine adds cursor span) | 2+ (engine adds event/ack spans) | 2+ (engine adds step + state-write spans) |
| termination ergonomics | natural (Stream.runHead / Stream.take(1)) | natural (Stream.take(1)) | UNRESOLVED — needs `done` mechanism | UNRESOLVED — needs `done` mechanism |

**Prediction (to be validated against the build):**
- α likely wins on restart-replay + body ergonomics for the use case. It needs the smallest set of new design decisions (just cursor model).
- β's termination story is genuinely awkward; it's the cleanest shape for "subscribe forever" patterns, but not for "wait for first match".
- γ is reasonable for "compute aggregate over stream" but heavyweight for "find first matching".
- Today's `Activity.make + Stream.runHead` may already be competitive if (i) restart-replay during in-flight activity is rare AND (ii) re-opening the source is cheap (Durable Streams typically supports this efficiently for caller-owned facts).

## §6 Test rig (build plan) — OLA-confirmed 2026-05-20

**Scope decisions (OLA-confirmed):**

- **Q1 driver:** drive through `claude-agent-acp` per the `workflow-core-paths` pattern. The bead's "agent waits…" naturally refers to the LLM; this matches the sim runner's shape without fighting it. **OLA proposed a one-LLM-three-workflows refinement** (one session calls `wait_for` three times against `alpha-source/beta-source/gamma-source` streams, host routes each to its shape). **Lane 6 fallback to three separate LLM sessions stands**: per-channel routing requires either the not-yet-landed ChannelRegistry (`tf-lawq`, blocked on `tf-auuv`) or sim-local wait_for-handler-swapping that isn't a recognized pattern today. Three separate sub-sims each with their own short LLM run cost ≈ $0.10-0.30 total — bounded.

- **Q2 sugar layer:** approximate α/β/γ as sugar wrappers around `Activity.make` + side `DurableTable` for "engine-owned" cursor/state. The FINDING must include a §[Sugar-layer assumptions] subsection per OLA — see §6.5 below.

- **Q3 β done-signal:** `(event) => Effect<Option<A>>` (`Option.some` terminates with value; `Option.none` continues). Per §3 + §3.5.

- **Q4 strict-3:** four sub-sims total (`baseline + α + β + γ`).

**Three sub-sims** under `packages/firelab/src/simulations/`:

```
tf-ui4l-activity-shape-baseline/   { index, host, driver }.ts
tf-ui4l-activity-shape-alpha/      { index, host, driver }.ts
tf-ui4l-activity-shape-beta/       { index, host, driver }.ts
tf-ui4l-activity-shape-gamma/      { index, host, driver }.ts
```

**Sub-sim 0 (baseline):** today's `Activity.make + Stream.runHead`. Establishes the comparison floor.

**Sub-sims 1-3 (α/β/γ):** each builds a thin **sugar layer** over `Activity.make` that approximates the shape's ergonomics. Reasoning: actually extending the engine to support α/β/γ natively is out of scope for a 1-1.5-day INV. The sugar layer:
- For α: an `Activity.streamed(name, schema)((seed) => stream)` helper that wraps `Activity.make` with a body that consumes the stream itself + manually checkpoints into a side DurableTable. This **simulates** what engine-owned cursor would do, exposing the body shape + the durable-cursor write rate to traces.
- For β: a `subscribed(name, schema)((event) => Effect)` helper that uses `Stream.runForEach` inside an `Activity.make` to drive the handler. Termination via the handler returning `Effect.fail(SubscriptionDone)` caught at the activity boundary. Spans per event.
- For γ: a `folded(name, stateSchema, ...)(seed, step)` helper that uses `Stream.runFold` inside `Activity.make` + writes state per step into a side DurableTable.

**Common host:** seeds 3 non-matching CallerFacts + 1 matching one into a Durable Streams fact table, exposes via `CallerOwnedFactStreams.streamFor`.

**Common driver:** invokes the workflow's `execute({ id: "tf-ui4l-α" })` / similar; awaits success; records trace.

**Trace evidence collected per sub-sim:**
- `trace.jsonl` line count + span name distribution (`simulate:show` + `simulate:perf`).
- Workflow-body LOC (head-counted from source).
- A second run reusing the same `id` (idempotency replay path) — captures the "exit replay" span shape.
- A simulated restart-replay: hook to crash the activity mid-stream then re-execute — **deferred to a follow-up** if signal-to-cost is high. The bead's "restart-replay span shape" criterion can be reasoned analytically from the trace + the engine's known durability points.

**Heuristic for "engine implementation surface needed (d)":** count the new types/methods each shape would require in `@effect/workflow` if natively supported. Source: §2/§3/§4 "Engine surface delta" sections above + the sugar layer's footprint as a proxy.

## §6.5 Sugar-layer assumptions (per OLA Q2 refinement)

The sugar wrappers stand in for engine-integrated primitives. They are NOT cost-equivalent to a real engine implementation; the FINDING's numbers are **shape indicators**, not definitive engine cost. Assumptions surfaced for honesty:

- **Cursor/state durability:** sugar writes cursor (α) / state (γ) / ack (β) into a sim-local `DurableTable`. Engine-integrated versions would likely use the same Durable Streams backing (workflows already store activity exits there), but possibly with:
  - **Different write granularity** — engine might batch cursor updates across multiple emits before fsyncing; sugar writes once per emit.
  - **Different write path** — engine could write into the workflow's existing exit-row sidecar field rather than a separate table.
  - **Different replay semantics** — engine may have access to in-memory cursor state synced with the durable record; sugar reads the durable record fresh on each replay.

- **Activity restart-replay:** today's `Activity.make` durably stores the *exit*. The sugar layer simulates "engine resumes with cursor" by reading the cursor on activity start and seeding the stream. This is a **valid behavior model** but the OPERATIONAL cost of an engine-integrated equivalent could be lower (no fresh durable-table read per resume; cursor lives in workflow execution state).

- **β handler error/cancellation propagation:** sugar implements the Option<A> termination via `Stream.runFold`-with-`Stream.runHead`-style early exit inside `Activity.make`. Engine-integrated β would have its own fiber lifecycle for the subscription; failure semantics may differ (e.g., engine could retry the handler per-event without retrying the whole subscription).

- **Span density:** sugar emits its own `firegrid.activity.streamed.cursor_write` / `.subscribed.ack` / `.folded.state_write` spans by hand. An engine implementation might emit these from a single internal site with different naming + attributes. The COUNT should be comparable; the NAMES + attribute shape are sugar-author choices.

The FINDING's recommendation table must lead with the bolded caveat: *"Sugar-layer indicators, not definitive engine-integration costs."*

## §7 Open coordinator gates (for OLA) — RESOLVED 2026-05-20

All four gates resolved per OLA-2026-05-20 reply:
- Q1: stay with (a) three sub-sims with LLM driver; OLA's one-LLM-three-workflows refinement deferred (requires ChannelRegistry, blocked).
- Q2: sugar layer + §6.5 honesty subsection (added above).
- Q3: β done-signal via `Effect<Option<A>>` (Option.some=done, Option.none=continue).
- Q4: strict-3-plus-baseline.

Net behavior: proceed to implementation with these defaults; any further gates surface mid-build via the same channel.

(Original §7 prompt-text preserved below for record.)

1. **Scope (no-LLM-agent driver):** §6 above. Reject ⇒ I add a claude-agent-acp variant of one sub-sim only, used as a sanity check that the workflow-body lowering still wire-works under real-agent tool-call pressure. Three full LLM-driven runs adds ~10× cost for marginal incremental signal.
2. **Sugar-layer vs engine-patch:** §6 above. Reject ⇒ I scope down to α only and actually extend `@effect/workflow`. β and γ become paper-design-only.
3. **β termination open question:** §3 above. Without a `done` mechanism, β is fundamentally not the right shape for "wait for first match". Should I exclude β from comparison and instead test it on a "subscribe-forever" use case? That changes the bead's use case.

Default action absent OLA pushback: ship sugar-layer comparison + analytical β termination commentary; flag β as awkward-for-this-use-case in the FINDING.
