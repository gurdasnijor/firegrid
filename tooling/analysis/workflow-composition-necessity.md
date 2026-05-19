# Workflow-Composition Necessity Analysis

Pressure-tests each element of the 5-call `.pipe` in
`packages/host-sdk/src/host/runtime-context-workflow-support.ts:39-53`
against **current** (per-context-stream) constraints vs the **former**
(shared-stream) architecture. Classification per element; no refactor
proposals. Every verdict cites `file:line` or `doc:section`. Builds on
the prior claim-verification reports (#373) and does not re-derive them.

## Documentation found

- **`docs/sdds/SDD_TFIND031_DURABLE_WAIT_SUBSTRATE_OWNERSHIP.md`** — the
  canonical TFIND-031 doc. It enumerates exactly **two** alternatives:
  *Option X* (ambient: public host layer owns the durable-wait
  substrate — rejected, §"Option X", lines 60-74) and *Option Y*
  (execution-scoped: the support layer self-contains it — recommended &
  signed off, §"Option Y", lines 76-101; "RESOLVED — bounded
  completion", lines 239-295). No Option Z.
- **Scope correction (load-bearing).** TFIND-031 Option X/Y is *only*
  about **where the `DurableWait*` substrate is owned** (ambient host
  layer vs execution-scoped support layer). It does **not** document the
  "engine as a `Layer.succeed` runtime handle" decision (Element 1). The
  brief's statement that "the architecture documentation calls this
  TFIND-031 Option Y" is a **misattribution**: per the hard constraint I
  state this as a finding rather than reconstruct the engine-handle
  rationale from code as if the SDD covered it.

## Element-by-element verdicts

### Element 1 — Engine as a runtime handle (`Layer.succeed(handle.engine)`)

**Verdict: FORCED (by the per-context-stream architecture itself) —
documentation gap noted.**

Evidence:
- The engine layer is built per context from a **per-context runtime
  value**: `runtime-context-engine-registry.ts:152-160` builds
  `DurableStreamsWorkflowEngine.layer({ streamUrl:
  runtimeContextWorkflowStreamUrl({ baseUrl, namespace, contextId:
  context.contextId }) })`. The stream URL embeds `context.contextId`,
  which is only known per request — not resolvable at layer-build/config
  time.
- The engine layer is itself catalogued and usable directly
  (`packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.ts:33-57`,
  `Layer.scopedContext`, confirmed in claim-verification Claim 2). It is
  built into a per-context `Scope.make()` via `Layer.buildWithScope`
  (`runtime-context-engine-registry.ts:151-161`); the already-resolved
  handle is then injected into the per-execution support layer with
  `Layer.succeed(WorkflowEngine.WorkflowEngine, handle.engine)`
  (`runtime-context-workflow-support.ts:50-51`). `Layer.succeed` of an
  already-resolved value is the ordinary Effect idiom for "I hold the
  value; expose it as a layer" — not an ad-hoc construction.

Current vs former constraint:
- CURRENT (per-context streams): one context = one dedicated stream URL
  (`runtime-context-engine-registry.ts:154-158`). The engine options are
  a per-context runtime value ⇒ the engine **cannot** be a single
  static config-built layer. The handle pattern is forced *by the
  per-context-stream design* — i.e. it is a consequence of the new
  architecture, the opposite of vestigial.
- FORMER (shared stream): a single shared stream ⇒ the engine could
  plausibly have been one static layer from configuration. So the
  handle/`Layer.succeed` shape did **not** exist to serve shared-stream
  coordination; it appeared *because* the migration made the stream URL
  per-context.

Documentation gap: the TFIND-031 SDD does not record this decision; no
Option X/Y/Z covers it. The constraint is evidenced in code
(`runtime-context-engine-registry.ts:154-158`) but the rationale is
**undocumented**. Classified FORCED on the code-level constraint, with
the documentation gap named explicitly.

### Element 2 — Workflow body deferred capture (`Effect.context<>()`)

**Verdict: FORCED (by `@effect/workflow`'s durable-execution model;
architecture-independent).**

Evidence:
- `@effect/workflow` invokes the workflow body **deferred**. The library
  surface: `repos/effect/packages/workflow/src/Workflow.ts:148-161` —
  `toLayer<R>(execute)` takes an `execute(payload, executionId)`
  callback whose requirements `R` become the *layer's* requirements; the
  engine calls `execute` at workflow-execution time, which for a durable
  engine may be after suspend/resume or across a process restart.
- Firegrid registers the body via the equivalent `engine.register`
  path: `runtime-context-workflow-core.ts:453-468` —
  `RuntimeContextWorkflowNativeLayer = Layer.scopedDiscard(Effect.gen(…
  const captured = yield* Effect.context<RuntimeContextWorkflowExecutionEnv>();
  yield* engine.register(RuntimeContextWorkflowNative, ({contextId}) =>
  runWorkflowNativeRuntimeContext(contextId).pipe(Effect.provide(captured)))))`.
  In-source rationale (`runtime-context-workflow-core.ts:456-461`): "the
  deferred handler runs later, outside this gen, so it must re-provide
  the captured substrate." The body cannot resolve deps from a live call
  stack that no longer exists after a durable suspend.
- Empirical confirmation in the SDD
  (`SDD_TFIND031_DURABLE_WAIT_SUBSTRATE_OWNERSHIP.md:265-272`): a first
  attempt using a non-deferred sibling `Layer.merge` typechecked but
  **broke** the deterministic `schedule_me` record→blocked→wake path
  "because the workflow handler could no longer resolve
  `RuntimeToolUseExecutor`." Deferred capture is load-bearing, proven by
  a runtime regression, not asserted.

Current vs former constraint: identical. A durable workflow engine runs
the body deferred regardless of how many streams exist. Not a
shared-stream artifact.

### Element 3 — Tool-use executor deferred capture (`Effect.context<>()`)

**Verdict: FORCED (same `@effect/workflow` deferred model). The brief's
"strongest vestigial candidate" is refuted by source + the SDD's
empirical gate.**

Evidence:
- `RuntimeToolUseExecutorLive` (`runtime-substrate.ts:91-94`) is
  `Layer.effect(RuntimeToolUseExecutor, Effect.gen(… const captured =
  yield* Effect.context<RuntimeToolUseExecutorHostEnvironment>() …))`;
  its `execute` (`runtime-substrate.ts:96-114`) re-provides `captured`
  and runs `toolUseToEffect`. The executor is resolved **by the deferred
  workflow body** (`runtime-context-workflow-core.ts` handler;
  `runtime-context-workflow-support.ts:46` provideMerge of the executor
  into the workflow chain), so it must, like the body, carry its
  dependencies from build time into the deferred invocation.
- The in-source rationale (`runtime-substrate.ts:42-65`) attributes the
  capture to **precise-typing honesty** ("`never` was only ever sound
  because `DurableTable.layer` leaked `any` and collapsed the
  requirements channel"), not to dispatch/routing coordination.
- The brief's hypothesis — that the executor deferred-captured to defer
  resolution until *shared-stream workflow-dispatch routing* time —
  finds **no supporting evidence**: there is no routing/dispatch
  coordination in `runtime-substrate.ts` or the support layer; the only
  documented reason is the deferred workflow-body model and precise
  typing. The SDD's empirical gate
  (`SDD_TFIND031_DURABLE_WAIT_SUBSTRATE_OWNERSHIP.md:265-272`) shows the
  deferred executor wiring is what makes the deterministic wake path
  pass.

Current vs former constraint: identical (deferred workflow-body model).
The executor's deferred capture is **not** a shared-stream coordination
remnant.

### Element 4 — `HostRuntimeObservationSubstrateLive` provided twice

**Verdict: FORCED (a necessary consequence of Elements 2 & 3, which are
themselves FORCED). Memoization claim verified.**

Evidence:
- The dual provide is the Option Y fix itself
  (`SDD_TFIND031_DURABLE_WAIT_SUBSTRATE_OWNERSHIP.md:246-263`): the
  workflow body **and** the executor *each independently*
  `Effect.context`-capture the `DurableWait*` family, so the executor's
  own RIn must be discharged separately —
  `provideMerge(HostRuntimeObservationSubstrateLive)` into the workflow
  chain (so the body resolves the executor at deferred time) **and**
  `Layer.provide(`*the same reference* `HostRuntimeObservationSubstrateLive)`
  into `RuntimeToolUseExecutorLive`
  (`runtime-context-workflow-support.ts:44,46-47`).
- The brief's hypothesis ("duplication is a downstream consequence of
  the executor's deferred capture; if the executor weren't deferred it
  would dissolve") is **structurally correct** — but since Element 3 is
  FORCED, the duplication is FORCED too, not symptomatic of vestigial
  complexity.
- Memoization claim verified two ways: (1) the SDD's structural
  shared-store proof
  (`SDD_TFIND031_DURABLE_WAIT_SUBSTRATE_OWNERSHIP.md:132-161`, esp.
  150-151: "Effect Layer memoization within a single build ⇒ waker and
  recorder resolve the same materialized `DurableToolsTable`"), and (2)
  it relies on the *same `HostRuntimeObservationSubstrateLive`
  reference* being passed both places
  (`runtime-context-workflow-support.ts:44` and `:47`) — standard
  Effect.Layer build-memoization is keyed by layer reference within one
  build, so one materialized store results. The "Effect memoization
  deduplicates" defense is accurate for this usage.

### Element 5 — Per-execution scope vs per-context scope

**Call frequency under current usage:** `runtimeContextWorkflowSupportLayer`
is built **once per `claimAndRunRuntimeContextWorkflow` invocation**
(`commands.ts:78-80`). Callers of `claimAndRunRuntimeContextWorkflow`:
`startRuntime` (`commands.ts:146`), `RuntimeStartCapability.start`
(`commands.ts:169`), and the child-context spawn at
`agent-tool-host-live.ts:202`. So it is "once per context-workflow
start / resume / child-spawn", **not** a fixed once-per-context.

**Verdict: MIXED.**

Forced part — the per-execution layer build is doing real work:
`claimAndRunRuntimeContextWorkflow` wraps the execution in
`Effect.ensuring(registry.deregister(context.contextId))`
(`commands.ts:80`; `deregister → closeActiveEngine`,
`runtime-context-engine-registry.ts:230`). The engine + its stream scope
are acquired (`claimActive` → `Scope.make()` + `Layer.buildWithScope`,
`runtime-context-engine-registry.ts:151-161`) and **torn down at the end
of every invocation**. So each invocation genuinely acquires and
releases per-execution resources (the engine, its Durable Stream scope);
the per-execution shape is not theatrical — it is the unit at which the
engine lifecycle is managed.

Vestigial part — the per-context **reuse cache** is effectively dead
under the current caller pattern: `claimActive` keeps an
`engines: Ref<Map<contextId, handle>>` and returns an existing handle if
present (`runtime-context-engine-registry.ts:140-142,175`). But because
`commands.ts:80` calls `deregister` in `Effect.ensuring` after *every*
`claimAndRunRuntimeContextWorkflow`, a handle never survives to a
subsequent invocation — the reuse branch only ever dedupes the ~3
`claimActive` calls *within one invocation* (the direct call at
`commands.ts:76` plus `reconcile`'s internal `claimActive` at
`runtime-context-engine-registry.ts:199`). A cross-execution
per-context engine cache is exactly what a long-lived shared-stream
context would need; under per-context streams with deregister-every-
execution it is carried but unreached across executions.

Current vs former constraint: under shared streams a per-context engine
plausibly outlived individual executions (one stream, many multiplexed
workflows), making the reuse cache load-bearing. Under per-context
streams with `Effect.ensuring(deregister)` per invocation
(`commands.ts:80`), the engine lifetime collapses to the execution
lifetime and the reuse cache is unreached — a vestigial-candidate
**within Element 5**, distinct from the per-execution layer build, which
is forced.

## What simplifications are warranted

Per the brief, descriptive only — not how to implement.

- **Elements 1, 2, 3, 4: none.** Each is forced by a current constraint
  (per-context stream URL for 1; `@effect/workflow`'s deferred durable
  body for 2/3; the dual-capture discharge for 4). The composition's
  five calls are not vestigial shared-stream coordination; the
  `provide`-inside-`provideMerge` nesting in particular is the *minimum*
  shape that discharges the executor's independent `DurableWait*` RIn
  while keeping the body able to resolve the executor at deferred time
  (SDD `:246-272`). The brief's anticipated simplification — "if the
  executor weren't a deferred-capture layer, the nested
  provide-inside-provideMerge dissolves to a sibling `Layer.merge`" — is
  exactly the change the SDD tried and **reverted** because it broke the
  deterministic wake path
  (`SDD_TFIND031_DURABLE_WAIT_SUBSTRATE_OWNERSHIP.md:265-272`).
- **Element 5: a narrow simplification is warranted.** If the
  cross-execution per-context engine reuse is genuinely never exercised
  (because `commands.ts:80` deregisters every invocation), the simpler
  shape is: the engine has a single lifetime equal to one
  `claimAndRunRuntimeContextWorkflow` invocation, and the
  `engines: Ref<Map>` reuse cache in `RuntimeContextEngineRegistry`
  (`runtime-context-engine-registry.ts:123,140-142,175`) collapses to a
  build-once-use-thrice-then-deregister within a single invocation — the
  per-context map indirection is removable *iff* no other caller relies
  on cross-execution reuse. Whether such a caller exists is the open
  question below. (No implementation proposed.)

## What this analysis cannot settle

- **Element 5 call frequency per context.** Whether `startRuntime` /
  `RuntimeStartCapability.start` is invoked once per context or many
  times (e.g. once per resume after a durable suspend, or per agent
  turn) cannot be settled from these files alone — it depends on the
  runtime driver / ingress loop that invokes `start`, which is outside
  the cited files. Resolving it requires tracing the runtime-input /
  ingress driver (the `firegrid-workflow-driven-runtime.PHASE_*`
  sequence referenced at `commands.ts:131-135`) or a runtime trace of a
  multi-turn context. Until then, "the per-context reuse cache is
  vestigial" is a **bounded** finding: proven unreached *under the
  `commands.ts` deregister-in-`Effect.ensuring` pattern for the three
  cited callers*, not proven globally.
- **Element 1 rationale.** The engine-handle decision is forced by code
  evidence but **undocumented** (not in the TFIND-031 SDD, no ADR/RFC
  found for it). Whether an alternative (e.g. resolving the per-context
  stream URL via a `Layer.unwrapEffect`/`Effect.gen` indirection instead
  of a registry handle) was considered and rejected cannot be settled —
  no design record exists. Resolving it requires shared-stream-era
  design context from someone who made the call, or an ADR that was not
  found.

## Summary

| Element | Verdict | Forcing constraint (cited) |
|---|---|---|
| 1 Engine as runtime handle | FORCED | per-context stream URL is a runtime value (`runtime-context-engine-registry.ts:154-158`); rationale undocumented |
| 2 Workflow body deferred capture | FORCED | `@effect/workflow` deferred durable body (`Workflow.ts:148-161`; `runtime-context-workflow-core.ts:456-468`; SDD `:265-272`) |
| 3 Executor deferred capture | FORCED | same deferred model; vestigial hypothesis refuted (`runtime-substrate.ts:42-65`; SDD `:246-272`) |
| 4 `HostRuntimeObservationSubstrateLive` ×2 | FORCED | consequence of 2&3; memoization verified (SDD `:132-161`; same ref `runtime-context-workflow-support.ts:44,47`) |
| 5 Per-execution scope | MIXED | per-execution build FORCED (`commands.ts:80` engine lifecycle); per-context reuse cache vestigial-candidate / call-frequency UNCLEAR |

Net: the 5-call composition is **not** vestigial shared-stream
coordination. Four elements are forced by current constraints (the
per-context-stream architecture and `@effect/workflow`'s deferred
durable-execution model); the one mixed element's vestigial part is the
registry's cross-execution engine-reuse cache, not the support-layer
composition itself, and its full classification is bounded by an
undetermined caller frequency.
