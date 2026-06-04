# DELIVERY — tf-7bp §6 action-result survives host restart

Status authority: bead `tf-7bp`. Self-contained sim
`packages/firelab/src/simulations/action-survives-restart-pipeline.ts`
(auto-discovered; no `configurations/` import; no registry edit).
Lane-built, deterministic, no LLM (independent of the #395 external
Anthropic-quota blocker).

## What it proves (factory-vision §6 provider-edge durability)

"Record the result durably; the next decision might depend on whether the
action succeeded" — across a host-generation interruption. Composes three
merged building blocks, rendezvousing ONLY through durable-streams:

1. The real merged **#388 Gap-2 execute seam** (`FiregridRuntimeHostLive`
   `executeSandboxTool` → `SandboxProvider`). A deterministic stdio-jsonl
   participant takes a real provider-edge `execute` action (runs a process
   that writes a sentinel) and its result returns over the ToolResult
   roundtrip.
2. App-owned **durable evidence** (the action-and-remember pattern): the
   participant records the observed action result to an app-owned
   `DurableTable` on the same durable-streams baseUrl+namespace.
3. The merged **#381 (tf-ozl) gen-1→gen-2 restart harness**: `makeHost`
   runs gen-1 (`FiregridRuntimeHostLive`), a durable barrier that waits
   until the action result is durably recorded, tears gen-1 down, publishes
   a substrate restart sentinel, and recovers gen-2 over the SAME durable
   baseUrl+namespace. The barrier gates on the durable evidence row, so the
   restart provably happens AFTER the action result is durable.

## Result — run `2026-05-19T12-34-04-650Z`, status completed

Summary all-true; SOURCE-VERIFIED from spans (not summary-only):

- `firegrid.host.agent_tool.execute` + `…source.local_process.execute` —
  a **real SandboxProvider process ran** through the #388 seam (not a
  stub). `sawExecuteToolUse` + `sawActionResult`
  (`FIREGRID_ACTION_OBSERVED:FIREGRID_ACTION_SIDE_EFFECT_OK`) observed
  through the **public client**.
- `evidenceRecordedPreRestart` — the result was durably recorded.
- `firegrid.host.runtime_context.engine.close` x2 — gen-1 genuinely torn
  down and gen-2 recovered; `runtimeRestarted` confirmed via the
  substrate-published restart sentinel.
- `evidenceSurvivedRestart` + `postRestartActionSucceeded` — a FRESH
  post-restart read of the app-owned durable evidence still sees the prior
  action result with `status:"succeeded"` and the sentinel; the next
  decision can correctly depend on whether the action succeeded.
- `contextRecoveredPostRestart` — gen-2 recovered the durable context,
  observable via the public-client snapshot.
- 0 error spans.

## Net

§6 provider-edge durability is proven end to end through the public/durable
surface, across a real gen-1→gen-2 host interruption, with no LLM — so it
holds independent of the external Anthropic-quota blocker (#395). Clean
pass; no divergence/HALT. Full CI gate run before task-exit. Coordinator
holds the gate; no self-merge.
