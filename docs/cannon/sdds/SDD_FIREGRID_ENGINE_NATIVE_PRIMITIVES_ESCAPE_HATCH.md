# SDD: Firegrid Engine-Native Primitives Escape Hatch

Status: contingency design
Created: 2026-05-20
Owner: Firegrid Runtime / Workflow Engine
Related:

- `docs/cannon/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md`
- `docs/cannon/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`
- `docs/sdds/SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md`
- PR #469 / `tf-ovzr` — Phase-1 Lane 6 new-shape replay smoke
- `packages/runtime/src/workflow-engine/internal/engine-runtime.ts`
- `repos/effect/packages/cluster/src/ClusterWorkflowEngine.ts`

## Purpose

This document is a decision-triggered design track. The engine-native
primitives have standalone architectural value: thinner body-plan lowering,
recycle-safe-by-construction waits, lower composition overhead, and cleaner
`durable-tools/` deletion. The decision triggers below gate work allocation, not
the value of the design. Even if no trigger fires, this track is positive
expected value whenever there is idle engine capacity.

The current Phase 1 plan should keep moving regardless: fix the narrow recycle
bug, prove the `WaitForWorkflow` shape, and collapse `durable-tools/` if the
proofs turn green.

This SDD also pre-commits the mitigation path for the upcoming performance
gating phase. If Firegrid's non-LLM workflow substrate latency becomes a
meaningful fraction of the external LLM network round trip, the engine-native
primitive track should move from "architectural escape hatch" to active
performance work. The system should not spend a material share of an agent turn
on local wait bookkeeping while the actual model call is the dominant
irreducible latency.

If the next findings show the same class of recycle/replay leak in multiple
places, Firegrid should lean harder into the foundation it owns:

```text
packages/runtime/src/workflow-engine/internal/engine-runtime.ts
```

Firegrid's durable-streams workflow engine is a sibling implementation of the
same `@effect/workflow` `WorkflowEngine` contract that
`ClusterWorkflowEngine.ts` implements. The base workflow primitives are shared;
the engine semantics below them are Firegrid's design space.

## Why This Exists

The one-substrate plan intentionally lowered body-plan verbs onto standard
workflow primitives:

- `wait_for` =
  `Activity(Stream.runHead(filteredSource)) + DurableClock.sleep +
  DurableDeferred.raceAll`
- `wait_for_any` = races over waits
- runtime-context body = stream event fold + durable correlation state

PR #469 found a precise failure in the first composition. When the engine scope
recycles while the `Activity(Stream.runHead)` branch is in flight,
`DurableDeferred.raceAll` can persist an interrupted race deferred. Gen-2 then
fails decoding that interrupted exit before match or timeout can win.

That is not a reason to abandon one substrate. It is evidence that some
body-plan verbs may want engine-native support instead of fragile userland
composition over lower-level primitives.

A second motivating case is operational, not just semantic. Existing
pre-engine-era polling loops, notably
`packages/host-sdk/src/host/control-request-reconciler.ts`, burn idle CPU and
durable-storage round trips while imposing a multi-second latency floor on
control-plane operations. At idle steady state, each host runs control and
lifecycle loops on 5s intervals and repeatedly scans request tables even when
there is no work. `streamWait` is the engine-native replacement for that shape:
event-driven dispatch on row append, zero polling traffic while idle, and
append-to-action latency governed by the stream substrate rather than the next
timer tick.

## Firegrid Already Owns This Layer

`ClusterWorkflowEngine.ts` is useful precedent, not a template to copy blindly.
It distinguishes client interrupt from engine/runtime movement by inspecting
interruptor fiber ids and tracking interrupted activity ids. In particular, its
activity path can turn a selected interrupt into `Workflow.Suspended` and reset
the activity attempt on resume.

Firegrid's `engine-runtime.ts` has the same authority at a different substrate:

- it owns execution rows;
- it owns activity claims and activity result rows;
- it owns deferred rows;
- it owns clock wakeup rows;
- it owns recovery on layer acquisition.

Therefore the question is not "can Firegrid express this in
`@effect/workflow`?" The question is:

> When composition leaks at the exact semantics Firegrid needs, should the
> durable-streams engine absorb that semantic as a Firegrid-native primitive?

## First Principle

The core invariant should be:

> Engine recycle is suspend/resume, not cancel/fail.

This applies uniformly to:

