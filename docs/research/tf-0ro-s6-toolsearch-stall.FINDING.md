# FINDING — §6 planner stalls at ToolSearch; never issues Firegrid MCP ToolUse

Bead `tf-0ro` (P0). Investigation of run
`firegrid-worktrees/demo-s6-run/.../2026-05-19T12-51-52-626Z__dark-factory-pipeline`
(oca3 #401 harness, 3 live runs). **HARD-HALT verdict: this is NOT a
Firegrid substrate code gap. There is no additive Firegrid fix; the
discovery→invocation gap is agent-runtime + external quota.** Stating
this with evidence rather than papering it.

## SOURCE-VERIFIED (trace + code + prior G-MCP-2)

1. **Firegrid MCP surface is correct and callable.** `register_toolkit`
   span: `tool_count:8`,
   `execute,schedule_me,session_cancel,session_close,session_new,session_prompt,sleep,wait_for`.
   `McpServer.initialize` + `McpServer.tools/list` spans present — the
   planner DID enumerate the catalog (this run is NOT the codex
   non-enumerating G-MCP-2 case). The MCP-tool-exposure spec independently
   verified a known-good `@modelcontextprotocol/sdk` client lists all 8
   against the same URL. Discovery + catalog + transport: VERIFIED good.
2. **`ToolSearch` is purely `@agentclientprotocol/claude-agent-acp@0.36.1`'s
   internal deferred-tool discovery meta-tool.** `grep ToolSearch` across
   `packages/` + `apps/` = ZERO Firegrid occurrences. Firegrid exposes 8
   plain MCP tools; the agent runtime interposes its own ToolSearch
   indirection. `observedToolNames:["ToolSearch"]`,
   `observedToolInputs:["ToolSearch:{}"]`.
3. **The planner reasoned the full correct §6 plan but never invoked a
   Firegrid tool.** session_update breakdown: 22 `agent_message_chunk`
   (the complete plan in prose), 2 `agent_thought_chunk`, 2 `tool_call` +
   3 `tool_call_update` (the ToolSearch indirection), but **zero
   `McpServer.tools/call`**. `sawTurnComplete:false`, no `agentError`, no
   `Terminated`; the ACP `connection.prompt()` never resolved (runs 2&3
   stalled in 42–72s). The durable substrate ran hard
   (`wait_for.upsert_active ×1330`, `wait_router.complete_match ×1020`,
   backingFactPresent across all 6 steps) — substrate is not the blocker.
4. **The `tools/list_changed ×16` is span-count noise, not a cause.**
   `@effect/ai` `McpServer.registerToolkit` calls `addTool` per tool, and
   `addTool` issues one `notifications/tools/list_changed` rpc-client call
   (→ one `McpServer/Notifications…list_changed` span) per tool: 8 tools ×
   2 toolkit-layer builds = 16 spans. But `McpServer.onFromClient`
   debounces list_changed delivery (one `setTimeout(0)` handle per tag,
   coalesced — `repos/effect/packages/ai/ai/src/McpServer.ts:176-185`), so
   the client received ~1 per registration tick, not 16. NOT the stall
   cause. (`register_toolkit ×2` = two MCP-layer builds; orthogonal.)

## INFERENCE (labelled — not escalated to decision-grade)

The stall is the post-ToolSearch model turn that would issue the actual
Firegrid `tools/call` not completing. Convergent with the prior, directly
reproduced finding **tf-7dq/#395**: this run-family's halt root cause is
an **external Anthropic account usage limit** (quota exhausted; regains
2026-06-01 UTC), confirmed by a direct `claude-agent-acp` repro. Under
quota exhaustion the run dies precisely at the next model turn — i.e.
right after the cheap ToolSearch discovery call, before the model can emit
the Firegrid `tools/call`. The error was previously invisible because the
`@agentclientprotocol/sdk` `RequestError` dropped `error.message` — the
exact gap **tf-ds2/#403** (merged-pending) just fixed; with #403 a
re-run's `agentError` will carry the real reason.

`claude-agent-acp@0.36.1`'s deferred-tool **ToolSearch** indirection adds
a model round-trip between discovery and invocation, so it is the precise
point at which a quota-exhausted run visibly stalls. Whether ToolSearch
*also* independently blocks invocation when quota is available is NOT yet
isolable from this trace (quota was exhausted for all 3 runs).

## Verdict & recommendations (no code shipped — HARD-HALT)

- **Not a Firegrid substrate gap.** MCP exposure + §6 durable substrate
  are source-verified correct; §6 durability is independently PROVEN
  (#397). There is no additive Firegrid substrate change that makes this
  run green; a prompt hack / synthetic tool-call / unverified
  claude-agent-acp flag would be papering. None shipped.
- **Owed next steps (recommendations, not guesses):**
  1. Re-run the §6 dark-factory after Anthropic quota regains
     (≥ 2026-06-01 UTC) WITH merged tf-ds2/#403 — the `agentError` will
     now state the real reason. Expected: the planner proceeds
     ToolSearch → `tools/call` and §6 RUNS.
  2. ONLY if it still stalls at ToolSearch with quota available: open a
     scoped investigation into a `claude-agent-acp@0.36.1`
     deferred-tool / ToolSearch-disable config (agent-runtime invocation
     config in the dark-factory `local.jsonl` argv/env — NOT substrate
     code). Do not ship an unverified flag pre-emptively.

This is the gap between "§6 reasoned" and "§6 run": it is external
(Anthropic quota) + agent-runtime (claude-agent-acp ToolSearch
indirection), atop a verified-correct Firegrid substrate — not a Firegrid
defect. Coordinator/architect holds the gate; no self-merge.
