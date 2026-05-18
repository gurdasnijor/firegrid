# SDD: TFIND-031 DurableWait substrate ownership (architectural fork)

Status: draft — FRAMING-GATED. Autonomous work STOPPED here per dispatch
discipline ("if it turns out architectural, stop and SDD + framing-gate").
No further production code until coordinator review + Gurdas signoff.

Parent: TFIND-031 root provision (single-root diagnosis). Branch:
`sidecar/durable-tag-provision`. Verified against `origin/main`
`078a384ec` with #326's curry diff transiently overlaid (the only way
the leaks are observable).

## What is already resolved (contained, NOT part of the fork)

The single-root diagnosis was correct for the **ambient** host tag
family. These are fixed and verified (production src clean for these):

- `client-sdk/src/firegrid.ts` `launch`: `insertLocalRuntimeContext`
  omitted `Effect.provideService(RuntimeControlPlaneTable, control)`
  that the sibling `createOrLoadSession` path already had. `control` is
  in scope (`make`, `const control = yield* RuntimeControlPlaneTable`).
  Pure honest provision; mirrors existing pattern. **Done.**
- Ambient host substrate capture seams (`commands.ts`
  `RuntimeStartCapabilityLive`, `runtime-context-workflow-core.ts`
  `RuntimeContextWorkflowNativeLayer`, `agent-tool-host-live.ts`
  `RuntimeHostAgentToolHostLive`, `toolkit-layer.ts`
  `ToolCallHostEnvironment`): `Effect.context<never>()` → capture the
  genuinely-ambient `HostRuntimeContextExecutionEnv =
  RuntimeControlPlaneTable | RuntimeOutputTable | CurrentHostSession |
  RuntimeHostConfig`. These tags ARE ambiently provided by the canonical
  host layer (`FiregridRuntimeHostLive` via `namespaceScopedLayer` +
  `hostOwnedOutputLayer` + `currentHostSessionLayer`). **Done.**

## The fork — `DurableWait*` substrate ownership

After the contained fixes, **3 production seams still leak** the
durable-wait tag family (`DurableWaitRowLookup`, `DurableWaitRowUpsert`,
`DurableWaitCompletionRowLookup`, `DurableWaitCompletionRowUpsert`):

- `toolkit-layer.ts:215` (tool handlers)
- `agent-tool-host-live.ts:90` (spawnChildContext → child workflow)
- `commands.ts:163` (RuntimeStartCapability → workflow)

Root: these deferred effects genuinely require the 4 `DurableWait*`
tags, but those tags are **neither**:

1. ambiently provided by the canonical public host layer
   `FiregridRuntimeHostWithWorkflowLive` (deliberately — they are
   execution-scoped, materialized per-run via
   `runtimeContextWorkflowSupportLayer` →
   `HostRuntimeObservationSubstrateLive` /
   `HostOwnedDurableToolsWaitForLive`), **nor**
2. fully discharged at the type level by the
   `runtimeContextWorkflowSupportLayer` provide that already wraps
   `executeRuntimeContextWorkflow*` at these seams.

The `any` from `DurableTable.layer` collapsed this entire channel, so
the gap was invisible. With precise `.layer` typing it is real and must
be resolved one of two architecturally-different ways.

### Option X — ambient: host layer owns the durable-wait substrate

Widen `HostRuntimeContextExecutionEnv` to include the 4 `DurableWait*`
tags and capture them ambiently (the originally-attempted broad env).

- Effect: pushes `DurableWait*` into the **RIn of the public exported
  layer** `FiregridRuntimeHostWithWorkflowLive` (host-sdk public API,
  `index.ts:50`). Every consumer — including the 8 host-sdk test files
  and any external caller — must now ambiently provide the durable-wait
  store.
- This is a **public host-composition contract change**: the host layer
  would assert it requires (and callers must provide) the durable-wait
  substrate ambiently, contradicting the current design where it is
  execution-scoped. Rejected unless Gurdas explicitly re-frames the host
  substrate lifecycle.

### Option Y — execution-scoped: support layer self-contains it (recommended)