- in-flight Activities;
- `DurableDeferred.raceAll` branches;
- `DurableDeferred.await` waiters;
- `DurableClock.sleep` scheduled wakeups;
- stream consumers inside Activities, especially `Stream.runHead`.

User-requested cancellation is different. The engine must distinguish:

- **Recycle:** engine scope closes, execution is intended to resume later;
  in-flight work becomes `Workflow.Suspended`.
- **Cancellation:** user or supervisor requested terminal interruption;
  workflow must stay dead and must not come back on the next engine generation.

The narrow PR #469 fix should enforce this invariant first. The engine-native
primitive track below exists if that invariant is not enough, or if later
findings show the same composition leak repeats.

## Discriminator Mechanism

The engine must choose a concrete discriminator for recycle versus cancellation.
This is the load-bearing detail that prevents the invariant above from turning
dead workflows into workflows that resurrect on the next engine generation.

The viable mechanisms are:

1. **Engine-local recycle flag.** An engine-internal `recycling: Ref<boolean>`
   is set during intentional scope close. In-flight Activities catch their
   interrupt, check the flag, and return `Workflow.Suspended` only while the
   flag is set.
2. **Durable cancellation source of truth.** A terminal cancellation API writes
   a durable cancellation marker on the execution row. Recovery refuses to
   resume cancelled executions. Scope-close without a cancellation marker is
   recycle.
3. **Interrupt-cause inspection.** The engine tags its own recycle interrupt
   with a distinguishable interruptor, similar to the
   `ClusterWorkflowEngine.ts` client-interrupt discriminator. Activities inspect
   `Cause.interruptors` to decide whether an interrupt is recycle or user
   cancellation.

Recommendation: use (2) plus (1). The durable cancellation marker is the
authoritative "this execution is dead" record across generations. The
engine-local recycle flag is the fast in-process signal during scope close. Do
not rely on interrupt-cause inspection alone; in-process recycle may not carry a
stable distinct interruptor.

## Replay Determinism Contract

All engine extension primitives must satisfy this contract:

> Given the same workflow execution, durable substrate state, and primitive
> call, replay/recycle/restart returns the same result.

Concrete constraints:

- `streamWait` accepts `Predicate<Row>` from `effect/Predicate`, not a
  replacement DSL. The public surface should compose with Effect's existing
  vocabulary: `Predicate.and`, `Predicate.or`, `Predicate.struct`,
  `Predicate.tuple`, `Predicate.compose`, `Predicate.implies`, and refinement
  narrowing.
- Predicates must be deterministic functions of the row input. They must not
  read wall-clock time, random values, process-local refs, mutable closure
  state, or perform I/O.
- Timeouts are persisted as absolute deadlines, not relative durations
  recomputed on replay.
- Predicate evaluation should read durable row fields only. If a predicate
  needs workflow-body in-memory state, that value must first be fixed into the
  workflow's durable call payload.
- Source offsets / "from now" semantics are explicit fields in the source
  descriptor or durable call payload.

Workflow behavior that cannot satisfy this contract is not an engine extension.
It should remain a workflow body composed over deterministic extensions.

### Predicate Optimization Hints

The engine can still optimize hot predicates without replacing Effect's
predicate surface. Add optional factory helpers under a Firegrid-owned module:

```ts
import { Predicate } from "effect"

const predicate = Predicate.and(
  StreamPredicates.fieldEquals("scenario", "factory.events"),
  StreamPredicates.fieldEquals("eventType", "plan.ready"),
)
```

The helper returns an ordinary `Predicate<Row>` and attaches engine-readable
metadata via a symbol. The engine may inspect that metadata to use an indexed
scan. If no metadata is present, it falls back to row-by-row predicate
evaluation.

This keeps optimization additive:

- bare Effect predicates work;
- optimized factory predicates work better on hot paths;
- no user-facing schema DSL is required for baseline correctness.

Process note: before inventing a Firegrid-specific DSL, first check the vendored
Effect primitives under `repos/effect/packages/effect/src/`. `Predicate`,
`Schema`, `Match`, and `Order` already cover many "small DSL" instincts.

## Extension Surface Shape

Do not change the upstream `WorkflowEngine` interface casually. Add a
Firegrid-specific extension service next to it:

```ts
export interface FiregridWorkflowEngineExtensions {
  readonly streamWait: <A>(
    options: StreamWaitOptions<A>,
  ) => Effect.Effect<StreamWaitOutcome<A>>
  readonly streamWaitAny: <A>(
    options: StreamWaitAnyOptions<A>,
  ) => Effect.Effect<StreamWaitAnyOutcome<A>>
  readonly reducer: <State, Event>(options: ReducerOptions<State, Event>) => Effect.Effect<State>
  readonly signal: (options: SignalOptions) => Effect.Effect<void>
}
```

