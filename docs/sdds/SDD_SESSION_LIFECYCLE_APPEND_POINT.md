# SDD: session_cancel/session_close terminal append-point

Status: **Option A DECIDED (Gurdas 2026-05-19) and implemented by
tf-p7w.** Status authority: bead `tf-jri` (decision) / `tf-auk` /
`tf-p7w`. Evidence: PR #393 (merged §8 artifact),
`docs/research/tf-4ni-session-lifecycle-unwind.FINDING.md`,
`tf-auk-optionA-insufficient.FINDING.md`,
`tf-p7w-host-seam-materialization.FINDING.md`.

> **tf-p7w UPDATE (2026-05-19) — materialization suspicion
> superseded.** Source inspection and trace artifacts proved
> `lifecycleRequests` is schema-compiled and materialized by the same
> DurableTable path as `contextRequests` / `startRequests`; the red run
> showed the lifecycle row append succeeded. The remaining clean-unwind
> failure was the serial reconciler: a long-running `startRuntime()`
> blocked later lifecycle scans. The fix runs lifecycle reconciliation in
> an independent daemon loop and records prompt terminal run/output
> evidence after deregister. Passing artifact:
> `2026-05-19T13-31-56-064Z__session-lifecycle-unwind-pipeline`,
> `terminalObserved:true`.

## §0 — The load-bearing question (decide this first)

**Where must the durable `session_cancel` / `session_close` terminal
control-request be appended so that it is durable across the
uncommitted-activity boundary — i.e. observable by the out-of-activity
control-request reconciler even though the agent-tool-use workflow
activity that issues it may never commit or may be re-executed?**

Everything else (protocol rows, reconciler arm, engine deregister,
completion projection, and public terminal evidence) is additive (no
TFIND-031 reach-past). Option A is now the implemented answer.

## Why this is load-bearing

`session_cancel`/`session_close` are agent-tool-only by the schema
projection SDD (the client has no cancel method). The host seam
(`agent-tool-host-live.ts` `cancelSession`/`closeSession`) runs inside
the agent-tool-use workflow activity. Empirically (PR #393 sim, honest
red), a durable lifecycle append done inside the tool-use activity was
not enough to produce clean unwind.

The append site still needed Option A's committed control-plane path,
but tf-p7w further proved the remaining red signal was not
materialization: the lifecycle row was appended and later visible, but
the serial reconciler was blocked in the long-running start arm and did
not scan lifecycle again before timeout.

## Options

### Option A — Append on a committed control-intent path (mirror the client) — DECIDED / IMPLEMENTED

Route the host-seam cancel/close to emit the lifecycle control-request
the same way client-written `context`/`start` requests are emitted: a
committed durable write that is not nested in / not rolled back by the
tool-use activity transaction.

- **+** Smallest blast radius; reuses the already-proven commit
  semantics; preserves the cross-host durable-reconcile property the
  clean-unwind path needs.
- **−** Required a committed-append seam invokable from agent-tool
  execution and a reconciler loop that cannot be starved by
  long-running starts; tf-p7w validates both with the §8 sim.
- **Blast radius:** `host-sdk/src/host/agent-tool-host-live.ts`,
  `protocol/src/launch/control-request.ts`, `protocol/src/launch/table.ts`,
  `protocol/src/launch/index.ts`, and
  `host-sdk/src/host/control-request-reconciler.ts`.

### Option B — Make the tool-use activity commit its control-plane write

Change agent-tool-use activity semantics so durable control-plane writes
flush/commit independent of turn completion.

- **+** Append stays at the natural seam; no new append path.
- **−** Widest blast radius — touches workflow-engine activity-commit /
  replay invariants for all agent-tool durable writes; risks the exact
  durability/replay guarantees workflows exist to provide. Same caution
  class as the TFIND-031 boundary. Likely over-broad / wrong.
- **Blast radius:** workflow-engine activity commit semantics
  (cross-cutting, high risk).

### Option C — Durable-deferred terminal record + committed promotion

The activity records a durable-deferred terminal intent on a path the
workflow already commits durably (workflow output / `DurableDeferred`);
a committed host path promotes it into a `lifecycleRequests` row.

- **+** Write rides a path the workflow already durably commits.
- **−** Adds an indirection + a promotion/drain component; more moving
  parts than A for the same outcome.
- **Blast radius:** `host-sdk` + a new promotion/drainer; protocol +
  reconciler reused.

## Recommendation

**Option A.** Smallest blast radius, reuses the demonstrably-correct
client commit semantics and keeps the cross-host durable-reconcile
property the §6 clean-unwind requires. tf-p7w adds the missing
reconciler property: lifecycle scans do not wait behind the long-running
start arm, and lifecycle reconcile writes public terminal evidence.

## Implementation

The additive substrate from the tf-4ni prototype (PR #393 history /
FINDING) plus tf-p7w is the implemented shape:

- protocol: `RuntimeControlRequestKind += cancel|close`,
  `RuntimeLifecycleRequestRow` + idempotent constructors, kind-generic
  claim/completion reused, `lifecycleRequests` table membership;
- reconciler: additive `reconcileLifecycleRequest` arm →
  `RuntimeContextEngineRegistry.deregister` → durable kind-generic
  completion → terminal run/output evidence (shared
  `acquireReconcileClaim` helper);
- daemon: lifecycle reconciliation runs independently of the full
  context/start loop so `startRuntime()` cannot starve clean unwind;
- host seam: `cancelSession`/`closeSession` durable append through the
  committed control-plane path.

Acceptance: `session-lifecycle-unwind-pipeline` passes with
`terminalObserved:true`.

## Decision protocol

No further decision is pending for this SDD. Coordinator still holds the
merge gate for implementation PRs; no self-merge.
