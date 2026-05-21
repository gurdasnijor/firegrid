# tf-24p — Gap-3 / #417 serial-reconciler-starvation mechanism review

Date: 2026-05-21
Owner: tf-24p (Lane 5, opus)
Subject PR: #417 (`tf-p7w: fix lifecycle clean-unwind reconciliation`)
Subject FINDING: `docs/research/tf-p7w-host-seam-materialization.FINDING.md`
Author concern: per `docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md` §9d, this mechanism shares an author with the refuted TFIND-017 "`DurableTable.rows()` is a live tail" claim — the §6 handoff §9e calls out "fix outcome is real (sim flips green) but story-of-why warrants source verification".

## Verdict — VERIFIED (mechanism source-correct; one narrative inaccuracy on the pre-fix order; the refuted-TFIND-017 author-share concern does NOT transfer)

The mechanism PR #417's FINDING describes — **"the serial control-request reconciler's single forever-loop tick blocked on `startRuntime()` and never re-entered the lifecycle scan"** — is a direct, source-verifiable property of the pre-#417 reconciler code, not an inference about third-party behavior. The fix (independent concurrent lifecycle loop) addresses the actual mechanism. The shared-author concern that triggered this review does NOT carry, because the epistemic process behind the #417 claim is **direct reading of the project's own control-flow**, not **inference about a primitive's documented behavior** (the structural defect that sank TFIND-017).

One **narrative caveat** worth recording but not load-bearing: the FINDING prose states the pre-fix order was "`context`, then `lifecycle`, then `start`", but the actual pre-fix order was `context`, then `start`, then `lifecycle` — i.e., lifecycle was reconciled LAST in each tick, not second. The conclusion ("serial reconciler starves lifecycle") stands either way; if anything, the actual order made starvation worse than the prose described (lifecycle is the last arm to run inside a tick that may never get past `start`).

## Original claim (verbatim, with source)

From `docs/research/tf-p7w-host-seam-materialization.FINDING.md` §"Source-verified conclusion":

> The remaining Gap-3 blocker was **not** collection registration, write topology, materialization subscription scope, or loopback dedupe. […]
>
> The real failure was the **serial control-request reconciler**. The one-shot loop processed `context`, then `lifecycle`, then `start`; once a `start` request reached `startRuntime()`, that long-running runtime blocked the next scan. The lifecycle row was appended after the runtime was already inside that long-running start path, so no later lifecycle scan ran before the simulation timeout. The red artifact ends with `firegrid.host.control_request.start.reconcile` timing out; it never got back to the lifecycle scan.

PR #417 head commit: `7d3610ba21fce6e99195aba7229d8bf75ceeab38`. Merged via merge commit `eb50050cb0f0ed54bcf279da3a68ac2eb3443b7f` on 2026-05-19.

## Source verification of each load-bearing step

The mechanism story has four load-bearing claims. Each is independently source-verifiable:

### Step 1 — "The reconciler was a single forever-loop tick"

