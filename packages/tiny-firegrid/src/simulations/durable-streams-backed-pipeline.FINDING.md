# FINDING — durable-streams-backed restart simulation (bead tf-ozl)

Status authority is the bead (`tf-ozl`). This file is the narrative
artifact; live evidence is the gitignored `.simulate` run
`2026-05-19T10-54-20-249Z__durable-streams-backed-pipeline`.

## What was built

`packages/tiny-firegrid/src/simulations/durable-streams-backed-pipeline.ts`
— a deterministic, **agent-free, no-LLM** substrate-property simulation,
made **self-contained** (host-compose `composeDurableStreamsHost` inlined;
**no** `configurations/` import, so the slated `configurations/` deletion
stays clean). Built directly in the lane worktree (no sub-agent).

One `makeHost` layer internally runs host-generation-1 →
durable barrier → tear down gen-1 → host-generation-2 (reconcile the same
durable-streams baseUrl+namespace). The driver uses the **public Firegrid
client only**; gen↔driver rendezvous is solely through the durable
substrate (deterministic contextId from the external key). Property:
write durable workflow/table + runtime-context state → RESTART → assert
recovered via a fresh public-client snapshot.

`pnpm --filter @firegrid/tiny-firegrid typecheck` passes; run `status:
completed`; summary all-true.

## Source-verified substrate behavior (epistemic tier: SOURCE-VERIFIED, spans)

- **0** error/failed spans.
- Real host-generation boundary: `firegrid.host.runtime_context.engine.close`
  (gen-1 teardown) precedes the subsequent
  `firegrid.host.runtime_context.start` / reconcile. Lifecycle spans appear
  in a x2 pattern (`runtime_context.start` x2, `engine.close` x2,
  `claim_and_run` x2, `codec.start_session` x2,
  `control_request.completion.write` x2) — two host lifecycles ran.
- gen-1 durably bound the context + persisted ≥1 run event; the restart
  sentinel intent persisted; a fresh `firegrid.open(contextId).snapshot`
  post-restart resolved the durable RuntimeContext + run journal
  (`recoveredTableFact`/`recoveredWorkflowState` true).
- `postRestartHostId = "gen1"`: the recovered durable RuntimeContext keeps
  gen-1's binding-host identity. This is **correct** durable-provenance
  behavior — gen-2 reconciles existing durable facts without rewriting
  history; it is not a divergence.

Substrate verdict: the durable-streams-backed restart-recovery property is
demonstrated and the substrate behaved correctly. **No substrate bug.**

## Divergences (surfaced, NOT papered over)

### D1 — assertion-strength gap (triage cat-3, test-internal)

The post-restart probe is a **pure durable-streams client read**
(`firegrid.open(contextId).snapshot`). That read succeeds whenever the
durable rows persist past gen-1 teardown — **independent of whether
host-generation-2 reconciled anything**. `runtimeRestarted` only proves
`makeHost` wrote the sentinel (it does so right after closing gen-1, before
gen-2 does any work). So the all-true green is consistent with BOTH "gen-2
recovered it" AND a "durable-persistence-only, gen-2 irrelevant" null
hypothesis. The x2 lifecycle spans show gen-2 *ran*, but the **assertion
does not falsifiably isolate gen-2 reconciliation** as the cause of
recovery. The property name "recovered" is broader than what the probe
falsifiably proves ("durable state survives host-gen-1 teardown and is
readable by a fresh client").

Recommended strengthening (coordinator/architect to disposition; gate
held): the post-restart probe must require a fact only gen-2 could
produce after the barrier (e.g. a gen-2-authored durable marker, or a
host-generation-attributed reconcile/claim observation), so the assertion
fails if gen-2 never reconciled.

### D2 — host-generation observability gap (triage cat-2/5)

`firegrid.host.id` is only ever emitted as `"gen1"` across the whole
trace; `"gen2"` appears in **no** span attribute. gen-2's host work is not
host-generation-attributed. For a tracing/observability sim this is
material: the trace cannot answer the operator-debugging question "which
host generation served this read / did this reconcile?" — precisely the
kind of causality boundary the Effect-tracing runbook's "critical span
boundaries" section exists for. This also blocks the D1 strengthening from
using a pure span-attribution probe.

## Triage (FINDINGS_TRIAGE_RUBRIC)

- D1: **cat-3** (test-fixture awkwardness) — no production change; the toy
  must strengthen the probe to be falsifiable against the persistence-only
  null. Substrate is correct.
- D2: **cat-2 leaning cat-5** — host-generation identity absent from host
  spans is a real observability-surface gap a host operator would hit when
  debugging multi-generation reconcile, but it is host-internal span
  attribution (no client API change). Coordinator to route
  (observability-instrumentation vs hygiene).

Coordinator holds the gate. No self-merge. Findings are the deliverable.
