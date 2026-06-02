# RuntimeContext Keyed-Subscriber Reconcile Proposal Review

Review target: primary-checkout proposal
`docs/proposals/PROPOSAL_RUNTIME_CONTEXT_KEYED_SUBSCRIBER_RECONCILE_2026-06-02.md`.

Overall verdict: **amend**. The proposal is right that RuntimeContext has a
real architectural contradiction and a real terminal-cleanup P0. The review
should make one higher-priority callout explicit: the source-of-truth docs are
themselves contradictory after the unified cutover. Current code and the unified
production SDD are on **Workflow + DurableTable + Signal**; the older hard
"no long-lived parked bodies" text in `runtime-design-constraints.md` is not
congruent with that shipped architecture.

## P0: Architecture Source-Of-Truth Conflict

Verdict: **agree with the user's correction; add as P0**.

Firegrid is currently on the unified architecture. The production wiring SDD
says Phase 2 "collapsed the substrate to three primitives (Workflow +
DurableTable + Signal)" and that "the substrate is settled"
(`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:12`,
`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:14`). It defines the
current session adapter lifecycle around a workflow body whose terminal action
calls `deregister` (`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:20`,
`:34`), and it diagrams codec output flowing through the journal observer to a
terminal signal relay (`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:36`,
`:45`). The accepted host composition is also unified: WorkflowEngine,
SignalTable, UnifiedTable, channel bindings, all workflows, and observer live in
one `FiregridHost` factory (`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md:116`,
`:124`).

That conflicts with the current wording of
`docs/cannon/architecture/runtime-design-constraints.md`. The constraints doc
says keyed subscribers "run to completion, and return" and must not park or keep
fiber-local state across events (`docs/cannon/architecture/runtime-design-constraints.md:80`,
`:83`). It then says the active validation path is `tf-tvg1`, to prove a
shorter per-event workflow/keyed-subscriber RuntimeContext and rewrite
production against that target (`docs/cannon/architecture/runtime-design-constraints.md:474`,
`:479`). It also labels controller-owned write+arm as a migration safety
primitive for a parked-body engine, "not the target abstraction"
(`docs/cannon/architecture/runtime-design-constraints.md:488`, `:494`).

The later `kernel-owned-write-arm.md` banner partially reconciles the history:
its **principle** remains binding, but its pre-unified mechanism references are
stale after #765. It explicitly says the current resume-half is the unified
signal primitive `packages/runtime/src/unified/signal.ts`, not a parallel
`KernelCommandTable` implementation
(`docs/cannon/architecture/kernel-owned-write-arm.md:8`,
`:31`).

Disposition: **P0 docs/architecture ambiguity**. Before more RuntimeContext
rewrite work is dispatched, the architecture set needs one canonical statement:

- either unified parked workflow bodies are accepted target architecture, with
  `runtime-design-constraints.md` amended to remove/soften the no-parked-body
  prohibition for unified signal-owned bodies;
- or unified is current bridge state, with an explicit deletion path from
  signal-parked RuntimeContext bodies to per-event keyed subscribers.

Until that is decided, `tf-tvg1`, `tf-r06u.36`, and any "fix the P0 now"
dispatch can be interpreted two incompatible ways.

## 1. Canon Contradiction

Verdict: **agree, but restate around current unified architecture**.

The contradiction is real, but it is not "current code violates the obviously
current cannon and cannon simply wins." The current code matches the unified
production SDD, while `runtime-design-constraints.md` still expresses a stricter
target.

Current code implements the unified parked-body shape. The runtime-context
subscriber header says the body is a single `Workflow.make` body "parked on
`Workflow.suspend`, woken by the signal primitive"
(`packages/runtime/src/unified/subscribers/runtime-context.ts:2`, `:6`). The
body keeps local `consumed` / `reachedTerminal` state, loops over signals, and
suspends when no new signal exists
(`packages/runtime/src/unified/subscribers/runtime-context.ts:111`, `:120`).
It only reaches cleanup after consuming a terminal input
(`packages/runtime/src/unified/subscribers/runtime-context.ts:131`, `:153`).