`DurableWaitStoreLive` exists
(`runtime/src/durable-tools/internal/durable-wait-store.ts:88`,
`Layer.mergeAll` of all 4 tags). Merge it into
`runtimeContextWorkflowSupportLayer` (or
`HostRuntimeObservationSubstrateLive`) so the deferred workflow effects'
`DurableWait*` requirements are discharged **execution-scoped**, where
they are already conceptually owned. The public
`FiregridRuntimeHostWithWorkflowLive` contract is **unchanged**; the 8
test files need no new ambient provision.

- No public boundary change. Smallest blast radius. Matches the existing
  "execution-scoped substrate" design intent.
- **Framing subtlety requiring signoff:** `HostOwnedDurableToolsWaitForLive`
  already builds a host-owned durable-tools wait stream
  (`DurableToolsWaitForLive` over the host-owned `durableTools`
  segment). Adding `DurableWaitStoreLive` must NOT introduce a *second,
  divergent* materialized wait store: the wait-router that wakes
  suspended workflow deferreds and the store that records waits must be
  the **same materialized instance**, or a wait is recorded in one store
  and never observed by the router (silent hang, not a type error).
  Whether `DurableWaitStoreLive` and the host-owned wait stream are
  already the same instance — or must be unified — is the architectural
  question. This is precisely the emit-then-wait correctness bar:
  observation must wake on the caller-owned collection.

## Recommendation

**Option Y**, conditioned on resolving the store-instance-sharing
question. Concretely the framing decision needed from Gurdas:

> Is the durable-wait substrate execution-scoped (owned by the
> per-context workflow support layer) or an ambient host capability? If
> execution-scoped (recommended, matches current design), confirm that
> `DurableWaitStoreLive` and `HostOwnedDurableToolsWaitForLive` resolve
> to one shared materialized wait store so router/recorder cannot
> diverge.

## Verification strategy (once framing signed off)

- Re-apply #326 curry transiently; production src must be 0 errors.
- Test fallout then re-triaged per the existing Cat A/B/C buckets:
  - Cat A (TS2352, `as Layer<never>` masks: `WaitFor.test.ts`,
    `tool-use-to-effect.test.ts`, `runtime-observation-sources.test.ts`)
    — remove the now-false casts.
  - Cat B (TS2379, ~35 across 7 files via
    `FiregridRuntimeHostWithWorkflowLive`) — resolved by Option Y with
    NO test edits if the support layer self-contains `DurableWait*`;
    this is the key reason Y is preferred (X would force 8 test edits +
    a public-contract change).
  - Cat C (TS2769, `react-types.test.ts`) — explicit `createElement`
    type args; provider is generic+correct.
- Full `pnpm turbo run typecheck` + `pnpm run lint` + affected suites +
  tiny-firegrid green. macOS: NO `timeout`.

## Shared-store proof (Option Y correctness gate — STRUCTURAL, discharged)

Gurdas signed off Option Y conditioned on proving the router (waker) and
recorder resolve ONE materialized wait store. Proven from
`runtime/src/durable-tools/DurableToolsWaitFor.ts:38–52`:

1. `DurableWaitStoreLive` (`durable-wait-store.ts:88`) **materializes no
   store**. All 5 services are `Effect.map(DurableToolsTable, …)` — pure
   adapters over whichever `DurableToolsTable` is in scope. So
   "which store" ≡ "which `DurableToolsTable`".
2. `DurableToolsWaitForLive` invokes `DurableToolsTable.layer(...)`
   exactly once → single `durableToolsTableLive`.
3. One `durableToolsCapabilities = DurableWaitStoreLive` reference is
   used in BOTH `Layer.provide(durableToolsCapabilities)` (into
   `WaitRouterLive`, the waker) AND
   `Layer.provideMerge(durableToolsCapabilities)` (exposed recorder
   tags), and both are closed over the same single `durableToolsTableLive`
   via the trailing `Layer.provideMerge(durableToolsTableLive)`.
4. Effect Layer memoization within a single build ⇒ waker and recorder
   resolve the **same** materialized `DurableToolsTable` ⇒ one store.

