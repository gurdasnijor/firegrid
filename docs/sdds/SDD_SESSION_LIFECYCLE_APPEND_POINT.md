# SDD: session_cancel/session_close terminal append-point

Status: **Option A DECIDED (Gurdas 2026-05-19) — but EMPIRICALLY
EXONERATED as the locus; HARD HALT, re-scope to substrate.** Status
authority: bead `tf-jri` (decision) / `tf-auk` / `tf-p7w`. Evidence: PR
#393 (merged §8 artifact), `docs/research/tf-4ni-session-lifecycle-unwind.FINDING.md`,
`tf-auk-optionA-insufficient.FINDING.md`,
`tf-p7w-host-seam-materialization.FINDING.md`.

> **tf-p7w UPDATE (2026-05-19) — write-topology EXONERATED.** Option A
> (committed control-intent append) and two further independent write
> mechanisms — including a **byte-for-byte client-equivalent durable
> write to the exact reconciler stream URL** — were all built and run.
> All three: `session_cancel` host span success, agent emits the
> tool_use, yet `lifecycle_request_count:0` while client context/start
> reconcile in the same run. `lifecycleRequests` is a schema-derived
> materialized collection like the working ones (missing-registration
> ruled out). Conclusion: the blocker is **NOT the host-seam write
> path**; it is reconciler-side `DurableTable` materialization/ingestion
> for the new collection. Substrate-level investigation required — see
> `tf-p7w-host-seam-materialization.FINDING.md`. Substrate recorded, NOT
> shipped (sim honestly RED). HARD HALT.

## §0 — The load-bearing question (decide this first)

**Where must the durable `session_cancel` / `session_close` terminal
control-request be appended so that it is durable across the
uncommitted-activity boundary — i.e. observable by the out-of-activity
control-request reconciler even though the agent-tool-use workflow
activity that issues it may never commit or may be re-executed?**

Everything else (protocol rows, reconciler arm, engine deregister,
completion projection) is already built and additive (no TFIND-031
reach-past); the build is gated solely on this one site decision.

## Why this is load-bearing (the empirical fact)

`session_cancel`/`session_close` are agent-tool-only by the schema
projection SDD (the client has no cancel method). The host seam
(`agent-tool-host-live.ts` `cancelSession`/`closeSession`) runs **inside
the agent-tool-use workflow activity**. Empirically (PR #393 sim, honest
red): a durable `lifecycleRequests` append done there is **not visible**
to the control-request reconciler (`lifecycle_request_count: 0`), while
client-written `context`/`start` control requests — appended **outside**
any activity, on a committed client write — reconcile normally. The
agent never `turn_complete`s and the tool-use is re-dispatched (×36),
so the enclosing activity does not durably land the write for an
external reader. The substrate is correct; the **append site** is wrong.

## Options

### Option A — Append on a committed control-intent path (mirror the client) — RECOMMENDED

Route the host-seam cancel/close to emit the lifecycle control-request
the same way client-written `context`/`start` requests are emitted: a
committed durable write that is **not nested in / not rolled back by**
the tool-use activity transaction (a host-side committed control-plane
append callable from the agent-tool execution path).

- **+** Most additive; reuses the *already-proven* commit semantics
  (client `contextRequests`/`startRequests` demonstrably reconcile);
  preserves the cross-host durable-reconcile property the clean-unwind
  needs; the entire built substrate (protocol + reconciler arm) is
  reused unchanged — only the append site moves.
- **−** Requires a committed-append seam invokable from agent-tool
  execution that provably escapes the enclosing activity (the precise
  mechanic to validate in the follow-on gated PR).
- **Blast radius:** `host-sdk/src/host/agent-tool-host-live.ts` (append
  site) + likely a small `commands.ts` committed-append helper. Protocol
  (`protocol/src/launch/control-request.ts`, `table.ts`, `index.ts`) and
  the reconciler arm (`control-request-reconciler.ts`) land as already
  built.

### Option B — Make the tool-use activity commit its control-plane write

Change agent-tool-use activity semantics so durable control-plane writes
flush/commit independent of turn completion.

- **+** Append stays at the natural seam; no new append path.
- **−** Widest blast radius — touches workflow-engine activity-commit /
  replay invariants for *all* agent-tool durable writes; risks the exact
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
client commit semantics and the entire already-built additive substrate,
and keeps the cross-host durable-reconcile property the §6 clean-unwind
requires. Only the append site changes; protocol + reconciler are reused
as-is. The one mechanic to prove in the gated follow-on: that a
host-side committed control-plane append can be invoked from agent-tool
execution without being swallowed by the enclosing activity.

## Candidate implementation (already built, recorded — NOT shipped)

The additive substrate from the tf-4ni prototype (PR #393 history /
FINDING) is the candidate implementation for Options A and C, reusable
unchanged except the append site:

- protocol: `RuntimeControlRequestKind += cancel|close`,
  `RuntimeLifecycleRequestRow` + idempotent constructors, kind-generic
  claim/completion reused, `lifecycleRequests` table membership;
- reconciler: additive `reconcileLifecycleRequest` arm →
  `RuntimeContextEngineRegistry.deregister` → durable kind-generic
  completion (shared `acquireReconcileClaim` helper);
- host seam: `cancelSession`/`closeSession` durable append — **the line
  the §0 decision relocates.**

Typecheck-green, lint/lint:dead/lint:dup/lint:deps clean as built.

## Decision protocol

Gurdas picks A / B / C (or amends). Only then does the substrate land as
a **separate gated PR** implementing the chosen append site. This PR is
the decision artifact only — no substrate change here. No self-merge.
