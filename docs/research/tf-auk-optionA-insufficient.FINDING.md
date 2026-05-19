# FINDING — tf-auk: Option A is necessary-but-INSUFFICIENT (HARD HALT)

Status authority: bead `tf-auk`. Sharpens
`docs/research/tf-4ni-session-lifecycle-unwind.FINDING.md` (merged #393)
and the Gurdas-decided `docs/sdds/SDD_SESSION_LIFECYCLE_APPEND_POINT.md`
(Option A). **HARD HALT** per dispatch HALT-RULE — not papered, sim left
honestly RED.

## What was built (Option A, faithfully)

Gurdas decided Option A: append the session_cancel/session_close
terminal control-request on a committed control-intent path, NOT inside
the uncommitted tool-use activity. Implemented exactly that:

- Restored the additive substrate (protocol `RuntimeControlRequestKind +=
  cancel|close`, `RuntimeLifecycleRequestRow`, table membership;
  reconciler `reconcileLifecycleRequest` arm → `deregister` → kind-generic
  completion).
- `agent-tool-host-live.ts` `cancelSession`/`closeSession`:
  `appendCommittedLifecycleRequest` performs the durable
  `lifecycleRequests.insertOrGet` on a **daemon fiber detached from the
  agent-tool-use activity (`Effect.forkDaemon`) and then joined** — the
  host-side analogue of the client's out-of-activity committed write.

Typecheck green (protocol, host-sdk, tiny-firegrid).

## Decisive empirical result — Option A did NOT fix it

Sim `session-lifecycle-unwind-pipeline` is **still RED**:
`sawReady:true, sawTerminated:false, snapshotStatus:"started",
terminalObserved:false`
(run `2026-05-19T12-27-25-894Z__session-lifecycle-unwind-pipeline`).

Trace evidence:

- `firegrid.host.agent_tool.session_cancel` span fired (the seam ran,
  the committed/detached append executed).
- `firegrid.control.lifecycle_request_count: 0` on the reconciler —
  **the row is STILL invisible to the reconciler**, despite the append
  now being detached/committed off the activity.
- Same run, **same reconciler**: `context_request_count: 1`,
  `start_request_count: 1` — *client-written* control requests reconcile
  normally; only the *host-seam-written* lifecycle request never appears.
- `firegrid.durable_table.query coll=lifecycleRequests` runs (the
  reconciler IS querying the right collection) and returns nothing.

## Re-framed root cause (the load-bearing correction)

The append-point / uncommitted-activity hypothesis (the basis of the
Option A decision) is **necessary but INSUFFICIENT**. Detaching the
append from the activity (forkDaemon+join) changed nothing — so the
blocker is NOT the activity-commit boundary.

The real, narrower question: **why does a control-request row written
through the host agent-tool seam's `captured.controlTable`
(`RuntimeControlPlaneTable` materialized at the agent-tool-host layer
build) not reach the durable backing the control-request reconciler
queries, while a *client*-written context/start request to the same
logical table does?** The client path works because it writes the
durable-streams the reconciler reads; the host-seam materialization
apparently does not propagate host-originated rows into that queried
backing (a materialization / instance / flush-visibility gap between the
agent-tool-host `RuntimeControlPlaneTable` and the reconciler's view —
NOT a transaction-commit gap). Note: `inputIntents` written the same way
*do* reach their consumer because that consumer is the in-process
dispatcher reading the same materialization — the reconciler instead
queries a (re-read) durable view.

## HALT — Gurdas re-decision needed (do not unilaterally pick)

This is a second load-bearing architectural decision, not an
implementation tweak. Candidate directions (each non-trivial; for
Gurdas, not auto-chosen):

1. Make the host agent-tool seam append through the **same durable-streams
   write path the client uses** (not the layer-materialized
   `captured.controlTable`) — i.e. a host-side committed append that
   targets the reconciler-visible backing directly.
2. Have the reconciler also observe the host-materialized table (couple
   the seam's materialization and the reconciler view) — risks
   instance/lifecycle coupling.
3. A host-originated control-request ingress that the client-equivalent
   committed path already drains.

Recommendation: direction 1 (host append via the client-equivalent
durable-streams write path), but this is explicitly a Gurdas decision —
the prior Option A decision was made on a hypothesis this run refutes.

## Disposition

Substrate recorded (candidate impl, additive, typecheck-green) but NOT
shipped as proven — the sim is honestly RED. SDD updated with a
post-decision note (empirical refutation; re-decision pending). No
self-merge; this PR is the HALT + sharpened-finding artifact for the
coordinator/Gurdas gate.