**Source (pre-#417):** `7d3610ba21fce6e99195aba7229d8bf75ceeab38^:packages/host-sdk/src/host/control-request-reconciler.ts` (sed output):

```ts
const tick: Effect.Effect<
  void,
  never,
  RuntimeControlRequestReconcilerEnvironment
> = reconcileRuntimeControlRequestsOnce(options).pipe(
  Effect.catchAllCause(cause => …),
  Effect.zipRight(Effect.sleep(Duration.millis(pollIntervalMs))),
)
return tick.pipe(Effect.forever)
```

One Effect; processes all request types; sleeps; loops `forever`. There is no second concurrent loop. **Verified.**

### Step 2 — "Within a tick, requests were processed serially as `Effect.forEach`"

**Source (pre-#417):** the same file's `reconcileRuntimeControlRequestsOnce`:

```ts
yield* Effect.forEach(
  contextRequests,
  request => reconcileContextRequest(request, resolved),
  { discard: true },
)
…
yield* Effect.forEach(
  startRequests,
  request => reconcileStartRequest(request, resolved),
  { discard: true },
)
…
yield* Effect.forEach(
  lifecycleRequests,
  request => reconcileLifecycleRequest(request, resolved),
  { discard: true },
)
```

`Effect.forEach` defaults to `concurrency: 1` (sequential). Each `forEach` awaits its arm before the next runs. **Verified.**

NARRATIVE-INACCURACY NOTE: the pre-fix order was `context, start, lifecycle` (lifecycle LAST), not `context, lifecycle, start` as the FINDING prose reads. The PR #417 diff at `packages/host-sdk/src/host/control-request-reconciler.ts` shows lifecycle being **moved up** ahead of start in addition to the new independent loop being added — i.e., the fix performs **two** structural improvements; the FINDING narratively emphasises the second but not the first.

### Step 3 — "`reconcileStartRequest` calls `startRuntime()` and awaits it"

**Source (pre-#417):** same file, lines 300–315:

```ts
const reconcileStartRequest = (request, options) =>
  Effect.gen(function*() {
    const claim = yield* acquireReconcileClaim("start", request, options)
    if (Option.isNone(claim)) return
    const { nowMs, session } = claim.value

    const result = yield* startRuntime({ contextId: request.contextId }).pipe(…)
    …
  })
```

`yield* startRuntime(...)` awaits the result. **Verified.**

### Step 4 — "`startRuntime` is long-running (awaits the entire workflow body)"

**Source (current HEAD):** `packages/host-sdk/src/host/commands.ts:158-184`:

```ts
export const startRuntime = (options) =>
  Effect.gen(function*() {
    const context = yield* requireLocalContext(options.contextId)
    const runtime = yield* RuntimeContextWorkflowRuntime
    const agentToolHost = yield* AgentToolHost
    return yield* claimAndRunRuntimeContextWorkflow(context, runtime, agentToolHost)
  })
```

Which awaits `claimAndRunRuntimeContextWorkflow` at `packages/host-sdk/src/host/commands.ts:85-113`:

```ts
const claimAndRunRuntimeContextWorkflow = (context, runtime, agentToolHost) =>
  Effect.gen(function*() {
    …
    return yield* runtime.run({
      context,
      workflowName: RuntimeContextWorkflowNative.name,
      supportLayer: runtimeContextWorkflowSupportLayer(context.contextId, agentToolHost),
      effect: executeRuntimeContextWorkflowForContextId(context.contextId),
      deregisterOnExit: true,
    })
  })
```

`runtime.run(...)` executes the full `RuntimeContextWorkflowNative` body — the entire agent run. It is structurally long-running. **Verified.**

### Composite consequence

Steps 1–4 compose mechanically: a single forever-loop tick → serial `Effect.forEach` for each request type → `startRequest` awaits the full workflow → if any start is long-running, the tick blocks at that `startRequest`. The remaining `forEach` arm (`lifecycleRequests` — which was LAST in the actual pre-fix code) never runs in that tick, and the surrounding `Effect.forever` cannot re-enter until the current tick returns. Therefore: a lifecycle row written **after** the tick has reached an in-flight long-running start cannot be reconciled until that start completes.

This is the exact symptom the FINDING's trace artifact `2026-05-19T13-21-58-134Z__session-lifecycle-unwind-pipeline` records:

- `firegrid.host.control_request.start.reconcile` open (timing out)
- never re-enters `firegrid.host.control_request.reconcile_once`
- `firegrid.host.control_request.lifecycle.reconcile_once` (which is also inside `reconcile_once`) never fires after the lifecycle row appears

## The fix — what it actually changed

PR #417 introduced two structural changes (not one, despite the FINDING emphasising only the second):

1. **Reorder `lifecycle` ahead of `start` in `reconcileRuntimeControlRequestsOnce`.** This is the smaller of the two; it gives lifecycle one chance per tick BEFORE a blocking start can lock the tick. Visible at the diff hunks moving the `lifecycleRequests` block from after `startRequests` to before. By itself this fixes the case where the lifecycle row is already written when a tick starts, but does NOT fix the case where the lifecycle row appears mid-tick (after start has begun blocking).

2. **Add an independent concurrent `lifecycleLoop`.** `runRuntimeControlRequestReconciler` returns `Effect.all([controlLoop, lifecycleLoop], { concurrency: "unbounded", discard: true })`. This guarantees lifecycle reconciliation has a tick that is not gated on any other request type's completion. This is the load-bearing fix; (1) is a belt-and-suspenders complement.

Both are visible at `7d3610ba21fce6e99195aba7229d8bf75ceeab38:packages/host-sdk/src/host/control-request-reconciler.ts:538-577`.

The fix is **structurally sound and addresses the actual mechanism** — it does not paper over a symptom. The independent lifecycle daemon is the architecturally-right answer to "long-running operation in one request type's reconciler should not be able to starve another type's reconciler"; it generalises beyond the specific session-lifecycle-unwind sim.

## Cross-reference: comparison to the refuted TFIND-017 misdiagnosis pattern

Per the §6 handoff §9d the concern is: the #417 mechanism "shares an author with the refuted TFIND-017 rows-is-live-tail claim". This review's task is to determine whether they also share the structural **misdiagnosis pattern**.

| Property | TFIND-017 (refuted) | #417 (this review) |
|---|---|---|
| Claim type | API-contract behavior of a primitive (`DurableTable.rows()`) | Control-flow property of the project's own reconciler |
| Source of authority | Inference from sim-comment + bead-title + lane report | Direct read of the project's own `control-request-reconciler.ts` |
| Refutation path | Read `DurableTable.ts:143` docstring + impl line ~769 (`includeInitialState: true`) — 60 seconds | Would require showing pre-fix reconciler is NOT serial, or `startRuntime` does NOT await; neither contradiction exists in source |
| What was actually broken | Nothing in `rows()`; the workaround at #406 was built on a phantom defect | Real serial structure; real long-running call site; real symptom |
| Verification mode | INFERENCE about an external contract | DIRECT-READ of project control-flow |

These are **different structural categories of claim**. TFIND-017 required reasoning about the SEMANTICS of an API and was refutable because the API documents the opposite of what was claimed. The #417 mechanism, by contrast, is a direct read of three lines of TypeScript (`yield* Effect.forEach(startRequests, reconcileStartRequest)` + `yield* startRuntime(...)` + `runtime.run(...)`); each step is locally visible and there's no contract surface to misread.

**The shared-author signal does not, by itself, transfer concern to the #417 claim.** The §9d heuristic ("every lane-produced finding is a hypothesis until source-verified") is correct as a process discipline; applied to #417, source verification confirms the mechanism. The author's TFIND-017 misdiagnosis was a process failure on a particular epistemic shape (inference about external API behavior); this one isn't that shape.

That said, **the §9d corrective principle still applies** — coordinators inheriting this work should not propagate the prose description in the FINDING without an awareness that:
- the pre-fix arm order was `context → start → lifecycle`, not `context → lifecycle → start`
- the fix bundled two changes (reorder + independent loop), and the load-bearing one is the independent loop
- the trace evidence `lifecycle_request_count:0` cited as proof should be read as "the tick never re-entered the lifecycle scan after the row was written", not "the lifecycle scan ran and found zero rows" (those are different failure modes with the same span text)

## What the post-#417 architecture looks like at HEAD

The reconciler has been **further** restructured since #417 (moved from `packages/host-sdk/src/host/control-request-reconciler.ts` to `packages/runtime/src/control-plane/control-request-dispatcher.ts`; renamed; the underlying mechanism is the same kind only stronger). At HEAD the architecture has **two layers of defense** against the original starvation class:

1. Each request type runs in its own Stream.runForEach loop — `contextRows`, `startRows`, `lifecycleRows` — composed via `Effect.all([...], { concurrency: "unbounded", discard: true })` at `control-request-dispatcher.ts:775-782`. PR #417 introduced this concurrency-of-loops shape (originally as two loops; HEAD has three).

2. `startRequestExecution: "background"` is the daemon default (`control-request-dispatcher.ts:718`), and `runStart` forks the start execution into the host scope (`control-request-dispatcher.ts:524-534`). Even within the start stream, each individual start is forked — so a slow agent run can't block the start stream either.

Layer 1 is exactly the #417 fix shape (now applied to all three types). Layer 2 is additional hardening from later commits. Together they make the original starvation class structurally impossible.

## Disposition

- **#417 mechanism is source-verified.** Cite it with confidence.
- **#417 fix is complete and addresses the actual root cause.** It is not a workaround.
- **The shared-author concern with TFIND-017 does NOT transfer.** Different epistemic category.
- **Minor narrative inaccuracy in `docs/research/tf-p7w-host-seam-materialization.FINDING.md`** (arm order described as `context → lifecycle → start`, actual was `context → start → lifecycle`). Suggest a one-line FINDING amendment; not blocking.
- **The fix is now part of a stronger architecture at HEAD** (three concurrent stream-driven loops + background start execution). The original #417 mitigation was the foundation for this evolution; it should NOT be reverted.

## Cross-references

- `docs/research/tf-p7w-host-seam-materialization.FINDING.md` — the original FINDING under review
- `docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md` §9d, §9e — the lane-reports-as-hypotheses rule and what-survived-as-real (the §6 epistemic guardrails)
- `docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md` §8 ⚠ KNOWN MISDIAGNOSIS box (lines 628–645) — the refuted `rows() is live tail` claim, cited verbatim
- Pre-#417 reconciler source: `7d3610ba21fce6e99195aba7229d8bf75ceeab38^:packages/host-sdk/src/host/control-request-reconciler.ts`
- Post-#417 reconciler source: `7d3610ba21fce6e99195aba7229d8bf75ceeab38:packages/host-sdk/src/host/control-request-reconciler.ts`
- Current HEAD reconciler: `packages/runtime/src/control-plane/control-request-dispatcher.ts` (renamed + extended)
- `packages/effect-durable-operators/src/DurableTable.ts:81-94` — the `ProjectionStream` docstring (the contract that refuted TFIND-017); cited here as a contrast to show the §6 handoff's `rows()` refutation is structurally different from this review's verification.