`signal.ts` is the named unified bridge/mechanism. It documents itself as a
"Durable Signal" because the Effect workflow engine lacks that native primitive
(`packages/runtime/src/unified/signal.ts:1`, `:8`). `sendSignal` records the
signal row and then resumes or arms the owning execution
(`packages/runtime/src/unified/signal.ts:193`, `:205`), while
`recoverPendingSignals` scans signal rows and re-arms unresolved executions
(`packages/runtime/src/unified/signal.ts:266`, `:305`).

Corrected statement: there is a real contradiction between the active
no-parked-body constraints doc and the current unified SDD/code. The proposal
should not assume precedence silently; it should name this as the P0 alignment
issue above.

Also correct the "atomic" wording around `sendSignal`: the file comment says
"Atomically" (`packages/runtime/src/unified/signal.ts:25`, `:27`), but source
shows `writeSignalRow` performs `insertSignalRow(...)` and then
`options.write(...)` as sequential effects (`packages/runtime/src/unified/signal.ts:168`,
`:180`). It is a durable write+arm composition, not source proof of an
all-or-nothing multi-row transaction.

## 2. Blockers

Verdict: **amend**.

Atomic multi-row append: **confirmed absent on the DurableTable public surface**.
`CollectionFacade` exposes row-level `insert`, `insertOrGet`, `upsert`,
`delete`, `get`, `query`, `subscribe`, plus table-level `awaitTxId`; no
transaction or multi-collection append API is present
(`packages/effect-durable-operators/src/DurableTable.ts:117`, `:146`,
`:155`). The implementation appends one State Protocol event per `insert`,
`upsert`, or `delete`, then waits for that txid
(`packages/effect-durable-operators/src/DurableTable.ts:368`, `:377`, `:400`,
`:407`, `:426`, `:432`). `insertOrGet` is row-level and is explicitly "not a
lock, claim, mutex, semaphore, lease, or general coordination primitive"
(`packages/effect-durable-operators/src/DurableTable.ts:119`, `:122`).

F3 table-write wakeup: **refute if stated as completely absent**. Current main
has an explicit test proving a workflow can wait on a table row without a
DurableDeferred mailbox: the body point-reads its owned table, suspends when
absent, then a later table insert plus `WakeWorkflow.resume(executionId)` makes
the body re-read and complete
(`packages/runtime/test/workflow-engine/DurableStreamsWorkflowEngine.test.ts:927`,
`:933`, `:1001`, `:1004`). Engine source supports the explicit arm path:
`resume` re-drives the workflow body
(`packages/runtime/src/engine/internal/engine-runtime.ts:182`, `:206`), and the
public engine object exposes `resume`
(`packages/runtime/src/engine/internal/engine-runtime.ts:350`).

What is still absent is **automatic table-write-driven wakeup**. DurableTable
writes do not intrinsically wake workflow executions; the proof uses an
explicit arm. The proposal should distinguish "no automatic table-write wakeup"
from "no F3 at all."

## 3. P0 Leak Connection

Verdict: **agree, amend causality**.

The leak chain is real and matches `tf-r06u.36`, but the direct bug is missing
terminal-output routing. The parked body makes the bug persistent.

Source chain:

- Agent codecs emit terminal output facts. ACP emits `Terminated` on process
  exit and `TurnComplete` after a turn
  (`packages/runtime/src/sources/codecs/acp/index.ts:438`, `:445`, `:768`,
  `:770`); stdio-jsonl emits the same terminal kinds
  (`packages/runtime/src/sources/codecs/stdio-jsonl/index.ts:150`, `:153`,
  `:285`, `:292`).
- The public session-facade projection preserves `TurnComplete` and
  `Terminated` as observations
  (`packages/protocol/src/session-facade/schema.ts:554`, `:561`).
- `JournalObserverLive` only triggers `PermissionRoundtripWorkflow` for
  `PermissionRequest` and `ToolDispatchWorkflow` for host-dispatched `ToolUse`;
  all other observations hit `default: Effect.void`
  (`packages/runtime/src/unified/observers.ts:53`, `:89`).
- The runtime-context body only calls `adapter.deregister` after consuming a
  terminal input signal
  (`packages/runtime/src/unified/subscribers/runtime-context.ts:131`, `:153`).
  `deregister` closes the per-context scope and deletes the registry entry
  (`packages/runtime/src/unified/codec-adapter.ts:518`, `:529`).
