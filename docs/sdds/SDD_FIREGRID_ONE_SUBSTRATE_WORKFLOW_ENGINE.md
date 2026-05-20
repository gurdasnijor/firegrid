# SDD: Firegrid One Substrate — Collapse durable-tools/ onto the Workflow Engine

Status: proposal
Created: 2026-05-20
Owner: Firegrid Runtime / Host SDK / Agent Tools
Supersedes: `SDD_FIREGRID_WORKFLOW_BODY_DEFERRED_INPUT_REWRITE.md` (the deferred-input-rewrite framing that misnamed this as "design a bridge"; the actual move is "delete the substrate divergence")

Related artifacts:

- `docs/handoffs/HANDOFF_tf-qoyg_shape-a-narrow.md` — Lane 1's halt establishing the engine-contract gap that this SDD reframes from "design a bridge" to "delete the bridge layer."
- `docs/research/tf-9ut-workflow-core-paths-empirical-finding.md` — substrate baseline.
- `docs/research/durable-tools-vs-workflow-engine-convergence.md` lines 84-89 — "Shape A should ride with the deferred-input rewrite"; this SDD operationalizes that ride-with constraint as a fuller collapse.
- `docs/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md` — downstream presentation-layer SDD. Slice A's channel registry sits on top of the one-substrate model this SDD lands.
- `repos/effect/packages/cluster/src/ClusterWorkflowEngine.ts` — template that informed Firegrid's engine; primitive set is identical.
- `packages/runtime/test/workflow-engine/DurableStreamsWorkflowEngine.test.ts` (932 lines) — empirical evidence Firegrid's engine already supports Activity + DurableClock + DurableDeferred + replay; no engine-side extension needed for this SDD.

## Premise

Firegrid today carries **two overlapping durable runtimes**:

1. `@effect/workflow`-backed `DurableStreamsWorkflowEngine` — handles Activity execution, DurableClock, DurableDeferred, restart-replay. This is the One Durable Runtime.
2. `packages/runtime/src/durable-tools/` (~2500 lines across the directory) — a bespoke wait substrate with wait-router fiber, wait-store table, completion-row lifecycle, dispatch-time re-check ceremony. Its only function is to bridge typed observation streams to the engine's `DurableDeferred` via `engine.deferredDone` calls from a forked subscription fiber.

The divergence is the complexity spiral. Every overlapping subsystem accumulates bridge code, sync logic, mode confusion. tf-qoyg's halt was the visible cost: trying to remove the bridge in one call site exposed that the engine doesn't have a primitive for "stream-blocked workflow body yielded" — but only because the workflow body's relationship to the engine had been mediated through `durable-tools/`'s DurableDeferred-naming for a decade.

**Resolve the divergence: there is one substrate, the workflow engine.** "Durable wait" is expressed as a workflow execution on that engine. No bridge. No second runtime. No bespoke wait-store. The agent-tool `wait_for` becomes a workflow whose body uses `DurableDeferred.raceAll` over an Activity-that-does-Stream.runHead and a DurableClock.sleep — primitives the engine already has.

### Why this works specifically because the engine is stream-backed

This SDD's shape is **not portable to `ClusterWorkflowEngine`**. The load-bearing property is that `DurableStreamsWorkflowEngine`'s engine-state and the application's stream-state are the same thing — durable streams. The left branch (runtime-context body as a stream-fold) only composes with engine replay because re-folding the stream IS re-running the body; nothing else needs to be replayed.

On a cluster-sharded engine where state is sharded entity messages, the body would have to "smuggle" stream state in as an external substrate — exactly the divergence this SDD eliminates. The right branch (`WaitForWorkflow` using Activity + Stream.runHead + DurableClock + DurableDeferred.raceAll) IS portable across engines, but it would have to live alongside a separate stream substrate on cluster-backed engines.

The fact that `Workflows.layerDurableStreams` was authored as a sibling to `ClusterWorkflowEngine` is what unlocks this collapse. Without it, you get option-3 ("emit to an external durable log from inside an Activity") — workable but bridge-y. With it, you get the one-substrate shape this SDD describes.

