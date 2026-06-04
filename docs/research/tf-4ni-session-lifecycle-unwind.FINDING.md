# FINDING — tf-4ni session_cancel/session_close clean-unwind substrate

Status authority: bead `tf-4ni`. Governing contract:
`docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`. Builds on the
`tf-0du` FINDING (Gap 2 = session.cancel/session.close).

> **PR scope (coordinator decision (b) — SPLIT).** This PR is the §8
> **evidence artifact only**: the red `session-lifecycle-unwind-pipeline`
> sim + this FINDING. The prototyped production substrate
> (`protocol/src/launch/control-request.ts`, `table.ts`, `index.ts` +
> `host-sdk/.../control-request-reconciler.ts` +
> `agent-tool-host-live.ts`) was deliberately **stripped** from this PR:
> shipping a production substrate change bundled with an unresolved
> durability bug (the append-point design question below) is premature.
> The substrate is recorded here in full (it was built, typecheck-green,
> additive, no TFIND-031 reach-past) and will land as a **separate gated
> PR once the append-point design is settled**. With the substrate
> reverted to `origin/main`, the host still returns `unsupportedAgentTool`
> for `session_cancel`/`session_close`, so the sim is red for the
> baseline reason (Gap 3 unresolved) — honest, un-papered evidence.

## Stale-premise correction (delivered, gate-green)

The `tf-0du` Gap-2 HARD-HALT premise ("only host-local
closeActiveEngine/deregister — no durable, reconcilable, cross-host
observable terminal seam; requires new substrate beyond additive") is
**partially stale**. `packages/host-sdk/src/host/control-request-reconciler.ts`
has since landed: a live, blessed durable control-request → host-reconciler
(claim/completion, survives host generations) → engine pattern. The
substrate was therefore built **additively at the correct layers**, no
TFIND-031 reach-past:

- Protocol (`packages/protocol/src/launch/control-request.ts` + `table.ts`
  + `index.ts`): `RuntimeControlRequestKind += cancel|close`; new
  `RuntimeLifecycleRequestRow` + idempotent constructors; the kind-generic
  claim/completion rows carry lifecycle with zero new claim/completion
  schema; `lifecycleRequests` table membership.
- Reconciler (`control-request-reconciler.ts`): additive
  `reconcileLifecycleRequest` arm — claim → `RuntimeContextEngineRegistry.
  deregister(contextId)` → durable kind-generic completion. No
  `SandboxProvider` / `HostRuntimeContextExecutionEnv` widening.
- Host seam (`agent-tool-host-live.ts`): `cancelSession`/`closeSession`
  replaced the `unsupportedAgentTool` stubs with a durable
  `lifecycleRequests` append.
- Sim (`packages/firelab/src/simulations/session-lifecycle-unwind-pipeline.ts`):
  self-contained (no `configurations/` import); deterministic stdio-jsonl
  agent calls the `session_cancel` agent tool against its own running
  session; terminal asserted purely through the public Firegrid client.

Monorepo typecheck 17/17 green for the whole change.

## HALT-AND-SURFACE — empirical: append point is inside an uncommitted activity

The sim run is **red, honestly** (not papered):
`sawReady:true, sawTerminated:false, snapshotStatus:"started",
terminalObserved:false`.

Trace evidence
(`.simulate/runs/2026-05-19T11-51-59-344Z__session-lifecycle-unwind-pipeline`):

- `firegrid.host.agent_tool.session_cancel` span — **status `success`**,
  correct `firegrid.context.id` (the agent parsed the right sessionId and
  the host seam ran).
- `firegrid.control.lifecycle_request_count: 0` on the reconciler
  (`reconcile_once`) — proving the new `reconcileLifecycleRequest` arm IS
  running but the durable `lifecycleRequests` query returns **0 rows**.
- Same run: `context_request_count:1` / `start_request_count:1` reconcile
  normally (client-written control requests persist and are seen).
- `firegrid.runtime-context.tool.lifecycle-1` ×36 /
  `session.send.tool-result.lifecycle-1` ×36 — the tool-use was
  re-dispatched many times; the agent never `turn_complete`s (by design,
  to stay alive for the unwind).

Diagnosis (decision-grade): the host-seam durable append succeeds at the
span level but its durable effect is **not visible to the reconciler**,
whereas *client-written* context/start control requests are. The
distinguishing factor is the append SITE: `cancelSession`/`closeSession`
run **inside the agent-tool-use workflow activity**, which here never
commits (the agent deliberately never turn-completes, and the tool-use is
re-dispatched 36×). A durable write performed inside an uncommitted /
re-executed workflow activity does not durably land for an out-of-activity
reconciler — unlike the client path, which appends the control request on
a committed client transaction.

This is a **substrate-integration boundary finding**, not a papered gap
and not a TFIND-031 reach-past: the cancel/close substrate is correct, but
the agent-tool host seam is the **wrong durable-append site**. Resolution
options for the architect (each a real design choice, none additive at the
current seam):

1. Append the lifecycle control request on a committed path the way the
   client appends context/start requests (e.g. an agent-tool → committed
   control-intent append that is not nested in the tool-use activity), so
   the reconciler observes it.
2. Make the agent-tool-use activity's durable control-plane writes commit
   independently of turn completion (workflow-semantics change — wider).
3. Drive the terminal transition synchronously at the host seam via the
   engine registry instead of through the reconciler (collapses the
   durable-reconcile property the clean-unwind needs to survive host
   generations — likely wrong).

Option 1 is the most additive and contract-clean. It is a distinct slice
from this one and is recorded here for architect prioritization rather than
papered or forced.

## Net

Protocol + reconciler + seam + sim are delivered and typecheck-green; the
sim is the falsifiable public-surface evidence and it is red for a precise,
diagnosed reason (wrong durable-append site for the host-originated
control request). HARD-HALT applied per the dispatch HALT-RULE. No
self-merge; coordinator/architect holds the gate.
