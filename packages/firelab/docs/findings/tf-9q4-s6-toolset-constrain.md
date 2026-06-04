# FINDING — tf-9q4: toolset-constrain §6 planner (Firegrid choreography tools only)

Decision executed (factory-vision §4: the durable primitives ARE the
planner's toolset — not a workaround). Two Firegrid-controlled levers
added, default behavior preserved, honest verdicts, nothing papered.

## Changes (additive, gate-green)

1. **Prompt sharpening (agent-agnostic)** — `plannerPrompt` now opens with
   a HARD CONSTRAINTS block: the only tools are the Firegrid
   runtime-context tools (wait_for/session_new/session_prompt/schedule_me/
   execute/sleep/session_cancel/session_close); no fs/shell/repo/web/
   MCP-resource browsing; the ONLY way to make progress is to CALL the
   Firegrid tools; do not explore; issue the first Firegrid tool call now.
2. **codex-acp built-in trims** — codex-acp ignores ACP `_meta` (A1
   #411's claude `disableBuiltInTools`+alwaysLoad lever does not reach it),
   but accepts Codex `-c key=value`. Added
   `-c tools.web_search=false -c include_plan_tool=false
   -c include_apply_patch_tool=false -c include_view_image_tool=false`.
   (Codex's core shell tool cannot be removed via config — flagged.)
3. claude-agent-acp path is already toolset-constrained on origin/main by
   A1 #411 (`_meta.disableBuiltInTools:true` + alwaysLoad of the
   runtime-context MCP); unchanged here, plus the sharpened prompt.

## Run 1 — constrained codex-acp — PRECISE DEEP FINDING

Run `2026-05-19T13-43-02-725Z__dark-factory-pipeline`
(`DARK_FACTORY_PLANNER_AGENT=codex-acp`, 540s, origin/main HEAD with #414
switch). `plannerAgentKind=codex-acp`, `sawReady=true`,
`sawAgentError=false`, status completed.

Span/observation evidence:

- Firegrid runtime-context MCP toolset **discovered**: `McpServer.initialize`
  ×2, `tools/list` ×16, `firegrid.mcp.register_toolkit` (tool_count/
  tool_names present). The agent demonstrably SAW the Firegrid tools.
- `firegrid.agent_output.tag:TextChunk` ×15, **`tools/call` = 0**,
  **`observedToolNames = []`**, `advancedGateEventTypes = []`,
  `s6FullLoopProven=false`, **0/6** steps issued.
- The exploration is GONE: with built-ins trimmed + the hard prompt there
  are NO Read/Search/rg/`codex/list_mcp_resources` calls (contrast tf-pcg).
- The planner emitted a `DARK_FACTORY_FINDING` marker (self-reported a
  surface gap in prose) and the turn ended.

**Finding `dark-factory.codex_acp_constrained_narrates_not_invokes`:**
constraining the toolset + sharpening the prompt successfully REMOVED the
exploration, but did NOT produce choreography. With ONLY the Firegrid
runtime-context tools advertised (tools/list ×16) and an explicit "you
MUST call these tools, do not explore" instruction, codex-acp still issues
ZERO `tools/call` — it narrates and emits a textual finding instead of
invoking `wait_for`/`session_new`. This is deeper than the tf-pcg
explore-instead result: the gap is not "distracted by exploration tools";
codex-acp does not convert the §6 objective + a discovered, exclusive
Firegrid toolset into actual tool invocations under this prompt. The
Firegrid substrate is sound (MCP discovery + advertisement verified); the
remaining gap is squarely agent-side reasoning/invocation. NOT papered (no
matcher loosening; the agent genuinely made no Firegrid call).

## Run 2 — constrained claude-acp (fallback) — SAME DEEP FINDING

Run `2026-05-19T13-44-56-165Z__dark-factory-pipeline` (default profile =
A1 #411 `disableBuiltInTools`+alwaysLoad on origin/main + sharpened
prompt, 540s). `plannerAgentKind=claude-agent-acp`, `sawReady=true`,
`sawAgentError=false`, completed.

- Firegrid toolset **discovered**: `McpServer.initialize` ×4,
  `tools/list` ×16, `McpServer.tools/list` ×4, `register_toolkit`.
- `TextChunk` ×22, **`tools/call` = 0**, `observedToolNames=[]`,
  `advancedGateEventTypes=[]`, **0/6**.
- resultText: the agent NARRATES the entire correct §6 plan in prose —
  *"Proceeding to plan + plan-approval gate. Plan: 1. Spawn implementer
  child session with plan, issue, repo, branch, parent context,
  factoryRunKey. 2. Wait for `github.pr.opened`. 3. Classify review
  scope…"* — and then stops without issuing a single Firegrid
  `tools/call`.

## Cross-agent conclusion (the real, common-cause finding)

Both ACP runtimes, fully toolset-constrained (no exploration tools) and
under an explicit "you MUST call these Firegrid tools, do not explore"
prompt, with the runtime-context MCP toolset verifiably discovered
(`tools/list` ×16, `register_toolkit` both runs), **issue ZERO
`tools/call`**. codex-acp emits a `DARK_FACTORY_FINDING`; claude-agent-acp
writes out the correct §6 tool sequence in prose. Neither converts a
correctly-understood plan into actual Firegrid tool invocations.

The exploration distraction (tf-pcg) was successfully eliminated — that
hypothesis is closed. The residual, common gap is a deeper agent-side
**plan-in-prose vs invoke-the-tool** failure, identical across
claude-agent-acp and codex-acp, with a demonstrably sound Firegrid
substrate (MCP discovery + advertisement verified in BOTH runs). This is
the precise deep finding the dispatch asked for — not papered (no matcher
loosening; the agents genuinely made no Firegrid call).

## Routing

The §6 substrate and the #401/#406/#402 instrumentation are sound and
demo-ready; the unmet piece is purely agent-side: an agent that, given the
exclusive discovered Firegrid toolset, actually ISSUES the choreography
calls instead of describing them. Toolset-constrain levers (prompt +
codex `-c` trims; claude A1 #411) are shipped + gate-ready so any
agent-side fix (e.g. an agent/runtime with stronger tool-forcing, or an
ACP "must-call" tool-choice control) lands on an already-constrained base.
Recorded for coordinator routing.
