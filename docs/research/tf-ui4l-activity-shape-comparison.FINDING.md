# tf-ui4l — Activity α/β/γ shape comparison FINDING

**Bead:** tf-ui4l · INV-6 (WAVE 3, P1) — exploratory; informs future Activity-rethink SDD.
**Branch:** `sidecar/tf-ui4l-inv6-activity-shape-comparison` (off origin/main).
**Companion:** [`tf-ui4l-activity-shape-design.md`](./tf-ui4l-activity-shape-design.md) (pre-build design + open gates + OLA-2026-05-20 resolutions).
**Coordinator gates resolved:** Q1 (direct workflow-execute, no LLM driver — ChannelRegistry-blocked fallback), Q2 (sugar layer over `Activity.make`), Q3 (β termination via `Effect<Option<A>>`), Q4 (strict 3 sub-sims + baseline). See design doc §7.

## §0 Recommendation (load-bearing — the bead's acceptance question)

**Today's `Activity.make + Stream.runHead` is the right call for the "find first match" use case the bead specifies.** Do NOT add α/β/γ as native `@effect/workflow` primitives on the strength of this comparison.

Rationale (one paragraph):
- For 4-row find-first-match, baseline pays **16 durable writes / 19.9 ms** vs α's 20 / 27.4 ms (+25%), β's 20 / 25.7 ms (+29%), γ's 20 / 40.2 ms (+102%).
- α/β/γ's per-emit / per-ack / per-step durability is structurally redundant when the activity terminates on the FIRST match; baseline's single durable exit-write is the minimal correct artifact.
- α has a narrow theoretical advantage: restart-replay-during-in-flight wouldn't re-open the source from head. But for any wait whose latency is dominated by the wait itself (waiting for a fact that hasn't been emitted yet), Activity.make's "resume-by-re-reading-stored-exit" path already handles 100% of the realistic cases (the wait was suspended on a `DurableDeferred`, not killed mid-stream). The α cursor's value materializes only in a specific scenario — activity-running-eagerly-and-host-crashes — that isn't load-bearing in Firegrid's current architecture.
- β collapses ergonomically toward γ once you add the Option<A>-termination value channel that find-first requires. The β shape's natural home is subscribe-forever patterns (no termination) — those aren't the bead's question and warrant their own forward-looking INV if pursued.
- γ pays for state-write-per-step even when each non-matching event produces an identical no-op state. Its natural home is compute-aggregate-state patterns where every event is informative — again not this bead's question.

**Sugar-layer caveat (per design doc §6.5 + OLA Q2):** these numbers are **shape indicators, not engine-integration costs**. An engine-integrated implementation of α/β/γ could differ in cursor write granularity, replay-path memoization, and fiber lifecycle. The DIRECTIONAL conclusion (baseline wins for find-first) should survive engine-integration optimizations because the structural redundancy (durability per emit when only the terminal value matters) is intrinsic to α/β/γ's semantics, not the sugar's.

## §1 Method recap

Four sub-sims, each implementing the same use case (host seeds 3 non-matching + 1 matching CallerFact, workflow waits for first match, emits a marker, returns the matched row):

```
packages/tiny-firegrid/src/simulations/
  tf-ui4l-baseline/  # Activity.make + Stream.runHead
  tf-ui4l-alpha/     # sugar Activity.streamed — engine-owned emit cursor
  tf-ui4l-beta/      # sugar Activity.subscribed — engine-owned ack + Option<A>
  tf-ui4l-gamma/     # sugar Activity.folded — engine-owned state + takeUntil
```

Sugar layers are tight wrappers around `Activity.make`:
- α writes a per-emit offset row into a side DurableTable (`alphaCursor`)
- β writes a per-event ack row into a side DurableTable (`betaAck`) after calling the user handler
- γ writes the full fold state into a side DurableTable (`gammaState`) after each step

