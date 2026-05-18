# SDD: RuntimeStartCapabilityLive Workflow-Support Dependencies

Status: draft — finding + framing for coordinator signoff, NO production code
Created: 2026-05-17
Owner: Firegrid Host SDK (sidecar `sidecar/runtime-start-deps`)

Resolves: `packages/tiny-firegrid/FINDINGS.md` → TFIND-029
"`RuntimeStartCapabilityLive` should enumerate workflow support dependencies."

Depends on (gating): TFIND-005 "Workflow layer composition leaks type
precision" (open). Relates to TFIND-028 (resolved #325, the runtime fix this
finding follows up).

Related code (verified):

- `packages/host-sdk/src/host/commands.ts` —
  `RuntimeStartCapabilityLive`, `claimAndRunRuntimeContextWorkflow`
- `packages/host-sdk/src/host/runtime-context-workflow-support.ts` —
  `runtimeContextWorkflowSupportLayer`
- `packages/host-sdk/src/host/runtime-substrate.ts` —
  `HostRuntimeObservationSubstrateLive`, `RuntimeToolUseExecutorLive`
  (the in-repo *typed-capture* precedent)

---

## 1. What #325 did (verified from the diff)

#325 (TFIND-028) fixed a runtime failure — `RuntimeStartCapability.start()`
threw on a missing `RuntimeOutputTable` — by adding to
`RuntimeStartCapabilityLive`:

```ts
const captured = yield* Effect.context<never>()
// …
return yield* claimAndRunRuntimeContextWorkflow(context, registry, agentToolHost)
  .pipe(Effect.provide(captured))
```

It captures the **entire ambient `Context`** at layer-construction time and
replays it into the claimed-context workflow run. `startRuntime` (the
non-capability function form) does *not* do this — it leaves the requirement
in its `R` channel for the caller.

TFIND-029 asks: replace the ambient capture with an **explicit enumeration**
of the workflow-support dependencies, *or* document why context capture is
the intended host-capability pattern.

## 2. The decisive finding: there is nothing to enumerate at the type level

The premise of "explicit enumeration" is that
`claimAndRunRuntimeContextWorkflow` (which internally provides
`runtimeContextWorkflowSupportLayer`) has a *nameable residual requirement*.
Two type probes against `origin/main` (host-sdk `tsc --noEmit`, probes since
reverted) show it does not:

| Probe | Result |
|---|---|
| `runtimeContextWorkflowSupportLayer(handle, ath)` assignable to `Layer.Layer<unknown, unknown, never>` | **compiles** — `RIn ⊆ never` |
| `claimAndRunRuntimeContextWorkflow(ctx, reg, ath)` assignable to `Effect.Effect<unknown, unknown, never>` | **compiles** — `R ⊆ never` |

Yet TFIND-028 documents — and #325's commit message states — that this exact
path **fails at runtime** for a missing `RuntimeOutputTable`. The static
contract says "requires nothing"; the runtime requires host-scoped services.

That contradiction is not an oversight in `RuntimeStartCapabilityLive`. It is
the **TFIND-005 precision leak** (`Workflow.toLayer` /
`DurableStreamsWorkflowEngine.layer` / `Layer` pipe inference leaking `any`)
manifesting at this exact composition: the support layer's true `RIn` is
collapsed to `never` through an `any` boundary. `Effect.context<never>()` is
not "lazily under-typed" — `never` is the *only* type the broken contract
admits.

## 3. Consequence: explicit enumeration is gated on TFIND-005

Because the support layer's real `RIn` is type-erased:

- There is **no type-level requirement to surface**. Annotating the capture as
  `Effect.context<SomeNamedUnion>()` (the `RuntimeToolUseExecutorHostEnvironment`
  idiom used by `RuntimeToolUseExecutorLive`) would invent a *phantom*
  requirement on `RuntimeStartCapabilityLive` that is **disconnected** from the
  masked real one. It would not make future support-layer changes fail at the
  type boundary — `runtimeContextWorkflowSupportLayer`'s `RIn` stays `never`
  no matter what services it actually grows to need. It would add a contract
  the compiler cannot police: enumeration theater, not enforcement.
- The ambient `Effect.context<never>()` capture is, **given the leak, the only
  currently-sound mechanism**. It works precisely because it bypasses the
  unsound static contract and replays the real runtime context. Removing or
  "tightening" it without first fixing TFIND-005 reintroduces the TFIND-028
  runtime failure or ships a contract that lies.

This is the same gating shape the Host Surface SDD (TFIND-007) hit: its
step 2 (pin the factory `ROut`) was **blocked on the same `any`-leak**
("Finding 3"). TFIND-029's enforceable enumeration is the analogous step 2,
blocked on TFIND-005.

## 4. Recommendation (smallest safe down-payment)

Resolve TFIND-029 as **"context capture is intended *until* TFIND-005"**, with
a tracked dependent — do **not** ship phantom enumeration:

1. **No production code in this PR.** Document the rationale at the capture
   site (a comment referencing TFIND-005/TFIND-029 explaining the capture is
   the sound mechanism while the support-layer `RIn` is `any`-collapsed) — a
   ~3-line comment is the only candidate code change, deferred to coordinator
   call (it borders on noise vs. the SDD record).
2. **Enforceable enumeration is the dependent of TFIND-005.** When TFIND-005
   un-erases the workflow-support `RIn`, `RuntimeStartCapabilityLive` adopts
   the existing `Effect.context<ExplicitUnion>()` idiom
   (`RuntimeToolUseExecutorHostEnvironment` precedent) — and *then* the
   enumeration is real, because the support layer's `RIn` is no longer
   `never`. Sequenced, not bridged.

The narrow question for the coordinator: **accept this resolution (TFIND-029 →
gated-on-TFIND-005, SDD-recorded, no code), or do you want the inline
rationale comment landed now?** No production code until that call.

## 5. Adjacent findings (coordinator → FINDINGS.md, not this PR)

- `RuntimeToolUseExecutorLive` (`runtime-substrate.ts`) uses
  `Effect.context<RuntimeToolUseExecutorHostEnvironment>()` — the *typed*
  capture idiom. Its union is hand-maintained and equally unenforced if its
  own sub-layer `RIn` is `any`-collapsed; the TFIND-005 fix should re-validate
  it too. Noted, not expanded.
- TFIND-029's resolution should be cross-linked from TFIND-005 as a
  dependent, mirroring the TFIND-007 ↔ Finding-3 linkage.

## 6. Acceptance gate for this SDD

This document is the deliverable. No production code until the coordinator
answers §4. On signoff: either TFIND-029 is marked resolved/superseded
(gated-on-TFIND-005, this SDD as the record) or a single rationale-comment
commit lands on `sidecar/runtime-start-deps`. FINDINGS.md ledger delta is
coordinator-owned.