- Cancel and close already use the shared terminal-signal helper
  (`packages/runtime/src/unified/channel-bindings.ts:287`, `:306`, `:442`,
  `:485`), so the missing leg is natural agent completion:
  `TurnComplete`/`Terminated` -> terminal signal -> body cleanup.

If the canonical decision remains unified, a run-to-completion keyed subscriber
is not the immediate fix; the immediate fix is to wire the missing terminal
relay into the unified signal path. If the canonical decision flips back to
per-event keyed subscribers, the terminal event contract still has to be wired
there too. Either way, `tf-r06u.36` should stay P0.

## 4. Recommendation Pressure Test

Verdict: **amend**.

### 4a. Fix P0 Now, Decoupled From A/B/C

Operationally, yes: fix `tf-r06u.36` now. It should not wait for the larger
architecture reconciliation because the current unified path already has the
shared terminal-signal helper for cancel/close
(`packages/runtime/src/unified/channel-bindings.ts:287`, `:306`, `:442`,
`:485`), and natural agent completion is missing the same leg.

But the implementation shape should be explicitly marked **current-unified**:
observer sees `TurnComplete`/`Terminated`, emits the same terminal session input
signal, and lets the session body run its existing terminal `deregister`
activity. A direct observer-side `adapter.deregister` would close the registry
but leave the workflow suspended and without its final result.

### 4b. Is `tf-tvg1` A/B/C The Right Gate?

Only after the P0 docs ambiguity is resolved. If unified is accepted as the
target, `tf-tvg1` should be reframed away from "replace unified with per-event
Shape C" and toward "prove the minimal missing unified terminal/input/tool
edges." If `runtime-design-constraints.md` remains authoritative as written,
then `tf-tvg1` is still the right validation bead for the per-event target.

There is also a faster source/API gate:

1. Existing substrate supports automatic table-write wakeup -> **no**.
2. Existing substrate supports explicit table-write plus `resume` -> **yes**.
3. Existing DurableTable supports atomic multi-row append -> **no**.

That gate should precede any expensive sim because it prunes several options
without needing a model run.

### 4c. Strongest Case Against The Current Lean

Strongest case against "B/C because `signal.ts` is the thin arm": current
`signal.ts` is not a generic keyed-subscriber arm. It is workflow-execution
specific: signal rows carry `workflowName`, `executionId`, and optional
`workflowPayloadJson` (`packages/runtime/src/unified/signal.ts:86`, `:102`);
recovery scans signal rows and calls workflow `resume` / `armFromSignal`
(`packages/runtime/src/unified/signal.ts:266`, `:305`); `awaitSignal` parks a
workflow body (`packages/runtime/src/unified/signal.ts:229`, `:244`).

That is aligned with the unified production SDD, but not with a strict
per-event/no-parked-body target. Therefore the recommendation should not say
"`signal.ts` proves B." It should say: `signal.ts` is the current unified
write+arm mechanism. If unified is canonical, harden it. If per-event
subscribers are canonical, treat it as bridge evidence to retire or split.

## 5. Corrected Recommendation

Verdict: **amend recommendation**.

Recommended disposition:

1. Open/track a **P0 architecture-doc reconciliation**: decide whether the
   current unified parked-body Signal architecture is canonical target or a
   bridge. Update `runtime-design-constraints.md`,
   `unified-subscriber-kernel.md`, and the relevant SDD references in one pass.
2. Land `tf-r06u.36` now on the current unified substrate:
   `TurnComplete`/`Terminated` -> shared terminal session signal ->
   session-body `adapter.deregister` -> workflow final result.
3. Record the source/API facts as prerequisites:
   no atomic multi-row append; no automatic table-write wakeup; explicit
   table-write plus `resume` is already proven.
4. Reframe `tf-tvg1` after the P0 doc decision:
   - if unified is target: validate missing unified edge hardening and shrink;
   - if per-event is target: validate the replacement and write the deletion
     path for unified signal-parked RuntimeContext bodies.

The current proposal should not proceed as if the precedence question is
settled. It is the highest-order blocker because it changes the meaning of every
subsequent RuntimeContext bead.