Workflows that only use standard `Workflow`, `Activity`, `DurableDeferred`, and
`DurableClock` remain portable. Firegrid body-plan workflows can opt into the
extension tag explicitly.

This keeps upstream compatibility while admitting that Firegrid's durable stream
engine has domain-specific semantics.

Every extension primitive must emit stable, documented spans. The perf harness
and future investigations should be able to grep against them. Span convention:

```text
firegrid.engine.<primitive_name>.<phase>
```

Examples:

- `firegrid.engine.stream_wait.intent_persisted`
- `firegrid.engine.stream_wait.match`
- `firegrid.engine.stream_wait.timeout`
- `firegrid.engine.wait_for_any.winner`
- `firegrid.engine.reducer.checkpoint`

New durable rows owned by these primitives must carry a schema version field.
Replay of older workflow executions is a first-class invariant: future versions
must either decode prior row versions or ship a migration that rewrites prior
rows before deployment.

## Candidate Primitives

### 1. `streamWait`

Highest leverage. Replaces the exact composition PR #469 broke.

Concept:

```ts
yield* FiregridWorkflowEngineExtensions.streamWait({
  name,
  source,
  predicate, // Predicate<Row>
  deadline,
  success,
})
```

Engine-owned semantics:

- persist wait intent in workflow-engine state, not `durable-tools/`;
- attach/re-attach to source on engine generation restart;
- persist timeout deadline through engine clock rows;
- return the first matching row or timeout;
- recycle leaves the intent pending, not interrupted;
- user cancellation marks the wait cancelled and prevents resurrection.

Payoff:

- no Activity branch to interrupt;
- no userland `raceAll` deferred to poison;
- no external wait-router substrate;
- `wait_for(channel)` lowers directly to an engine primitive.

### 2. `streamWaitAny`

Body-plan `wait_for_any` wants first-winner semantics over multiple channels.

Engine-owned semantics:

- persist one parent wait-any intent;
- persist child stream-wait intents;
- first child winner finalizes parent;
- losers are cancelled or marked ignored as engine-owned lifecycle;
- recycle re-attaches all unresolved children.

Payoff:

- no nested `raceAll`;
- stable observability for winner/loser accounting;
- direct implementation of sensory integration in the body-plan SDD.

### 3. `recycleAwareActivity`

This is a contract extension for Activities whose in-flight work spans engine
generations.

Possible modes:

```ts
type RecycleBehavior =
  | "resume-from-start"
  | "checkpoint-state"
  | "fail-cleanly"
```

Semantics:

- `resume-from-start`: current `Activity.make` behavior, but recycle becomes
  `Workflow.Suspended`, not a branch failure.
- `checkpoint-state`: **deferred.** Design when the first consumer requires it.
  Open questions: are checkpoints initiated by the engine on a policy, or
  emitted explicitly by the activity body? Does the checkpoint carry stream
  cursor, user state, or both?
- `fail-cleanly`: activity declares that recycle is a real failure.

Payoff:

- keeps standard `Activity.make` intact;
- gives Firegrid long-running stream consumers an honest contract;
- provides a principled place for the PR #469 fix to grow if needed.

### 4. `reducer`

This is the engine-native version of Phase 1 Lane 1's merged event body.

Concept:

```ts
yield* FiregridWorkflowEngineExtensions.reducer({
  name,
  initialState,
  streams: [runtimeInputStream, runtimeOutputStream],
  step,
  checkpointPolicy,
})
```

Engine-owned semantics:

- merge side-tagged streams;
- process events one at a time;
- checkpoint state according to policy;
- replay from checkpoint + source offsets;
- distinguish recycle from cancellation.

Payoff:

- runtime-context body becomes declarative;
- no ad hoc in-body durable Activity-result fold;
- Wave-2A/B/C constraints live inside the engine primitive.

### 5. `signal`

Optional cross-workflow messaging primitive.

Concept:

```ts
yield* FiregridWorkflowEngineExtensions.signal({
  executionId,
  channel,
  payload,
})
```

Payoff:

- direct workflow-to-workflow signal when receiver identity is known;
- channel `send` can skip the fact-stream intermediary in that case;
- receiver can still consume via `streamWait` or `reducer`.