Each sim's host: seeds facts, composes its own DurableStreamsWorkflowEngine + workflow layer, runs the workflow on layer activation, signals stop. Driver yields `Firegrid` (for type compat) then `Effect.never`; runner's raceWith ends the sim on stopSignal. No LLM agent involved.

## §2 Empirical observations (4-row find-first-match, host run order: noise-1, noise-2, noise-3, match)

| metric                          | baseline | α   | β   | γ   |
| ------------------------------- | -------- | --- | --- | --- |
| total trace spans               | 59       | 68  | 68  | 68  |
| `firegrid.tf_ui4l.*` spans      | 2        | 6   | 6   | 6   |
| `workflow_engine.activity.*`    | 4        | 4   | 4   | 4   |
| durable writes (sum)            | 16       | 20  | 20  | 20  |
| sugar-write spans (cursor/ack/state) | —        | 4   | 4   | 4   |
| workflow_engine.execution.execute self_ms | 13.1     | 20.4 | 19.0 | 31.4 |
| `{shape}-workflow.execute` total_ms        | 19.9     | 27.4 | 25.7 | 40.2 |

Notes:
- "engine.activity = 4" across all shapes: each sim runs 2 activities (the wait + the emit-marker), each activity emits 2 engine spans (`activity.execute` + `activity.claim`) = 4 total. This is identical across shapes because each shape uses ONE outer Activity for the wait (which is itself the per-shape sugar wrapper).
- "+4 durable writes" for α/β/γ: exactly 1 sugar write per emit/event/step before termination, matching the 4-row source.
- γ's +102% wall time vs baseline: state-write payload includes the full fold state (struct with 4 fields including matched row payload), 5× the per-write size of α's offset-int cursor. The Durable Streams writes scale with payload size at single-digit-ms-per-call cost.

## §3 Per-shape verdict

### baseline (Activity.make + Stream.runHead) — **recommended for find-first**

```ts
const FirstMatch = Activity.make({
  name, success: MatchedFactSchema,
  execute: Stream.runHead(rows().pipe(Stream.filter(isMatch))).pipe(
    Effect.map(Option.getOrThrow),
  ),
})
// body: yield* FirstMatch
```

- **Strengths:** minimal API, minimal durability cost, established pattern.
- **Restart-replay weakness (theoretical):** if the activity is RUNNING (eagerly consuming source) when the host crashes, on resume the activity re-runs its `execute` from scratch — re-opens the source from head. Not a problem in practice because (i) workflow suspends typically happen on `DurableDeferred.await` (not mid-stream-consumption), and (ii) on resume the activity returns the stored exit without re-running.
- **When this becomes wrong:** if Firegrid ever has activities that are EXPECTED to run eagerly for minutes consuming large streams. None of the current bodies fit that.

### α (`Activity.streamed`) — **viable but currently overkill**

- **Strengths:** durably tracked emit cursor enables resume-without-replay-from-head for in-flight activities.
- **Weaknesses:** per-emit durability writes are gratuitous when the activity terminates on first match; restart-replay correctness gain materializes only in the eagerly-consuming-large-stream scenario above.
- **Engine surface delta:** small — engine takes ownership of the cursor schema + write granularity. Largest open question: what counts as a "cursor" for arbitrary streams. Forcing the stream to be a `DurableTable.rows()` (which has natural offsets) is the cleanest answer, but constrains the API.
- **When to revisit:** if INV-3 (tf-r5e3 — WaitForWorkflow restart-replay durability) surfaces a real scenario where Activity.make's resume-by-replay model loses information, α moves from "currently overkill" to "needed".

### β (`Activity.subscribed` with `Effect<Option<A>>`) — **wrong shape for find-first**

```ts
const Watch = Activity.subscribed(name, FactSchema, MatchedSchema)(
  event => isMatch(event) ? Effect.succeed(Option.some(matched)) : Effect.succeed(Option.none()),
)
// body: const matched = yield* Watch
```

