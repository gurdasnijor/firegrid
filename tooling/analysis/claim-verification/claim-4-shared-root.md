# Claim 4 — The cycle and inline composition share a root mechanism

## Claim & test (restated)

HYPOTHESIS: the `RuntimeToolUseExecutorLive` ↔
`runtimeContextWorkflowSupportLayer` cycle and the inline `WorkflowEngine`
composition are NOT independent — they share an underlying cause. TEST:
does either cycle layer compose the inline `WorkflowEngine`? through how
many hops? are the interventions coupled or independent?

## The dependency path (cited)

**1. `runtimeContextWorkflowSupportLayer` *is* the inline composition (0
hops, same expression).** `packages/host-sdk/src/host/runtime-context-workflow-support.ts:43-53`:

```
RuntimeContextWorkflowNativeLayer.pipe(
  Layer.provideMerge(HostRuntimeObservationSubstrateLive),                        // :44
  Layer.provideMerge(RuntimeToolUseExecutorLive.pipe(                             // :46  cycle layer
    Layer.provide(HostRuntimeObservationSubstrateLive))),                         // :47
  Layer.provideMerge(Layer.succeed(WorkflowEngine.WorkflowEngine, handle.engine)), // :50  inline
  Layer.provideMerge(Layer.succeed(WorkflowEngineTable, handle.table)),            // :51
  Layer.provideMerge(Layer.succeed(AgentToolHost, agentToolHost)),                 // :52
)
```

The cycle layer and the inline `WorkflowEngine` supply are the **same
`.pipe` expression** — `RuntimeToolUseExecutorLive` at `:46` alongside
`Layer.succeed(WorkflowEngine.WorkflowEngine, handle.engine)` at `:50`.
The identical pattern recurs at `toolkit-layer.ts:111-116`.

**2. `RuntimeToolUseExecutorLive` consumes `WorkflowEngine` (the reason
for the inline supply).** `packages/host-sdk/src/host/runtime-substrate.ts:98-99`:
the executor's `execute` body does
`const currentEngine = yield* WorkflowEngine.WorkflowEngine` /
`WorkflowEngine.WorkflowInstance` (verified — see also the
`Effect.provideService(WorkflowEngine.WorkflowEngine, currentEngine)`
re-provision at `runtime-substrate.ts:113`). `RuntimeContextWorkflowNativeLayer`
is another consumer (`runtime-context-workflow-core.ts:455`,
`yield* WorkflowEngine.WorkflowEngine`). The inline
`Layer.succeed(...handle.engine)` at `:50` is precisely what discharges
that requirement for both.

**3. The genuine edge and the inline supply have one documented root.**
The header comment `runtime-context-workflow-support.ts:17-38` (TFIND-031
Option Y) states the defect — the executor's own `DurableWait*` RIn
"flowed out as an unsatisfiable support-layer RIn (the layer required
what it provided)" — and the fix,
`Layer.provide(HostRuntimeObservationSubstrateLive)` at `:47`, sits in
the *same* composition that supplies the inline engine at `:50`. Both
stem from one substrate decision, attested in-source and mirrored at
`runtime-substrate.ts:42-71` and `toolkit-layer.ts:101-110`: **the
workflow engine is a per-execution runtime `handle.engine` value, not a
static buildable layer, supplied via `Layer.succeed(...)` inside an
execution-scoped support layer that also captures `DurableWait*` via
`Effect.context<…>()` deferred-execution seams.**

## Are the interventions coupled?

Yes. The inline `Layer.succeed` exists *because* `WorkflowEngine` is a
runtime handle, not a composable layer (so it cannot be a normal
`Layer.provide`d dependency). The require-what-it-provides edge exists
*because* that same execution-scoped support boundary must self-contain
`HostRuntimeObservationSubstrateLive`, which the executor both consumes
and is downstream of. A single architectural intervention — making the
workflow engine + observation substrate a proper composable layer rather
than a per-execution handle injected per execution-scope — would dissolve
both the `Layer.succeed` inlining and the require-what-it-provides edge
simultaneously. They are co-located in the same `.pipe` expression and
documented under the same TFIND-031 Option-Y rationale.

## Verdict

`runtimeContextWorkflowSupportLayer` does not merely depend on the inline
composition — it *is* the inline composition (same expression, `:46`
alongside `:50`), and `RuntimeToolUseExecutorLive` is the
requirement-consumer the inline supply discharges. The
require-what-it-provides edge and the `Layer.succeed(WorkflowEngine,
handle.engine)` inlining are both consequences of treating the workflow
engine as a per-execution runtime handle wrapped in an execution-scoped
support layer (TFIND-031 Option Y); a single substrate-level
intervention addresses both.

> Cross-claim note (not a reframing): Claims 1 and 4 independently found
> that the "`RuntimeToolUseExecutorLive` ↔ `runtimeContextWorkflowSupportLayer`"
> label is imprecise — there is no 2-node A↔B Layer cycle; the genuine
> phenomenon is the documented require-what-it-provided self-edge.
> Claim 1's REFUTED concerns the *33-site collective-mechanism*
> hypothesis; this CONFIRMED concerns *shared root* and is decided on
> the concrete dependency path, which holds regardless of the cycle
> naming. Both verdicts stand on their own pre-stated criteria.

VERDICT: CONFIRMED