This is a Firegrid-specific affordance, not a `@effect/workflow` shape — worth being honest about up front.

### The per-context workflow is a stream-native virtual object

The structural shape of Firegrid's per-context workflow lines up with Restate's [Virtual Object](https://docs.restate.dev/foundations/services#virtual-object) pattern at the **identity + concurrency** layer:

- Keyed identity (contextId)
- Single-writer-per-key (one workflow execution per context, enforced by the engine + claim machinery)
- Durable state attached to the key

What differs is the **state substrate**: Restate VOs hold K/V state journaled separately from the engine's execution history. Firegrid per-context workflows hold state implicitly as the fold of the durable input/output streams — the engine's execution history and the application's state history are the same ledger.

That difference is what makes the reactive body work as a stream-fold:

- A VO-shape with K/V state would force the body to consult a separate K/V journal at every fold step; the engine's replay-from-start semantics and the VO's K/V cursor would diverge into two ledgers needing reconciliation. The body's `Stream.zipLatest(inputs, outputs).runForEach(handle)` couldn't survive replay without bridge code re-creating the divergence this SDD just collapsed.
- The stream-as-state substrate has ONE ledger. Re-folding the stream IS replay. The body's state is implicit in the cursor + the fold's deterministic step function. No K/V journal to reconcile.

The honest name for the per-context workflow is therefore "**stream-native virtual object**" — same keyed-identity + single-writer-per-key contract that makes VOs reasonable to reason about, with a state substrate chosen specifically because it natively supports stream-fold semantics. The `WaitForWorkflow` is similarly a **transient stream-native VO** (keyed by executionId, single-writer, scoped lifetime, terminates with a value via the race).

This framing has an architectural payoff: Restate VOs are orchestration-native (clients call methods → engine dispatches → state read/write → return value; RPC-shaped). Stream-native VOs are choreography-native (agents emit onto streams → VO subscribes via fold → emits onto other streams; event-driven). The two coexist on the same identity/concurrency contracts; the channel layer (per `SDD_FIREGRID_AGENT_BODY_PLAN.md`) is the natural interop boundary if Firegrid VOs ever need to call out to K/V-shape services or vice versa.

## The converged shape

### Agent-tool `wait_for` — a workflow execution

`packages/runtime/src/agent-tools/WaitForWorkflow.ts` (new, ~80 lines):

```ts
export const WaitForWorkflow = Workflow.make({
  name: "firegrid.agent_tools.wait_for",
  payload: { source: SourceSchema, trigger: TriggerSchema, timeoutMs: Schema.Number, name: Schema.String },
  success: WaitForOutcomeSchema,
  error: WaitForErrorSchema,
})

export const WaitForWorkflowLayer = WaitForWorkflow.toLayer(
  Effect.fn(function*(payload, { executionId }) {
    const events = yield* RuntimeWaitStreams
    const source = yield* streamForSource(payload.source).pipe(
      Stream.filter(evalTrigger(payload.trigger)),
    )
    const matchSide = Activity.make({
      name: `match-${payload.name}`,
      success: MatchedRowSchema,
    })(Stream.runHead(source).pipe(
      Effect.map(Option.getOrThrow),
      Effect.map(row => ({ _tag: "Match" as const, row })),
    ))
    const timeoutSide = DurableClock.sleep({
      name: `timeout-${payload.name}`,
      duration: Duration.millis(payload.timeoutMs),
    }).pipe(Effect.as({ _tag: "Timeout" as const }))
    return yield* DurableDeferred.raceAll({
      name: `race-${payload.name}`,
      success: WaitForOutcomeSchema,
      error: Schema.Never,
      effects: [matchSide, timeoutSide],
    })
  }),
)
```

Call site in `tool-use-to-effect.ts:216`:

```ts
// Was: WaitFor.match({...})
// Is:
const engine = yield* WorkflowEngine.WorkflowEngine
return yield* engine.execute(WaitForWorkflow, {
  executionId: `wait-${context.contextId}-${toolUseId}`,
  payload: { source, trigger, timeoutMs, name: toolUseId },
})
```

Net: ~80 lines added (`WaitForWorkflow.ts`), ~10 lines changed (`tool-use-to-effect.ts`), ~2500 lines deleted (`durable-tools/`).

### Runtime-context workflow body — stream-native zip + handler

`packages/host-sdk/src/host/runtime-context-workflow-core.ts` restructured. Pseudocode for the load-bearing shape:

```ts
const body = (context, activityAttempt) => Effect.gen(function*() {
  const inputs = (yield* RuntimeIngressTable).rowsAfter({...})
  const outputs = (yield* RuntimeAgentOutputAfterEvents).after({contextId, activityAttempt, afterSequence: -1})
  yield* Stream.zipLatest(inputs, outputs).pipe(
    Stream.runForEach(([input, output]) =>
      Effect.gen(function*() {
        if (input !== lastInput) yield* handleInput(context, activityAttempt, input)
        if (output !== lastOutput) {
          const outcome = yield* handleOutput(context, activityAttempt, output)
          if (outcome._tag === "Exit") return yield* writeRunExited(outcome.exit)
        }
      })
    )
  )
})
```

Net: `runtime-context-workflow-core.ts` collapses from 584 lines to roughly 100-150 lines. `runtimeInputDeferredName`/`runtimeInputDeferredFor`/`completedRuntimeInput`/`awaitPermissionResponseInput`/`waitForAgentOutput`/`nextAgentOutput`/`outputWaitName` are deleted. `handleAgentOutput`/`handleRuntimeInput`/`runToolUseActivity`/the terminal-exit predicate stay.

### Test pattern transition

The 5 currently-hanging tests in `runtime-context-workflow-core.test.ts` use `executeNativeRuntimeContext({discard:true})` + `Fiber.join`. Under the converged shape, the workflow body runs as long as the session lives (until terminal-exit) — there's nothing for `Fiber.join` to wait on except the body's natural termination.

Lane 1's tf-qoyg halt doc already prototyped the replacement: `waitUntilWorkflowStarted(contextId, activityAttempt)` polls `RuntimeControlPlaneTable.runs` for a `started` row. Tests migrate to this sync model:

- `executeNativeRuntimeContext({discard:false})` to fire-and-detach
- `waitUntilWorkflowStarted(...)` to confirm the body began running
- Driver-side assertions on output rows + control-plane rows for behavior validation
- Test cleanup via scope close (the engine has structural lifetime management for in-flight executions)

This is a real test contract change, but Lane 1's halt doc shows the helper is ~10 lines and the migration is mechanical.

## Acceptance criteria

1. **`durable-tools/` directory deleted in full.** All files. The `@firegrid/runtime` package no longer exports `WaitFor`, `DurableToolsWaitFor`, `WaitRouterLive`, `DurableWaitStore*`, `DurableToolsTable`, or any wait-row/completion-row schema.
2. **Agent-tool `wait_for` runs as a workflow.** `tool-use-to-effect.ts:216` calls `engine.execute(WaitForWorkflow, ...)`. The 1+2 CallerFact spans from tf-9ut's baseline are preserved — same observable behavior, different substrate.
3. **Runtime-context workflow body is stream-zip + handler shape.** No per-row deferreds. No engine `DurableDeferred` usage from within the body for its own waits. The body's substrate dependencies shrink to the typed observation streams + `RuntimeContextWorkflowSession.send` for emitting agent input events.
4. **5 hanging tests in `runtime-context-workflow-core.test.ts` migrate to the `runs.started`-row sync model** and pass.
5. **In-sim metrics preserved**: `workflow-core-paths` sim (Lane 1's tf-9ut reproducer) shows `AgentOutputAfter wait_for.match` and `wait_router.complete_match` spans go to zero (because the substrate that emitted them is deleted); `CallerFact` waits run through `engine.execute(WaitForWorkflow)` and emit a corresponding `Activity` + `DurableDeferred.raceAll` + `DurableClock.sleep` span trio.
6. **Restart-replay sim added**: a sim that bounces the host process while an agent-tool `wait_for` workflow is suspended on `DurableDeferred.raceAll` resumes cleanly (the engine's existing activity-result-record + DurableClock-resume semantics carry this).
7. **No engine API additions.** The collapse uses only primitives `DurableStreamsWorkflowEngine.test.ts` already validates.
8. **Body-plan SDD's Slice A becomes implementable.** Channel-typed `wait_for` agent surface (`tf-lawq`) wraps `engine.execute(WaitForWorkflow, ...)` underneath; the channel registry's static-source class resolves to the typed observation stream the Activity subscribes to.

## Freedom we have but deliberately don't use in THIS SDD

Because Firegrid owns `DurableStreamsWorkflowEngine` (sibling to `ClusterWorkflowEngine`, written specifically for our durable-streams substrate), we own the implementation of `Activity` registration and replay for it. We are NOT bound to `@effect/workflow`'s upstream Activity-as-value-terminator contract — we could additively extend Activity's semantics for our engine specifically.

Three shapes become natural under that freedom:

- **Option α — `Activity.streamed(name, schema)((seed) => Stream<A>)`** — Activity returns a stream rather than a value; engine durably tracks emit cursor + last-emitted-value-per-chunk.
- **Option β — `Activity.subscribed(name, sourceSchema)((event) => Effect<void>)`** — Activity declares a subscription + per-event handler; engine owns the subscription lifecycle + durable last-acknowledged cursor.
- **Option γ — `Activity.folded(name, stateSchema, sourceSchema)(seed, step)`** — Activity declares a fold over a source with durable folded state; restart resumes from last folded value rather than re-folding from stream beginning.

Under Option β, the runtime-context body could become two declarative `Activity.subscribed` registrations + per-event handlers — no `Stream.zipLatest` in the body itself. Under Option γ, the body could be a single `Activity.folded` evaluated incrementally with restart-resumes-from-state semantics.

**This SDD deliberately does NOT use that freedom.** Three reasons:

1. **Scope discipline.** The current collapse is already a ~2400-line deletion against an existing engine surface. Bolting on "redesign Activity" makes the SDD un-reviewable and the implementation riskier.
2. **Independent acceptance.** The current SDD's acceptance criteria don't need Activity changes to be falsifiable. The Activity-rethink has its own set of tests and benchmarks (specifically: how much replay-cost we pay today on a stream-zip body, and whether per-event idempotency-key infrastructure makes cursor-tracked-not-replayed semantics meaningfully cheaper).
3. **Real options to evaluate.** α / β / γ have different tradeoffs. Picking among them needs measurement, not first-principles argument.

A future SDD (`SDD_FIREGRID_STREAM_NATIVE_ACTIVITY_PRIMITIVES.md` or similar) should design that rethink as an ADDITIVE engine surface — old `Activity.make(...)` keeps working unchanged for terminal-value uses; new shapes (α/β/γ pick) land alongside.

The current SDD's collapse is **independently valuable and shippable on today's engine surface**. The Activity-rethink is a follow-on simplification that the substrate collapse paves the way for, not a prerequisite.

## What this DOES NOT remove

- The typed observation streams (`RuntimeAgentOutputEvents`, `RuntimeAgentOutputAfterEvents`, `RuntimeRuns`, etc.) are KEPT. They are the substrate the Activity subscribes to. The `RuntimeWaitStreams` capability hub stays as the named-typed-stream registry, just consumed by the WaitForWorkflow Activity directly instead of by the wait-router.
- The runtime-context workflow itself stays. Its body restructures.
- The engine itself stays unchanged.
- Permission flow stays — but the workflow body now consumes permission-response rows from its input stream as ordinary events, not via a separate `awaitPermissionResponseInput` deferred-poll path.

## The source-as-offset principle

`Stream.runHead`'s starting offset is **not separately captured or persisted**. It's encoded in the source identity itself. Today's `RuntimeWaitStreams.agentOutputAfter` source is `{_tag: "AgentOutputAfter", contextId, activityAttempt, afterSequence}` — the `afterSequence` is part of the source TYPE, not a runtime cursor. CallerFact sources scope by contextId predicate. The stream subscription is `subscribeChanges({includeInitialState: true})` reading from the table beginning every time.

Replay determinism follows from:

1. **Same source + same trigger** = same set of matching rows in the durable table
2. **Append-only durable table** = no deletions that shift the head row
3. `Stream.runHead` over `Stream.filter(trigger)` returns the FIRST matching row deterministically

Concretely: the Activity re-runs on restart (if no result row was written), re-subscribes from table beginning, trigger predicate filters, returns the same first match. "Gap" rows that arrived between Activity start and crash don't change the answer — the first match was earlier than the gap by construction.

"From now onwards" semantics belong at the **trigger-design layer**, not the substrate. If a channel author wants "next event from now," the trigger predicate must encode it (e.g., `sequence > N` with N fixed at workflow-start, or `acceptedAt > T`). The substrate does not owe a separate offset machinery; the trigger is the right place for it. For the runtime-context body, `afterSequence` IS that filter, baked into the source.

This is the load-bearing property the collapse rests on — the same property `WaitFor.match` + wait-router rely on today.

## `raceAll` losing-branch crash-coverage — inherited, not new

The race form (`DurableDeferred.raceAll([matchSide, timeoutSide])`) is **identical to the existing `wait-for.ts:386-410` usage**. Whatever crash-coverage state PR #315's reconcile work ratified (or whatever residual gaps remain) carries forward unchanged. The collapse doesn't close any open raceAll gaps, but it also doesn't open new ones.

What does change positively: the losing-branch failure modes are cleaner. Under the collapse:
- If the Activity (match-side) wins, the DurableClock wakeup remains scheduled, fires later, no-ops because the race is already resolved.
- If the DurableClock (timeout-side) wins, the Activity remains running, completes whenever, return value discarded because the race is already resolved.

No wait-router fiber lifecycle to reason about. No wait-row status-flip ceremony. No dispatch-time re-check. The race-deferred itself owns the resolution; losing branches are just no-ops at completion.

If PR #315's residual gaps remain open, they're a separate TFIND; orthogonal to this SDD.

## Nested workflow vs inlined `DurableDeferred` — deliberate choice with named tradeoff

`WaitForWorkflow` is a nested workflow execution (each agent-tool `wait_for` call → its own `engine.execute(WaitForWorkflow, ...)`) rather than an inlined `DurableDeferred.raceAll` inside the parent runtime-context body. The peer-review-style tradeoff:

- **Inlined**: cheaper (no engine round-trip per wait_for). Couples wait state to parent's replay history.
- **Nested**: clean execution boundary (own ID, own replay scope, own observability). Adds engine round-trip per wait_for.

This SDD picks **nested**, deliberately, for three reasons specific to Firegrid:

1. The parent body (runtime-context body) is itself a stream-fold under this SDD. Interleaving engine-deferred state into a stream-fold's replay reintroduces the substrate divergence we're collapsing. Inlining would defeat the SDD's core premise.
2. Each wait_for has independent logical identity — cancellation, status query, observability, and the agent's own reasoning about in-flight waits all benefit from each being a first-class execution.
3. wait_for invocations are infrequent relative to runtime-context body iterations (per-tool-call vs per-row). The round-trip cost is bounded and acceptable.

The cost is real but named. Future profiling could surface it; if so, the alternative (inlined in a NON-stream-fold parent body) would be a different architectural era anyway.

## Open questions

1. **Verify the source-as-offset principle holds for all current `wait_for` callers via the restart-replay sim** (acceptance #6 above). Specifically: a crash during the WaitForWorkflow Activity's subscribe-and-runHead must reproduce the same matched row on resume. This is theoretical-from-source today; the sim confirms it empirically.
2. **Predicate-evaluation parent-link semantics.** Today `wait-router.ts:completeMatchSpanOptions` carries the row's `_otel` as parent of the completion span. Under the converged shape, the Activity's span IS the consumer of the row; the parent-link is naturally the Activity's invocation span. Check that the row-otel propagation comments in `wait-router.ts:38-63` translate cleanly into the Activity body's span attributes.
3. **Wait observability under the converged shape.** Today's wait-row writes ARE the host-visible "which waits are active" surface. Under the converged shape, that becomes "which `wait_for` workflows are currently executing on the engine." The engine has entity-introspection (per `ClusterWorkflowEngine.ts`); equivalent must exist on `DurableStreamsWorkflowEngine`. Audit + extend if needed.
4. **Permission-flow consumption by the runtime-context body.** Today: `awaitPermissionResponseInput` deferred-polls. Under converged shape: the input stream zip naturally surfaces permission-response rows alongside prompts and tool-results; the per-event handler branches on `_tag`. Verify this composes correctly with the existing `RuntimeContextWorkflowSession.send` semantics.

## Sequencing

The collapse lands in this order. Each step has a clear test it must keep green:

1. **Migrate test sync helper.** Land `waitUntilWorkflowStarted` (Lane 1 already wrote it in tf-qoyg's working tree) into the production test helper module. Update the 5 currently-hanging tests to use it under the CURRENT (pre-collapse) workflow body. They should pass — this is a pure test refactor.
2. **Introduce `WaitForWorkflow`.** Add the new file; do not yet wire it into `tool-use-to-effect.ts`. Add tests for the workflow's behavior (match-side returns first row; timeout-side fires DurableClock; race resolves correctly; restart-replay works).
3. **Cut over the agent-tool surface.** Switch `tool-use-to-effect.ts:216` to `engine.execute(WaitForWorkflow, ...)`. Run `wait-pre-attach-roundtrip` + dark-factory; CallerFact path span shape changes but functional outcome preserved.
4. **Cut over the runtime-context body.** Restructure to stream-zip + handler. Delete per-row deferreds, WaitFor.match call, completedRuntimeInput, awaitPermissionResponseInput.
5. **Delete `durable-tools/`.** Once no callers remain. Clean removal — no compat shims.
6. **Body-plan Slice A.** `tf-lawq` (ChannelRegistry + opaque ChannelTarget) becomes implementable; sits on top of the one-substrate model.

Each step is independently shippable. Step 1 unblocks tests. Step 2 lands a new isolated workflow with its own tests. Step 3 cuts the agent-tool surface over but preserves observability. Step 4 is the big runtime-context body restructure. Step 5 is cleanup. Step 6 unblocks the body-plan migration.

Estimated total: ~5-6 PRs, net **-2400 lines** (delete ~2500 + ~400 from runtime-context-workflow-core; add ~80 for WaitForWorkflow + small test-helper additions).

## Cross-references

- `tf-qoyg` (HALTED) — empirical evidence; this SDD subsumes its scope.
- `tf-auuv` (was: deferred-input rewrite) — this SDD supersedes. Old bead reframes as "implement this SDD."
- `tf-9ut` — substrate baseline.
- `docs/research/durable-tools-vs-workflow-engine-convergence.md` — the convergence doc this SDD operationalizes more aggressively than its lines 84-89 sketched.
- `SDD_FIREGRID_AGENT_BODY_PLAN.md` — downstream presentation layer; Slice A depends on this SDD landing.
- `SDD_CHOREOGRAPHY_FACADE.md` — overlaps; this SDD's WaitForWorkflow IS what the choreography facade's `wait_for` should compile to.

## Honest framing

The architectural insight that justifies this SDD's deletion-heavy scope: **the durable-tools wait substrate exists because, at some point, "wait for an observation" was modeled as something distinct from "execute a workflow that completes when an observation arrives."** Those are the same thing under the workflow engine's primitive set. The distinction never had load-bearing semantics; it had load-bearing complexity.

This isn't a refactor; it's a recognition that the simpler model was paid for the moment Firegrid adopted `DurableStreamsWorkflowEngine` as the engine. The collapse just collects the simplification.