Therefore a divergent store is **structurally impossible** within
`DurableToolsWaitForLive`; `HostOwnedDurableToolsWaitForLive` wraps
exactly this composition and inherits the guarantee. Merging /
exposing `DurableWaitStoreLive` through the execution-scoped support
layer cannot introduce a second store because `DurableWaitStoreLive`
has no store of its own. The emit-then-wait hazard is closed at the
source, not by convention. A deterministic record→blocked-pending→
router-wakes test remains the empirical confirmation of this structural
proof and is part of the completion gate.

## Option Y implementation — UNRESOLVED type-threading knot (honest status)

Shared-store gate: PASSED (structural proof above). Contained fixes:
DONE + verified. Option Y *framing*: correct and signed off. But the
concrete type-level threading is **not yet closed**, and I am recording
the exact knot rather than forcing green:

- The 3 seams (`commands.ts:163`, `agent-tool-host-live.ts:90`,
  `toolkit-layer.ts:215`) still leak the 4 `DurableWait*` tags under the
  #326 overlay.
- Structurally, `runtimeContextWorkflowSupportLayer` *should* expose
  `DurableWait*` in ROut: `HostRuntimeObservationSubstrateLive` →
  `HostOwnedDurableToolsWaitForLive` (`Layer.unwrapEffect`) →
  `DurableToolsWaitForLive` ends in
  `routerLive.pipe(Layer.provideMerge(DurableWaitStoreLive),
  Layer.provideMerge(durableToolsTableLive))`, so `DurableWaitStoreLive`'s
  5 tags are in that layer's ROut, and `provideMerge` into
  `RuntimeContextWorkflowNativeLayer` should both discharge the (now
  widened) workflow-capture RIn and re-expose them.
- `RuntimeContextEngineRegistry` methods are contractually `R = never`
  (interface signatures carry no requirements channel), so the leak is
  **not** from the pre-handle `registry.claimActive/reconcile` calls.
- Yet the typechecker still shows `DurableWait*` residual at the seam.
  The mismatch between this structural model and the checker is the
  open knot: most likely a `Layer.unwrapEffect` ROut-erasure or a
  `provideMerge` variance subtlety where `DurableWait*` is consumed as
  RIn but not re-surfaced as ROut through the `unwrapEffect` boundary.

This is **not** a new architectural fork (the design — execution-scoped,
single shared store — is sound and proven). It is a focused Effect
Layer-variance / `unwrapEffect`-ROut investigation. It needs either a
fresh focused pass or a second set of eyes; continuing to iterate solo
was thrashing. WIP (the widened `RuntimeContextWorkflowExecutionEnv` +
workflow-core capture) is committed so the investigation has a concrete
starting point.

Not done (blocked on the knot above): the deterministic
record→blocked-pending→wake test, Cat A/B/C fallout, full verification,
#331 ready-flip, #326 rebase.

## Knot RESOLVED to a precise mechanism (decisive probe)

In-project type probe of `ReturnType<typeof runtimeContextWorkflowSupportLayer>`:

- `DurableWait*` (all 4) **ARE** in the support layer's **ROut** (it
  does expose them).
- `DurableWait*` **ARE ALSO** in the support layer's **RIn** (it still
  *requires* them as input).

Mechanism: `runtimeContextWorkflowSupportLayer` **requires what it
provides**. `Effect.provide(effect, supportLayer)` yields effect-R =
`(effect.R \ supportLayer.ROut) ∪ supportLayer.RIn`. Because
`supportLayer.RIn ⊇ DurableWait*`, every consumer
(`executeRuntimeContextWorkflowForContextId` → `claimAndRun…` → the 3
seams) inherits an unsatisfied `DurableWait*` requirement **no matter
what the capture seam declares** — which is why both the narrowed and
widened capture variants leaked identically.

So the fix target is NOT the capture seams and NOT the public host
layer. It is: **make `runtimeContextWorkflowSupportLayer` self-contained
for `DurableWait*`** — i.e., its internal composition must `Layer.provide`
the durable-wait store such that `DurableWait*` leaves RIn (stays in
ROut). The internal cause is a `provideMerge`/`unwrapEffect` ordering
inside the `RuntimeContextWorkflowNativeLayer.pipe(Layer.provideMerge(
HostRuntimeObservationSubstrateLive), …)` chain where a consumer's
`DurableWait*` RIn is re-surfaced rather than discharged before
exposure. This is the exact, bounded next step — correctness-sensitive
(wait routing), so it must be done deliberately (and validated by the
deterministic record→blocked→wake test), not by a forcing cast.

