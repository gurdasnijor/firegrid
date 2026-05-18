# Feasibility: migrating WaitFor.match to DurableDeferred-native primitives

Date: 2026-05-17
Type: feasibility study (no code change)
Evidence base: `packages/runtime/src/durable-tools/**` read end-to-end,
`packages/runtime/src/workflow-engine/internal/engine-runtime.ts`,
`packages/runtime/src/agent-event-pipeline/authorities/runtime-output-{journal,public}.ts`,
upstream `@effect/workflow` `DurableDeferred.ts`, all `WaitFor.match` call
sites, `packages/effect-durable-operators/src/DurableTable.ts` (replay
semantics), `WaitFor.test.ts` + `runtime-context-workflow-core.test.ts`.

---

## Verdict (read this first)

**Feasible with one structural caveat. Recommend Shape C now (small, low-risk,
removes the parallel state); defer Shape A (full elimination) until after the
per-context engine slice and deferred-input rewrite land.**

The load-bearing question resolves favorably: Firegrid's `engine.deferredDone`
**is idempotent — first-writer-wins, keyed on `${executionId}/${deferredName}`**
(`engine-runtime.ts:252-266`). The upstream `DurableDeferred.done` contract
specifies *no* idempotency; Firegrid's engine adds it. Additionally — and this is
the second decisive finding the brief did not anticipate — the typed wait
sources are `DurableTable.rows()` streams with `includeInitialState: true`
(`DurableTable.ts:597,753`), i.e. **full deterministic replay + live tail**. So
the "subscription gap on host restart" failure mode (going-in hypothesis #5)
**does not exist for these sources**: any restarted matcher re-reads the whole
durable table and re-derives the same match. Between idempotent `done` and
replayable sources, `DurableToolsTable`'s `waits`/`completions` tracking is
**mostly redundant dedupe/rediscovery state, not load-bearing correctness
state** — except for one role (telling an *external, non-workflow-driven* router
which waits are pending after restart).

The caveat is structural, not a blocker: today the matcher (the wait router) is
a **host-scoped worker decoupled from the workflows it serves**. That decoupling
is the *only reason* `DurableToolsTable` must exist — an external worker has no
workflow recovery to rediscover its work, so it needs a durable `waits` table.
Fully eliminating the table (Shape A) means moving matching *into the workflow
body* as a raced activity, which is feasible (the timeout side already does
exactly this via `DurableDeferred.raceAll` in `wait-for.ts:392`) but changes the
shape of where a long-lived source subscription runs and is best done alongside
the deferred-input rewrite, which is already moving the same workflows. Shape C
keeps the external router but strips its parallel tables down to nothing it
doesn't strictly need — that's days, not weeks, and is safe to schedule
independently.

---

## 1. Anatomy of the current implementation

`WaitFor.match` (the only public member; `WaitFor.ts` exports `{ match }`,
`wait-for.ts:419-421`) is a workflow-handler-facing call. Its companion
machinery is a **scoped host worker** (the router), a **runtime-private
DurableTable** (`waits` + `completions`), and a **crash reconciler**.

**State machine.** `WaitRowSchema` (`table.ts:50-61`) tracks a wait with
`status: "active" | "completed" | "timed_out" | "retired"`
(`types.ts:71-76`). Transitions:
- created `active` by `upsertActiveWait` inside `matchImpl`
  (`wait-for.ts:123-150, 305`) — read-before-write, so replay of the workflow
  body does not duplicate the row.
- `active → completed` by `completeMatch` on a predicate match
  (`wait-router.ts:119-122`).
- `active → timed_out` by `writeTimeoutCompletion` (`wait-for.ts:209-218`),
  only when no `match` completion already exists (`wait-for.ts:188-193`).

**`completions` vs `waits`.** `WaitCompletionRowSchema` (`table.ts:74-79`) is
"the authoritative record of resolution": one row per resolved wait,
`outcome: "match" | "timeout"`, with `matchedRowPayload` (raw row,
`Schema.Unknown`) for matches. `completions` is written *before* the wait status
flip and *before* `engine.deferredDone` (`wait-router.ts:113-132`), so it is the
durable artifact that survives a crash between "matched" and "workflow resumed".

**Source observation — per-wait, not per-source.** Correcting going-in
hypothesis #4/Shape-A's premise: `startRouter` (`wait-router.ts:186-288`)
streams `waitRows` filtered to `active`, dedupes by encoded wait key via a
`Ref<Set<string>>` (`wait-router.ts:215, 247-256`), and for each new active wait
does `Effect.forkScoped(streamForSource(wait.source) >>= attachWaitToSource)`
(`wait-router.ts:267-280`). `streamForSource` (`wait-router.ts:56-69`) returns
the shared `RuntimeWaitStreams` blueprint, but `attachWaitToSource` runs
`Stream.runForEach` on it (`wait-router.ts:153-174`) — and each run of a
`DurableTable.rows()` stream is an independent `subscribeChanges`. **So today is
already ≈1 subscription per active wait, not 1 per source.** Shape A does not
regress this.

**Replay / host restart.** Two mechanisms, both leaning on durable replay:
1. *Wait rediscovery.* `waitRows` is `table.waits.rows()`
   (`durable-wait-store.ts:63-66`), an `includeInitialState` replay
   (`DurableTable.ts:597`). On restart the router re-streams every wait row,
   re-filters to `active`, and re-forks subscriptions. This is *why the `waits`
   table exists*: the router is not a workflow, so nothing else tells it what is
   pending.
2. *Completion re-drive.* `reconcileCompletions` (`reconcile.ts:29-75`) replays
   `completions.rows()` on startup; for every `match` completion whose wait row
   still exists it flips a stale `active` row to `completed` and **re-issues
   `engine.deferredDone`** with the stored `matchedRowPayload`. It explicitly
   relies on engine idempotency (`reconcile.ts:13-17`, pointing at
   `engine-runtime.ts:263-277`) and does no dedupe of its own.

**Exact match call sequence.** Source row arrives on the per-wait stream →
`completeMatch` (`wait-router.ts:78-133`): re-read wait row at dispatch
(`LIFECYCLE.2`, lines 89-95); bail if not `active`; `evaluateFieldEquals(trigger,
row)` (line 97; `types.ts:137-144`, AND-of-scalar-equality, absent path =
non-match); bail if a `timeout` completion already exists (lines 104-110); write
`match` completion with raw row; flip wait `completed`; `engine.deferredDone(
matchDeferredFor(deferredName), { workflowName, executionId, deferredName,
exit: Exit.succeed(row) })` (lines 124-132). The workflow, suspended in
`DurableDeferred.await` (`wait-for.ts:329` / `361`), is `resume`d and
`deferredResult` now returns the stored exit.

## 2. Anatomy of DurableDeferred (upstream) + Firegrid engine

Upstream `DurableDeferred.ts` (Effect main):
- `make(name, { success?, error? })` — declares a named slot; schemas default
  to `Void`/`Never`. `withActivityAttempt` appends the attempt to the name.
- `await(self)` — calls **`engine.deferredResult(self)`**; if `undefined`,
  `Workflow.suspend(instance)`; else yields the stored exit. (It does **not**
  call `deferredDone`.)
- `into(effect, self)` — runs `effect` in an isolated instance context, then
  `engine.deferredDone(self, { …, exit })` with the effect's exit.
- `done(self, { token, exit })` — calls `engine.deferredDone`. **Upstream
  specifies no idempotency**; "behavior depends on engine implementation."
- `token`/`tokenFromExecutionId`/`tokenFromPayload` — base64url of
  `[workflowName, executionId, deferredName]`; lets a non-workflow caller
  complete a deferred without a `WorkflowInstance`.
- `raceAll({ name, success, error, effects })` — `deferredResult` first; else
  `into(Effect.raceAll(effects), deferred)`. Durably records the winner. Already
  used by `wait-for.ts:392` for match-vs-timeout.

**Firegrid `engine.deferredDone` — the load-bearing finding, confirmed in
code** (`engine-runtime.ts:252-266`):

```
deferredDone: options => Effect.gen(function*() {
  const key = `${options.executionId}/${options.deferredName}`
  const existingDeferred = yield* orDieTable(table.deferreds.get(key))
  if (Option.isNone(existingDeferred)) {
    yield* orDieTable(table.deferreds.upsert({ deferredKey: key, … exit: options.exit }))
  }
  yield* resume(options.executionId)
})
```

**Idempotent, first-writer-wins**, keyed on `${executionId}/${deferredName}`
(`workflowName` is stored but not part of the key). A second `deferredDone` with
the same key does **not** overwrite the exit; `deferredResult`
(`engine-runtime.ts:244-251`) reads back the first-written exit. `resume()` does
fire on every call, but resuming an already-resumed workflow is a deterministic
no-op (it re-reads `deferredResult`, gets the same exit, proceeds). This
confirms going-in hypothesis #3's "idempotent" branch and is what makes the
reconciler's blind re-drive safe today.

## 3. WaitFor.match call site inventory

`WaitFor` has exactly one member (`match`); there is no `matchTriggered`.
**Two production call sites, two distinct patterns.**

| # | File:line | Source | Predicate | Result | Timeout | Pattern |
|---|---|---|---|---|---|---|
| P1 | `host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:216` | `input.waitQuery.source` (agent-supplied: `AgentOutput` \| `RuntimeRun`) | agent-supplied `whereFields` → `FieldEqualsTrigger` (validated scalar-only, non-empty; `tool-use-to-effect.ts:194-213`) | raw row → `{matched, event}` (no `resultSchema`) | optional, agent-supplied | **`wait_for` agent tool** — product surface, lowered from protocol bindings (`bindings/tools.ts:132`) |
| P2 | `host-sdk/src/host/runtime-context-workflow-core.ts:170` | fixed `AgentOutputAfter{contextId,activityAttempt,afterSequence}` | `trigger: []` (empty ⇒ universal: "next row after sequence") | raw row, typed `<RuntimeAgentOutputObservation>` (no runtime `resultSchema`) | none | **runtime-context internal** — await next durable agent-output chunk |

Test-only call sites: `WaitFor.test.ts:46`,
`runtime-context-workflow-core.test.ts:312,385`,
`runtime-observation-sources.test.ts:38`.

**Categorization.** Both patterns reduce to: *subscribe to a durable
replay stream; return the first row satisfying a `FieldEqualsTrigger`
(P2's trigger is the trivial "any next row"); complete one deferred with the
raw row; optionally race a durable timeout.* P1's source and predicate are
dynamic but drawn from a fixed, small space (`RuntimeWaitSource` union of 3
variants; `FieldEqualsTrigger` = AND of scalar equalities). **A single migration
shape covers both.** The migration's complexity is bounded by P1's
agent-facing contract stability (see §9), not by call-site variety.

## 4. Three migration shapes

Shared substrate that survives every shape (pure, no table): `types.ts`
(`FieldEqualsTrigger`, `RuntimeWaitSource`, `evaluateFieldEquals`,
`WaitForOutcome`, `WaitForError`), `RuntimeWaitStreams`
(`runtime-wait-streams.ts`), the timeout race
(`DurableClock.sleep` + `DurableDeferred.raceAll`, already in `wait-for.ts`).

### Shape A — per-wait matcher inside the workflow body

Sketch. `WaitFor.match(options)` ⇒ build `matchDeferred = DurableDeferred.make(
name, { success: Schema.Unknown })`; define `matcher: Effect<rawRow> =
streamForSource(options.source) |> Stream.runForEach(filter
evaluateFieldEquals) |> takeFirst`; then
`DurableDeferred.raceAll({ name, success, error, effects: [matcher,
timeoutSide] })` — i.e. extend the *existing* `matchOrTimeoutFlow` so the match
side is the matcher itself, not an external router writing the deferred. No
`DurableToolsTable`, no `wait-router`, no `reconcile`, no `durable-wait-store`.

- **Subscription cost:** neutral. Today is already ≈1 sub per active wait
  (§1); Shape A is the same. Each `DurableTable.rows()` run is its own
  `subscribeChanges`; Effect does not amortize separate runs of the same
  blueprint, but neither does the current router.
- **Restart correctness:** strong. The workflow engine recovers the suspended
  workflow; the workflow body re-runs to the `raceAll`; the matcher re-runs over
  a **full-replay durable source** and deterministically re-finds the same row;
  `raceAll`'s own deferred (first-writer-wins) plus idempotent `done` make
  re-completion a no-op. The `waits`/`completions` tables are simply not needed —
  workflow recovery *is* the rediscovery mechanism.
- **Failure modes:** (a) the matcher is a *long-lived* subscription expressed
  inside a workflow — `@effect/workflow` activities are designed to run to
  completion; a matcher that may suspend for hours is the legitimate
  `DurableDeferred.await` pattern, so the matcher should remain a *raced effect*,
  not an `Activity.make` wrapping `runForEach` (wrapping it in an Activity that
  never completes would pin the activity). This is the one genuinely subtle
  design point. (b) missed-event window between subscribe and predicate-eval:
  none — `includeInitialState` replays from the start, so there is no "before
  subscribe" gap.
- **Feasibility vs §3:** covers both P1 and P2 directly; P2 becomes trivial
  (empty trigger ⇒ first replayed row after sequence).
- **Effort:** ~4–6 days incl. test-fixture rewrite. The production rewrite is
  small (~`wait-for.ts` only); cost is fixtures (§6) and validating the
  long-lived-raced-effect-vs-Activity decision under replay.

### Shape B — per-source matcher workflow

Sketch. One workflow per typed source watches the stream; `WaitFor.match`
registers `{ deferredToken, trigger }` and `DurableDeferred.await`s. The matcher
workflow, on each row, completes any registered deferred whose trigger matches.

- **Durable state:** the registry of `{token, trigger, source-cursor}` is
  exactly `DurableToolsTable.waits` **moved into a workflow's state**, not
  eliminated. This rebuilds the table under another name and adds a
  cross-workflow rendezvous (register-then-await) that the current design
  explicitly avoided (`wait-router.ts:251-252` "no registration rendezvous").
- **Failure modes:** registration/await ordering across two workflows;
  matcher-workflow state recovery; token plumbing. Strictly more moving parts
  than today.
- **Feasibility:** technically possible, **not worth it** — it does not
  shrink the parallel state, it relocates it and adds coordination.
- **Effort:** 2+ weeks; rejected.

### Shape C — stripped external router (recommended near-term)

Sketch. Keep the router as the host-scoped source-watcher + predicate
evaluator, but its **only durable artifact is the engine's own deferred table**.
On match: `engine.deferredDone(matchDeferred, …)` directly (idempotent). Delete
`completions` entirely (the reconciler's job is subsumed by: durable source
replay re-derives the match on restart → router re-calls `done` → first-writer-
wins). Keep a **minimal residual `waits` index** *only* for router rediscovery
of pending waits across restart — or eliminate even that if the router can
enumerate un-resolved deferreds from the engine's `deferreds` table (a wait is
pending iff its deferred row is absent; the router already knows the
deferred-name scheme `wait-for/<name>`).

- **What the router still must remember:** which `(source, trigger,
  deferredName)` tuples are pending. Options: (i) residual one-field `waits`
  index (no `status`, no `completions`); (ii) derive from absence of the
  engine deferred row + the workflow's own re-registration. (i) is the safe
  minimum and is ~1 schema, no state machine.
- **`DurableToolsTable` shrinks from 2 tables + 4-state machine + reconciler to
  at most a single append-only pending-wait index** (and possibly to zero).
  `wait-router.ts` loses `completeMatch`'s completion/timeout bookkeeping
  (lines 99-122), `reconcile.ts` is deleted, `durable-wait-store.ts` collapses
  to one lookup/stream.
- **Failure modes:** double-completion — safe (idempotent `done`). Restart gap
  — none (durable replay sources + router re-derivation). Timeout/match
  exactly-once — still guaranteed by the `raceAll` deferred, unchanged.
- **Feasibility vs §3:** fully covers P1 and P2 with no contract change.
- **Effort:** ~3–4 days, dominated by deleting/rewiring test fixtures (§6),
  not production logic.

## 5. The load-bearing question: idempotency of engine.deferredDone

**Idempotent — confirmed (§2, `engine-runtime.ts:252-266`).** First-writer-wins
on `${executionId}/${deferredName}`; second call does not overwrite the exit;
`resume` re-fire is a deterministic no-op. This is a *Firegrid engine addition*;
upstream `DurableDeferred.done` specifies nothing (so this guarantee must be
treated as an internal invariant to preserve, and any future engine swap must
re-assert it — flag for §9).

How it simplifies each shape:
- **Shape A:** no dedupe state at all. `raceAll`'s deferred + idempotent `done`
  + replayable source = exactly-once resolution with zero parallel tables.
- **Shape C:** `completions` table and `reconcile.ts` become unnecessary —
  their entire purpose was a safe blind re-drive, which idempotency provides for
  free. Only the *pending-wait rediscovery* concern (router is not a workflow)
  remains, and it is a much smaller artifact than today's `completions` +
  4-state `waits`.
- **Shape B:** unaffected (its problem is coordination, not dedupe).

There is **no "not idempotent" / "conditionally idempotent" branch to worry
about**, and no upstream-contract ambiguity that blocks the work — the relevant
contract is Firegrid's own engine, and it is unambiguous in code.

## 6. Test fixture impact

Tests compose `DurableToolsWaitForLive({ streamUrl })` as one layer plus a
`RuntimeWaitStreams` test layer plus engine + tables
(`WaitFor.test.ts:146-182`; `runtime-context-workflow-core.test.ts:253,754`).

Representative sample:
- `runtime/test/durable-tools/WaitFor.test.ts` (855 loc) — **substantive**.
  Asserts on resume counts and explicit restart behavior
  ("resumes after restart when the source row appears between runs",
  line 272). Under Shape C, restart assertions stay meaningful (router
  re-derivation); the `completions`-table-state assertions (if any) stop being
  meaningful and must re-target `engine.deferredResult`. Under Shape A, the
  whole layer-wiring section (`buildLayer`, lines 146-182) is rewritten.
- `host-sdk/test/host/runtime-context-workflow-core.test.ts` — **mechanical**
  for the most part: replace `DurableToolsWaitForLive(...)` provides
  (lines 253, 754) with the new composition; `DurableToolsTable` direct
  reads (line 134) for assertions become `deferredResult` reads.
- `host-sdk/test/agent-tools/{tool-use-to-effect,tools}.test.ts`,
  `runtime/test/authorities/provider-uniqueness.test.ts`,
  `host-sdk/test/host/runtime-observation-sources.test.ts` — **mechanical**
  layer rewire.

Extrapolated total: **~6 test files**. Shape C: ~1 substantive
(`WaitFor.test.ts`) + ~5 mechanical. Shape A: ~2 substantive
(`WaitFor.test.ts`, `runtime-context-workflow-core.test.ts`) + ~4 mechanical.
Invariants that stop being meaningful in both shapes: any assertion on
`waits.status` / `completions` rows — those become `deferredResult` assertions.

## 7. Sequencing and dependencies

Three things are in flight/open: per-context engine slice (assumed to land,
this research is downstream of it), the intent-table work, the deferred-input
rewrite.

- **Shape C** depends only on the per-context engine slice landing (it touches
  the same workflow-engine deferred semantics) and is otherwise independent of
  intent-table / deferred-input. Earliest sane window: **immediately after the
  per-context engine slice merges.** It does not block or unblock the other two;
  it just removes parallel state.
- **Shape A** should follow the **deferred-input rewrite**, because that rewrite
  is already restructuring the same workflows (`runtime-context-workflow-core.ts`
  P2 call site) and moving wait/await semantics into the workflow body. Doing
  Shape A first would force re-doing it after deferred-input; doing it *with* or
  *after* deferred-input lets the matcher-in-workflow shape be designed once.
  Earliest sane window: **after per-context engine slice AND deferred-input
  rewrite complete.**
- This migration does not meaningfully unblock the per-context engine slice;
  it modestly simplifies the deferred-input rewrite (one fewer parallel
  resolution mechanism touching the same workflows) if Shape C lands first.

Recommended order: per-context engine slice → **Shape C** → deferred-input
rewrite → (optionally) **Shape A** if the residual router still feels like
unjustified surface after Shape C.

## 8. Verdict

Restated for action: **Feasible with caveat.** Idempotent `deferredDone` is
confirmed in code and durable-replay sources remove the restart-gap risk, so
`DurableToolsTable`'s `completions` table and `reconcile.ts` are redundant
correctness theatre and can be deleted with no behavior change. The only real
residual is *pending-wait rediscovery for an external, non-workflow router* —
which is small. **Shape C** (strip the router's parallel state to a minimal
pending-index or nothing, delete `completions`/`reconcile`/most of
`durable-wait-store`) is a ~3–4 day, low-risk change dominated by test fixtures,
schedulable right after the per-context engine slice.

The caveat is the structural choice between Shape C and Shape A. Shape A fully
eliminates the table by moving matching into the workflow body as a raced
effect (extending the pattern `wait-for.ts:392` already uses for timeouts) — it
is feasible and clean, but it should ride with the deferred-input rewrite that
is already reshaping the same workflows, not be done speculatively first. This
is not the "two surfaces are fine, leave it" outcome — the parallel mechanism is
genuinely redundant given the two confirmed findings — but it is also not
"weeks of surprising blockers": the surprises (idempotency, replayable sources)
both cut in the migration's favor.

## 9. Open questions

- **P1 contract stability.** Is the `wait_for` agent tool's typed-source
  surface (`RuntimeWaitSource` = `AgentOutput | AgentOutputAfter | RuntimeRun`,
  `FieldEqualsTrigger` scalar-AND) a **stable external contract** agents/tools
  depend on? Both shapes preserve it as-is, but if it is contractual, the
  residual pending-wait index in Shape C must keep enough to reconstruct the
  same observable behavior on restart. (Code suggests yes — it is lowered from
  protocol bindings — but contract status is a product call.)
- **Planned predicate expansion.** Are multi-source waits, OR/NOT/range
  predicates, or cross-source joins planned? `types.ts:12-17` explicitly scopes
  v0 to AND-of-scalar-equality. Shape A composes naturally with richer matchers
  (it is just an effect); Shape C's external evaluator does too. Neither is
  blocked, but a "joins across sources" roadmap item would argue for doing
  Shape A (matcher = arbitrary effect in the workflow) over investing in the
  router.
- **Engine-invariant ownership.** `deferredDone` idempotency is a *Firegrid
  engine* property, not an upstream `@effect/workflow` guarantee. After this
  migration, idempotency stops being "nice to have" and becomes load-bearing
  for `WaitFor`. Should it be asserted by a test/annotation on
  `engine-runtime.ts` so a future engine change can't silently break
  `WaitFor`? (Recommend yes; this is the one thing worth hardening before
  Shape C, not after.)
- **Noticed in passing (not blocking):** `table.ts:117-131` (`findWaitByKey`)
  works around a `DurableTableCollectionFacade.get` index miss for
  `Schema.transformOrFail` primary keys by full-scanning `.query(coll.toArray)`.
  If `DurableToolsTable` is deleted (Shape A) this disappears; if a residual
  index survives (Shape C) the same workaround may resurface. Worth knowing
  before sizing Shape C's residual index.
```
