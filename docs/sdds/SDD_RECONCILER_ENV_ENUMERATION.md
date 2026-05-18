# SDD: RuntimeControlRequestReconciler env enumeration (TFIND-045)

**Status:** FRAMING DRAFT — architect-gated (Gurdas decides §0). No
production code in scope until §0 is decided. Surfaced by the TFIND-005
halt rule during #326 verify; co-gates #326 flip with TFIND-044.

**Finding:** `RuntimeControlRequestReconcilerEnvironment`
(`packages/host-sdk/src/host/control-request-reconciler.ts:42-46`) omits
`RuntimeOutputTable` and `HostRuntimeContextExecutionEnv`, which
`reconcileStartRequest` (`:211`) transitively requires via
`startRuntime()` → `RuntimeContextEngineRegistry`. A genuine
missing-dependency the TFIND-005 `any` was masking via Crux-B false
equivalence (`RuntimeOutputTable` ≈ `RuntimeControlPlaneTable` while
identities were `any`). TFIND-028 class; controlled experiment proved
**not** #326 branch scope-creep.

---

## §0 — The load-bearing question (read this first)

**Should `RuntimeControlRequestReconcilerEnvironment` explicitly
*enumerate* the transitively-required tags it currently omits
(`RuntimeOutputTable` + `HostRuntimeContextExecutionEnv`), or should
`reconcileStartRequest` *restructure* so it no longer leaks them into
its declared environment (provide-at-call-boundary / a different env
shape so `startRuntime`'s deps are discharged before they reach the
reconciler's contract)?**

Sub-question, equally load-bearing (coordinator-requested): **is
TFIND-045 the same shape as TFIND-029 (`#328`,
`RuntimeStartCapabilityLive` explicit workflow-support enumeration) and
should they be co-resolved, or kept separate?** §3 assesses this and
recommends; it interacts with a **sequencing deadlock** that constrains
the answer (§4 — this is the most important downstream consequence).

This is framing, not implementation: the choice sets the declared
dependency contract of a host-sdk service and decides whether two
findings share one resolution. It does not need code to answer — the
transitive path is fully traced below from existing `file:line`.

### Coordinator recommendation (Gurdas decides)

**Enumerate (minimal, independent), and treat TFIND-045 as the same
*family* as TFIND-029 but resolve it *independently and first* — not
co-merged, not deferred to #328.** Forced by §4's deadlock: deferring
TFIND-045's resolution into #328 cannot work because #328 is itself
gated behind #326, and TFIND-045 co-gates #326's flip. The minimal
explicit enumeration on the reconciler alias is the smallest correct
fix that breaks the deadlock; TFIND-029's later producer-side
restructure may make the enumeration redundant/cleaner, which §3 frames
as a planned reconciliation, not a conflict. Restructure-instead-of-
enumerate is laid out as the alternative and is Gurdas's to choose.

---

## §1 — The transitive path (traced, exact file:line)

`packages/host-sdk/src/host/control-request-reconciler.ts`:

- `:42-46` — declared alias:
  `RuntimeControlRequestReconcilerEnvironment = CurrentHostSession |
  RuntimeControlPlaneTable | RuntimeContextEngineRegistry |
  AgentToolHost`. **Omits** `RuntimeOutputTable` and
  `HostRuntimeContextExecutionEnv`.
- `:15` `import { startRuntime } from "./commands.ts"`.
- `:207` `reconcileStartRequest(...)`, declared (`:210`) to return
  `Effect.Effect<void, unknown, RuntimeControlRequestReconcilerEnvironment>`.
- `:223` `const result = yield* startRuntime({ contextId: ... })`.

`packages/host-sdk/src/host/commands.ts`:

- `:129` `export const startRuntime = (...)`.
- `:156` `const captured = yield* Effect.context<HostRuntimeContextExecutionEnv>()`
  → requires `HostRuntimeContextExecutionEnv` (imported `:43` from
  `./runtime-substrate.ts`).
- `:144`/`:159` `yield* RuntimeContextEngineRegistry`.

`packages/host-sdk/src/host/runtime-context-engine-registry.ts`:

- `:53-55` `RuntimeContextEngineRegistry` tag.
- `:65-76` `provideActiveEngine` provides `WorkflowEngine` +
  `WorkflowEngineTable`; the claimed-context engine path transitively
  needs `RuntimeOutputTable` (this is exactly the runtime gap TFIND-028
  fixed at the capability layer — see §3).

So `reconcileStartRequest`'s **actual** requirement is
`RuntimeControlRequestReconcilerEnvironment ∪ { HostRuntimeContextExecutionEnv,
RuntimeOutputTable }`. The alias under-declares it.

## §2 — Why it compiled before, and the verbatim failure

Pre-curry, `RuntimeOutputTable`'s tag identity was `any`, so it was
mutually assignable with `RuntimeControlPlaneTable` (TFIND-005 Crux B's
false equivalence). The declared alias's `RuntimeControlPlaneTable`
spuriously "absorbed" the omitted `RuntimeOutputTable` requirement and
the `any` discharged `HostRuntimeContextExecutionEnv`. TFIND-005's curry
makes identities precise, exposing the genuine leak.

**Verbatim (curried shape, #326 `15af74c4e`):**

```
packages/host-sdk/src/host/control-request-reconciler.ts(211,3): error
TS2375: Type 'Effect<void, unknown, AgentToolHost |
HostRuntimeContextExecutionEnv | RuntimeContextEngineRegistry>' is not
assignable to type 'Effect<void, unknown,
RuntimeControlRequestReconcilerEnvironment>' with
'exactOptionalPropertyTypes: true'.
  Type 'RuntimeOutputTable' is not assignable to type
  'RuntimeControlPlaneTable'.
```

The `RuntimeOutputTable` → `RuntimeControlPlaneTable` mismatch in the
error chain *is* Crux B closing as designed. Controlled experiment
(recorded in FINDINGS TFIND-045): the error persists identically with
#326's host-sdk/runtime fallout hunks reverted to origin/main, and
`control-request-reconciler.ts` is unmodified by #326 → this is a
pre-existing latent leak, not branch scope-creep.

## §3 — TFIND-045 vs TFIND-029 (#328): co-resolve or separate?

Same **family** (explicit dependency enumeration > ambient/implicit
discharge), **different site and mechanism**:

| | TFIND-029 (`#328`, in-progress) | TFIND-045 (this SDD) |
|---|---|---|
| Site | `RuntimeStartCapabilityLive` (the *producer* that runs the workflow) | `RuntimeControlRequestReconcilerEnvironment` alias + `reconcileStartRequest` (the *caller* that invokes `startRuntime`) |
| Defect | ambient full-context capture instead of named workflow-support deps (TFIND-028 fixed the runtime bug by capturing; #328 makes deps explicit) | declared Effect env alias under-enumerates `startRuntime`'s transitive needs |
| Visibility | not consumer-visible; type/lint clean today | fails host-sdk typecheck under the curried shape; co-gates #326 |

**Interaction.** If TFIND-029 restructures the producer so
`startRuntime`/the capability is **self-contained** (provides its own
workflow-support layer rather than leaking `RuntimeOutputTable` /
`HostRuntimeContextExecutionEnv` into callers), then the reconciler's
transitive leak could be **substantially removed at the source**,
making TFIND-045's enumeration redundant or reducible. If TFIND-029
instead only names deps at the capability boundary without
self-containing them, TFIND-045's alias is independently incomplete
regardless.

**Recommendation:** **same family, sequenced — not co-merged.** Resolve
TFIND-045 *first and minimally* (enumerate the two omitted tags in the
alias, the smallest correct contract fix), explicitly noting it may be
simplified once TFIND-029 lands. Do **not** fold TFIND-045 into #328 —
§4 shows that deadlocks. Co-resolution as a *single* change is rejected:
different layers, different gates, and TFIND-045 is on #326's critical
path while TFIND-029 is behind it.

## §4 — Sequencing deadlock (the load-bearing downstream consequence)

This constrains §0 and must be surfaced explicitly:

- TFIND-045 **co-gates #326's flip** (flamecast/host-sdk cannot be
  CI-red; `pnpm --recursive run typecheck` includes host-sdk, and the
  reconciler TS2375 appears there once #326's curry lands).
- TFIND-029 (`#328`) and the TFIND-007-step2 cascade are **gated *on*
  #326** (canonical FINDINGS: "#326 merge unblocks the TFIND-007-step2
  + TFIND-029 (#328) cascade"; "remain GATED on #326").

Therefore **TFIND-045 cannot be deferred to #328**: #328 waits for
#326, #326 waits for TFIND-045. Deferral = deadlock; #326 could never
flip. TFIND-045 must be resolvable **independently of and before** #326
flip. This is the decisive reason the recommendation favors the minimal
independent enumeration over a restructure that piggybacks on #328.
(A reconciler-local restructure that does not depend on #328 is still
admissible under §0's "restructure" arm — what is inadmissible is any
resolution whose landing depends on #326 being merged.)

## §5 — Secondary / mechanical questions (after §0)

1. If enumerate: add `RuntimeOutputTable` + `HostRuntimeContextExecutionEnv`
   to the `:42-46` alias — confirm via the curried-shape typecheck that
   these two are the *complete* omitted set (no third transitive tag
   hidden behind the same `any`); re-run the recursive typecheck as the
   oracle, not inspection alone.
2. If restructure: which boundary discharges `startRuntime`'s deps
   (provide-at-`reconcileStartRequest` vs a narrowed `startRuntime`
   surface) without depending on #328.
3. Verify no *other* host-sdk consumer of the alias relies on its
   current (incomplete) shape such that enumeration widens their
   requirement unexpectedly — if so, that is a follow-on finding, not
   silent scope.
4. Post-#328: file the planned reconciliation (does TFIND-029's
   producer self-containment let the TFIND-045 enumeration be reverted
   to a tighter alias?).

## §6 — Non-goals

- No forcing/widening cast at the reconciler call site (the TFIND-005
  halt-rule discipline that surfaced this).
- No re-introduction of `any` to re-collapse the identities.
- Not changing #326's strict scope (TFIND-045 is explicitly *not* #326
  fix scope; #326 stays the mechanical curried-idiom migration).
- TFIND-044 is a distinct mechanism (provider generic type shape) —
  amended into `docs/proposals/SDD_DURABLE_TABLE_REACT_LIVE_QUERY.md`,
  not here.