Architecture remains sound and unchanged (execution-scoped, single
shared store — proven). This is a layer-composition-order defect, not a
framing fork. Handoff point is precise: re-thread
`runtimeContextWorkflowSupportLayer` to discharge `DurableWait*` from
its own RIn.

## RESOLVED — bounded completion (focused pass)

Status: **DONE**. The knot was exactly as diagnosed: the support layer
required what it provided. Precise sub-mechanism (found by in-project
type probe under the #326 overlay): the residual `DurableWait*` RIn was
NOT re-surfaced by `HostRuntimeObservationSubstrateLive` (proven clean:
ROut ⊇ all 4 `DurableWait*`, RIn ∌ any) — it was re-introduced *inside*
`runtimeContextWorkflowSupportLayer` by `RuntimeToolUseExecutorLive`'s
own `Effect.context<…DurableWait*…>()` capture, which was `provideMerge`d
as a sibling of the substrate (so `provideMerge` discharged only the
workflow body's RIn; the executor's identical capture flowed out as an
unsatisfiable support-layer RIn).

Fix (no forcing cast): keep `RuntimeToolUseExecutorLive` `provideMerge`d
into the workflow chain (the workflow handler resolves
`RuntimeToolUseExecutor` from its build-time captured context — a plain
sibling `Layer.merge` silently breaks that wiring) AND additionally
`Layer.provide` the **same** `HostRuntimeObservationSubstrateLive`
reference into `RuntimeToolUseExecutorLive` so its own `DurableWait*` RIn
is discharged. Effect Layer memoization (same reference, one build) ⇒
workflow body, wait-router, and tool executor resolve ONE materialized
`DurableToolsTable` / wait store — the SDD shared-store invariant holds.
`toolCallWorkflowSupportLayer` (toolkit-layer.ts:215) gets the analogous
Option-Y self-containment (single `HostRuntimeObservationSubstrateLive`
provideMerge).

Empirical correctness gate (decisive): a first attempt that used a
sibling `Layer.merge` typechecked (RIn discharged) but BROKE
`TOOL_EXECUTOR_SEAM.2 schedule_me` — the deterministic
record→blocked→wake path — because the workflow handler could no longer
resolve `RuntimeToolUseExecutor`. That regression was caught and rejected
by the emit-then-wait test, NOT forced green; the corrected re-thread
passes it. This is why the structural type proof alone was insufficient
and the deterministic test was mandatory.

Verification (all green):
- 3 fork seams (commands.ts:163, agent-tool-host-live.ts:90,
  toolkit-layer.ts:215) discharged; production src **0 errors** under
  the transient #326 precise-typing overlay; host-sdk tests 0 errors
  under overlay too.
- Cat A: dropped now-false `as Layer<never,unknown,never>` masks in
  `tool-use-to-effect.test.ts`; `runWith` generic over ROut.
- Cat B: hand-rolled test layers in `runtime-context-workflow-core.test.ts`
  now provide the honestly-required `RuntimeHostConfig`. No edits forced
  via `FiregridRuntimeHostWithWorkflowLive` (public contract unchanged).
- Cat C: not triggered in host-sdk; `react-types.test.ts` belongs to
  #326's own diff (mechanical callsite), out of #331 scope.
- Full CI gate on #331 standalone: `lint` + `lint:dead` + `lint:dup` +
  `lint:deps` + `turbo typecheck` (17/17) + `turbo test` (17/17, incl.
  tiny-firegrid; host-sdk 96/96 incl. the deterministic wake path).
- A stray `consistent-type-imports` residue from the env-narrowing WIP
  (runtime-substrate / agent-tool-host-live) was finished as type-only
  imports so the lint gate is clean.

Architecture remains unchanged: execution-scoped, single shared store —
proven structurally AND confirmed empirically. #331 is review-ready;
#326 (the keystone curry) rebases onto main-with-#331 next.