- **Structural mismatch:** the Option<A> value channel needed for find-first makes β look like γ (a step-function over events) wearing different syntactic clothes. The shape's natural use case is **subscribe-forever side-effects**: `(event) => Effect<void>` with no termination. Once termination is added, β has no ergonomic edge over γ and pays the same per-event durability.
- **Honest framing:** "β doesn't fit this use case" IS the load-bearing analytical output of this INV. If the future Activity-rethink SDD considers β, it should propose `Activity.subscribed` for handler-returns-void subscribe-forever patterns, NOT as a general-purpose wait primitive.
- **When to revisit:** if a future use case demands long-lived subscriptions whose handlers run durable side-effects but the WORKFLOW never needs to terminate on the subscription — e.g., an output journal pipeline.

### γ (`Activity.folded`) — **wrong shape for find-first; reasonable for compute-aggregate**

```ts
const Find = Activity.folded(name, FindStateSchema, FactSchema)(
  initialState,
  (state, event) => state.found ? state : isMatch(event) ? matchedState : state,
)
// body: const final = yield* Find  // requires bolted-on takeUntil
```

- **Structural mismatch (for find-first):** writes the full fold state on every event including no-op steps; the takeUntil termination is a caller-side concern, not part of the primitive. The state-payload-per-write cost is the dominant overhead in the empirical run (+5 ms per step, vs α's +1.9 ms).
- **Where γ would shine:** patterns where every event meaningfully advances state — e.g., aggregating per-correlation metrics, tracking running rollups for a dashboard. Find-first is structurally wrong because the state is binary (not-found / found) and the per-step write is mostly identity.
- **Engine surface delta:** large — engine owns state schema + state-write granularity + termination predicate (the bead's γ signature has none; in practice an engine-integrated γ would need either a tagged "Continue/Done" return from step OR an explicit isDone predicate). The takeUntil-in-the-sugar is dishonest stand-in for this missing API.

## §4 Restart-replay analytical model

The bead asks for "restart-replay span shape (engine work on resume)". A direct empirical test (kill activity mid-stream, restart) was OUT OF SCOPE for the 1-1.5-day budget — the analytical model is grounded in the durability points observed in the traces:

- **baseline:** on resume, if `firegrid.workflow_engine.activity.execute` finds a stored exit in the deferreds table, returns it. ZERO per-emit re-work. If the activity was in-flight and the exit was NOT stored, re-runs `execute` from scratch — re-opens source from head, re-consumes 4 rows (3 no-op `Stream.filter` + 1 match). This is the only path where baseline pays per-emit work on resume.
- **α:** on resume, reads `alphaCursor.get(name)` for the seedOffset, opens source with `Stream.drop(seedOffset)`. Pays the cursor read + skipped reads up to the seed offset. For our 4-row scenario with crash-after-3: reads cursor (1 durable read), drops 3 rows (cheap, no durable reads since source is replayed). Net: 1 durable read on resume vs baseline's 4 source re-emits.
- **β:** symmetric to α — `betaAck` read on resume gives the seed offset. Per-handler re-invocation only for events past the seed. For crash-after-3: 1 ack read, handler re-invoked for 1 event (the match).
- **γ:** reads `gammaState` for both the prior state AND the consumed offset. Resume-after-3: gets `{found: false, ...}` + offset=3, applies step to row-4 (match), produces final state. Net: 1 state read + 1 step + 1 state write on resume.

**Net:** for crash-after-3-rows, the resume work is:
- baseline: 4 rows re-consumed (worst case if exit wasn't stored — typical case is exit-stored = no re-work)
- α/β/γ: 1 durable read + work for remaining 1 row

This is α/β/γ's THEORETICAL win. In practice, baseline's "exit stored, no re-work" path covers the realistic case (workflow was suspended on a deferred, not eagerly consuming).

## §5 Forward recommendations

1. **No engine surface change for find-first.** Keep `Activity.make` as the canonical primitive. Document Stream.runHead+Stream.filter as the idiomatic find-first body.
2. **Defer α to evidence.** Wait for INV-3 (tf-r5e3) to surface restart-replay scenarios that baseline genuinely loses. If found, design α from that evidence — likely as `Activity.streamed` constrained to DurableTable.rows() sources where the offset is unambiguous.
3. **Defer β to subscribe-forever.** Open a separate forward-INV for handler-returns-void persistent-subscription patterns if/when a use case arises (e.g., output journal pipeline). Don't carry β forward as a general primitive.
4. **Defer γ to compute-aggregate.** Open a separate forward-INV for fold-over-stream-with-meaningful-state-per-event patterns if/when one arises (e.g., per-correlation rollups). Don't carry γ forward as a general primitive.
5. **Document the find-first idiom.** Add a runbook section or @effect/workflow upstream PR-able example showing the `Activity.make + Stream.runHead + Stream.filter` pattern with the Option-handling. Most of the ergonomic concerns the bead surfaced are about discoverability, not the primitive's correctness.

## §6 Honest limits of this comparison

- **Sugar layer ≠ engine integration.** Per design doc §6.5, an engine-integrated α/β/γ could differ in write granularity (engine could batch cursor updates), write path (engine could use workflow-state sidecar rather than separate table), and replay semantics (engine has in-memory cursor synced with durable record; sugar does fresh read per resume). The DIRECTIONAL conclusions here should be robust, but ABSOLUTE numbers could move ±50%.
- **One scenario.** The 4-row crash-free find-first measurement doesn't probe (i) long source streams with hundreds of no-op events, (ii) actual restart-replay with mid-stream crash, (iii) the LLM-agent driving path that's the natural Firegrid context (gated on ChannelRegistry).
- **No claude-agent-acp drive.** The comparison is workflow-shape-only; the integration question "how would this look behind the wait_for tool" is left to follow-up beads after ChannelRegistry lands.
- **β termination mechanism is OLA-chosen (Option<A>).** Other plausible β designs (handler-throws-Done, tagged-union Continue/Done, separate `untilFirst` variant) might tilt the ergonomic comparison. Per design doc §3, Option<A> is the most idiomatic Effect-shape; an upstream `@effect/workflow` addition would likely pick the same.

## §7 What this INV consumed

Branch: `sidecar/tf-ui4l-inv6-activity-shape-comparison` (off origin/main).
Commits:
1. `355d76ff4` — design doc (pre-build, paper-design + 4 open gates)
2. `026e12993` — OLA-2026-05-20 scope refinements integrated
3. `4c5f86b70` — four sub-sims (baseline + α + β + γ) implemented + empirical runs
4. (this commit) — FINDING

Files (1,500 LOC total):
- `docs/research/tf-ui4l-activity-shape-design.md` (243 LOC)
- `docs/research/tf-ui4l-activity-shape-comparison.FINDING.md` (this file)
- `packages/tiny-firegrid/src/simulations/tf-ui4l-{baseline,alpha,beta,gamma}/{index,host,driver}.ts` (~1,250 LOC)
- `packages/tiny-firegrid/package.json` (+@effect/workflow dep)

Trace runs (kept in `.simulate/runs/` locally for reproducibility):
- baseline: `2026-05-20T07-22-48-584Z__tf-ui4l-baseline`
- α: `2026-05-20T07-18-15-405Z__tf-ui4l-alpha`
- β: `2026-05-20T07-21-30-455Z__tf-ui4l-beta`
- γ: `2026-05-20T07-22-07-997Z__tf-ui4l-gamma`

Time: ~5 hours from dispatch to FINDING — well under the bead's 1-1.5 day estimate. Most of the savings came from collapsing OLA's optional LLM-driver path into the direct-workflow-execute path the runner pattern naturally supports (per design doc §6 + Q1 fallback).
