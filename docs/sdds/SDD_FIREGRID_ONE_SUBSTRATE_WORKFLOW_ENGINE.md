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

## What this DOES NOT remove

- The typed observation streams (`RuntimeAgentOutputEvents`, `RuntimeAgentOutputAfterEvents`, `RuntimeRuns`, etc.) are KEPT. They are the substrate the Activity subscribes to. The `RuntimeWaitStreams` capability hub stays as the named-typed-stream registry, just consumed by the WaitForWorkflow Activity directly instead of by the wait-router.
- The runtime-context workflow itself stays. Its body restructures.
- The engine itself stays unchanged.
- Permission flow stays — but the workflow body now consumes permission-response rows from its input stream as ordinary events, not via a separate `awaitPermissionResponseInput` deferred-poll path.

## Open questions

1. **`Stream.runHead` inside an Activity body — durability semantics.** On restart with no result row written: the Activity re-runs; the source subscription replays via `subscribeChanges({includeInitialState:true})`; the same first row (if it had arrived) is returned deterministically. On restart with a result row written: engine replays the recorded result without re-execution. Both paths are existing engine behavior. CONFIRM via the restart-replay sim in §6 above.
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