This is lower priority than `streamWait` and `reducer` because the fact-stream
path is still a good choreography substrate.

## Performance Trigger And Mitigation Ladder

The performance gate should compare Firegrid substrate latency against live LLM
network latency in the same class of run. The useful question is not whether
Firegrid adds any overhead; it is whether local durable coordination starts
consuming a meaningful share of the latency budget that should be dominated by
external model/network time.

Initial trigger threshold:

- **P1 trigger:** p95 Firegrid non-LLM substrate latency per agent turn or wait
  operation is at least 10% of p95 LLM network round-trip latency in the same
  scenario class.
- **P0 trigger:** p95 Firegrid non-LLM substrate latency is at least 20% of p95
  LLM network round-trip latency, or one local coordination primitive accounts
  for at least 10% by itself.

The exact percentages can be recalibrated after the first live perf baseline,
but the gate must remain ratio-based. Absolute millisecond thresholds alone are
misleading because LLM latency changes by model, provider, region, and network
conditions.

Measurement shape:

- `pnpm --filter @firegrid/tiny-firegrid simulate:perf` reports local substrate
  spans, durable writes, replay reads, and scheduler delays.
- live dark-factory / ACP traces provide the LLM network-latency denominator
  when API keys and subprocesses are available.
- if live LLM calls are unavailable, the perf gate may use a recorded or
  coordinator-approved LLM latency baseline, but the report must label that
  denominator as synthetic.

Mitigation ladder, in order:

1. Replace composed waits with `streamWait` / `streamWaitAny` so the engine
   writes one durable intent and one durable result instead of Activity claims,
   deferred rows, clock rows, and race result rows.
2. Replace `Clock.sleep(...).pipe(Effect.forever)` polling loops with
   engine-attached `streamWait` observers that re-attach on recycle, avoiding
   idle table scans and userland `Stream.runHead` fibers for hot waits.
3. Use predicate optimization hints for hot paths. Bare Effect `Predicate<Row>`
   remains correct; Firegrid-owned factory predicates may attach index metadata
   so the engine can avoid row-by-row scans.
4. Coalesce durable lifecycle writes where correctness permits: wait intent,
   deadline, match result, and loser cancellation should not require a cascade
   of independent rows when the engine owns the primitive.
5. Move high-rate event folds to `reducer` with explicit checkpoint policy so
   state is durable without writing one Activity result for every tiny event
   unless that granularity is required.
6. Keep stable spans under `firegrid.engine.<primitive_name>.<phase>` so every
   mitigation proves the latency source it removed.

## Post-Cutover Structural Collapse Targets

The engine-native primitive track also names follow-on collapses that should be
queued after the initial durable-tools cutover. These are not Phase 1 blockers,
but they are high-leverage places where host-sdk still owns coordination state
that the workflow engine can absorb.

### `control-request-reconciler.ts`

This is the polling-loop / claim-completion collapse target. Control request
rows become request-specific workflow executions. Claim rows, completion rows,
abandon timers, and idle polling move into engine execution semantics.

### `runtime-context-engine-registry.ts`

This is a different shape: it is not primarily a polling loop. It is a
scoped-engine-per-context anti-pattern:

- today: `N` runtime contexts provision `N` scoped
  `DurableStreamsWorkflowEngine` instances;
- target: one host-scoped workflow engine owns many runtime-context workflow
  executions, keyed by `contextId` / execution id.

The existing input-intent dispatcher is already event-driven and should keep
that shape. The collapse target is the per-context engine factory/cache and the
"registry as architecture" concept itself. In Effect, this should become
host-scoped `Context`/`Layer` composition over one workflow engine, not an
application-visible registry of engines. `claimActive` becomes
`engine.ensureExecution(contextId)`, `dispatchIntent` becomes
`engine.signal(executionId, "input", intent)`, and `deregister` becomes
`engine.interrupt(executionId)`.

This follow-on depends on two decisions:

1. `engine.signal(executionId, channel, payload)` or an equivalent primitive.
2. An explicit architectural decision to move from one engine per context to
   one engine with many executions.

If accepted, `runtime-context-engine-registry.ts` should disappear or become an
internal Layer-construction adapter with no public architectural status. The
engine owns execution lifecycle, replay, and input delivery. Host/application
code should depend on Layer-provided runtime-context capabilities, not on a
registry object that hands out scoped engines.

## Decision Triggers

Start the engine-native primitive track if any of these become true:

1. The PR #469 recycle fix uncovers two or more analogous failures in other
   `DurableDeferred` sites.
2. Wave-2B's state-machine variant surfaces the same recycle-vs-cancel leak in
   the runtime-context body.
3. Phase 2 channel/body-plan implementation hits another composition failure in
   `wait_for_any`, `send`, `call`, or channel correlation.
4. `simulate:perf` shows the durable Activity-result fold for Lane 1 is
   correct but too expensive at expected event rates.
5. Performance gating shows Firegrid non-LLM substrate latency at or above the
   ratio thresholds in the Performance Trigger section.
6. A host-sdk polling loop over durable tables is on a Phase-2/P0 path and can
   be replaced by event-driven engine dispatch. The first concrete candidate is
   `control-request-reconciler.ts`: collapsing it into request-specific
   workflows removes idle scans, eliminates the 0-5s control-plane latency
   floor, and moves multi-host coordination into the workflow engine.
7. The post-cutover plan chooses to eliminate
   `runtime-context-engine-registry.ts` as an architectural pattern, moving from
   one scoped engine per context to one host-scoped engine with many executions.
   This activates the `signal` primitive and requires the
   one-engine-many-executions decision, but it is a structural simplification
   independent of the polling-loop trigger.

Until a trigger fires, keep the narrow Phase 1 fix moving. Do not pause the
one-substrate collapse just to design engine-native primitives.

## Migration Paths

The coordinator should choose deliberately among these paths if this track is
activated:

1. **Path A — Sequential.** Phase 1 Lane 2 ships `WaitForWorkflow` after the
   recycle fix. `streamWait` lands later and migrates the agent-tool lowering.
   This unblocks deletion fastest.
2. **Path B — Parallel-converge.** The engine-primitive track races Lane 2. If
   `streamWait` lands first, Lane 2 targets it directly; otherwise Lane 2 ships
   `WaitForWorkflow` and migrates later.
3. **Path C — Block on engine primitive.** Hold Lane 2 until `streamWait`
   lands, so the cutover never ships `WaitForWorkflow`.

Current default: Path A. Path B is acceptable if idle engine capacity appears.
Path C should require an explicit coordinator decision because it delays the
Phase 1 deletion path.

## Non-Goals

- Do not fork or edit vendored `repos/effect`.
- Do not change the upstream `WorkflowEngine` interface unless a separate SDD
  justifies the compatibility cost.
- Do not re-create `durable-tools/` under a new name.
- Do not use this as a reason to keep the old wait-router.

## First Work Package If Triggered

Open a P1 design/implementation bead:

```text
Add FiregridWorkflowEngineExtensions.streamWait as the first engine-native
primitive. It must satisfy the same match/timeout/restart replay matrix as
PR #469, without composing Activity(Stream.runHead) with raceAll.
```

Acceptance:

- `streamWait` match before restart passes.
- `streamWait` match after restart passes.
- `streamWait` timeout after restart passes.
- user cancellation does not resume after engine generation restart.
- old `WaitForWorkflow` PR #469 sim remains as the regression case that
  justified the primitive, not as the implementation target.
- `simulate:perf` shows `streamWait` performs at most half the durable writes per
  wait operation compared with `WaitForWorkflow`'s
  `Activity + raceAll + DurableClock` composition.
- Replay traces for `streamWait` use at most 30% of the spans of the composition
  replay path. If the primitive is equivalent or worse on writes/spans, regress
  the design rather than shipping it as an architectural simplification.

## Relationship To Current Phase 1

The immediate P0 remains:

```text
engine recycle is suspend/resume, not cancel/fail
```

That fix should land first if feasible. `streamWait` is not a substitute for
the recycle invariant; it is an escape hatch if composition keeps leaking or if
performance shows the composed form is the wrong long-term substrate.

If both land, the body-plan layer can choose:

- short term: `wait_for` lowers to `WaitForWorkflow`;
- long term: `wait_for` lowers to `streamWait`;
- both implementations are measured by the same tiny-firegrid replay/perf sims.

If the engine-primitive track lands during Phase 1 execution, Lane 4's
`durable-tools/` deletion becomes cleaner: the aggressive SDD's
`WaitForWorkflow` wrapper also becomes a removal candidate, and the agent-tool
surface can lower directly to `streamWait`.

The architecture direction stays the same: one durable substrate, owned by the
workflow engine. The only question is how much of the body-plan verb set becomes
engine-native.
