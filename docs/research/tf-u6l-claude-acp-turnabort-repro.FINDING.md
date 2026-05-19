# FINDING — §6 residual pinned: claude-agent-acp does not invoke ACP HTTP MCP tools (UPSTREAM)

Bead `tf-u6l` (P1). Direct, Firegrid-free repro characterizing the
post-A1 §6 residual. **HARD-HALT verdict: the §6-run blocker is an
UPSTREAM defect in `@agentclientprotocol/claude-agent-acp@0.36.1` /
`@anthropic-ai/claude-agent-sdk@0.3.143` — it does not complete the
ToolSearch→`tools/call` round-trip for ACP-advertised HTTP MCP servers.
Not Firegrid; not (only) Anthropic quota.** No papering.

## Method — direct repro, zero Firegrid

`docs/research/tf-u6l-claude-acp-turnabort-repro/repro.mjs` (+ `repro-v2.mjs`)
drive `npx -y @agentclientprotocol/claude-agent-acp@0.36.1` over raw ACP
JSON-RPC stdio with `ANTHROPIC_API_KEY` (`~/.firegrid-anthropic-key`,
quota verified). V2–V4 stand up a **known-good non-Firegrid**
`@modelcontextprotocol/sdk@1.29.0` stub MCP HTTP server exposing one tool
(`stub_echo`) and prompt the agent: *"Call the stub_echo tool … You MUST
call the tool."* Logs (`repro-v1..v4.log`) are committed.

| variant | config | result | stub `tools/call` |
|---|---|---|---|
| V1 | `disableBuiltInTools`, **no MCP**, long planning prompt | `PROMPT_RESOLVED` 35.7s, `end_turn` | n/a |
| V2 | **exact A1**: ACP mcp + `_meta` alias `alwaysLoad:true` + `disableBuiltInTools` | `PROMPT_RESOLVED` 2.5s; agent: *"I don't have access to a `stub_echo` tool"* | **0** |
| V3 | `_meta` alias `alwaysLoad:true`, **no** `disableBuiltInTools` | `PROMPT_RESOLVED` 9.3s; agent runs `ToolSearch` (`query:"select:stub_echo"`) ×2 | **0** |
| V4 | pure ACP `mcpServers` (pre-A1 baseline), no `_meta` | `PROMPT_RESOLVED` 11.1s; `ToolSearch` ×2 then `end_turn` | **0** |

## Source-verified conclusions

1. **The bare model turn is healthy** (V1: a 35.7s planning turn resolves
   `end_turn`). This **refutes** the earlier #405/tf-7dq framing that the
   §6 blocker is an external Anthropic quota/model-turn wall. Quota is
   working; the model turn is not the problem.
2. **A1's `alwaysLoad` `_meta` alias is NOT honored** (V3: with the alias
   and no `disableBuiltInTools`, the agent STILL defers `stub_echo` behind
   `ToolSearch` — `query:"select:stub_echo"`). The
   `_meta.claudeCode.options.mcpServers[...alwaysLoad:true]` lever does not
   make ACP-advertised HTTP MCP tools non-deferred in claude-agent-acp@0.36.1.
3. **A1's `disableBuiltInTools` removes ToolSearch but leaves MCP tools
   unreachable** (V2: agent has *no access* to the stub tool;
   `stubToolCalls:0`). So A1 as merged (#411) does **not** achieve direct
   MCP invocation. **This corrects the prior tf-b6n/#411 finding**, which
   over-claimed "A1 succeeds for its purpose; the planner reasons directly
   about the tools." The §6 A1 run's planner named `session_new`/`wait_for`/
   `execute` only because the *prompt text* names them — the tools were
   never actually callable. A1 did remove the ToolSearch *stall*, but by
   removing all tools, not by enabling MCP invocation.
4. **Even the pre-A1 baseline never invokes the MCP tool** (V4: `ToolSearch`
   ×2 then `end_turn`, `stubToolCalls:0`) against a known-good stub MCP
   with an explicit "you MUST call the tool" prompt. Across **every**
   realistic config the stub MCP server received **zero** `tools/call`.

**Root-cause classification: UPSTREAM.**
`@agentclientprotocol/claude-agent-acp@0.36.1` (over
`@anthropic-ai/claude-agent-sdk@0.3.143`) surfaces ACP-advertised HTTP MCP
tools through its `ToolSearch` discovery indirection but does **not follow
through with the MCP `tools/call`** (or, with `disableBuiltInTools`, does
not expose them at all). This is reproduced with **zero Firegrid code in
the loop** (a `@modelcontextprotocol/sdk` stub server), so it is not a
Firegrid substrate/MCP defect (Firegrid's MCP surface remains
source-verified correct, #405) and not merely external quota (V1).

## Recommendation (HARD-HALT — owed external dependency)

- The §6-run demo's precise external dependency is now named and
  Firegrid-free-reproducible: **claude-agent-acp ≤0.36.1 does not invoke
  ACP-advertised HTTP MCP tools** (ToolSearch discovers, no `tools/call`
  follows). File an upstream issue with `repro-v2.mjs` (V4 variant:
  `REPRO_DISABLE_BUILTINS=0 REPRO_ALIAS=0`) as the minimal reproduction.
- **Reopen/relabel A1 (#411):** it does not enable MCP invocation; it
  should not be cited as the §6-run fix. (Keep it only if independently
  justified; otherwise it is inert for the demo.) Surfaced, not papered.
- Firegrid-side options are architect-gated and outside this lane: a
  different agent runtime that completes MCP `tools/call` (none currently
  known — codex-acp is non-enumerating per G-MCP-2; claude-* defer and do
  not invoke), or a non-ACP tool-invocation path.
- The previously-flagged "humanize non-JSON-RPC turn-abort" codec
  follow-on is **deprioritized**: there is no error to humanize — the
  agent ends its turn cleanly (`end_turn`) without ever calling the tool.
  The gap is invocation, not error legibility.

Every Firegrid-controllable §6 fix is done and source-verified; the
residual is pinned to a named third-party cause with a Firegrid-free
repro. Coordinator/architect holds the gate; no self-merge.
