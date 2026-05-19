# FINDING — §6 agent-runtime config to bypass ToolSearch: HARD-HALT

Bead `tf-p9s` (P0, demo keystone). Per the owed-next-step from #405:
attempt an **agent-runtime / sim-config** (NOT Firegrid substrate) change
so the live §6 dark-factory planner issues Firegrid MCP `tools/call`.

**Verdict: HARD-HALT. No sim-config-level (argv/env) lever exists in any
available ACP runtime to bypass the ToolSearch deferred-discovery
indirection without changing Firegrid substrate (the ACP codec), which
this lane is explicitly forbidden to touch.** This is the precise external
dependency for the §6-run demo. No code shipped (papering would be wrong).

## Source-verified lever analysis (decision-grade, not inference)

Inspected `@agentclientprotocol/claude-agent-acp@0.36.1` (latest;
published 23h ago) `dist/` and its `@anthropic-ai/claude-agent-sdk@0.3.143`
`sdk.d.ts`.

1. **The ONLY documented no-defer lever is per-MCP-server
   `alwaysLoad: true`** (`McpHttpServerConfig.alwaysLoad`, `sdk.d.ts:1063`:
   "all tools from this server are always included … never deferred behind
   tool search. Equivalent to `defer_loading: false`"). There is **no
   global tool-search disable** — no SDK option, no env var, no CLI flag.
2. **claude-agent-acp@0.36.1 strips `alwaysLoad` for ACP-advertised HTTP
   MCP servers.** `dist/acp-agent.js:1346-1356` maps each
   `params.mcpServers[*]` (http) to `{ type, url, headers }` only — no
   `alwaysLoad`, and the ACP `McpServer` schema has no such field.
3. **The merge order makes `_meta.claudeCode.options.mcpServers`
   ineffective.** `dist/acp-agent.js:1438`:
   `mcpServers: { ...(userProvidedOptions?.mcpServers || {}), ...mcpServers }`
   — the ACP-derived server (no `alwaysLoad`) is spread LAST and overrides
   any user-provided same-named entry.
4. **No claude-agent-acp argv/env toggle.** `process.argv` handling is
   only `--cli` / `--hide-claude-auth` (`dist/index.js:4`,
   `dist/acp-agent.js:82`). Env handling covers `ANTHROPIC_*`,
   `CLAUDE_CODE_*`, `MAX_THINKING_TOKENS`, `CLAUDE_MODEL_CONFIG`,
   `CLAUDE_CONFIG_DIR` — none gate tool-search deferral.
5. The only remaining paths — (i) `_meta.claudeCode.options` with a
   non-colliding server name, (ii) ACP `McpServer` carrying a no-defer
   flag, (iii) `_meta.disableBuiltInTools` to drop total tool count below
   the tool-search threshold — **all require the Firegrid ACP codec to
   change what it sends in `session/new`** (`_meta` / `mcpServers`). That
   is Firegrid substrate, explicitly out of scope for this lane and an
   architect-gated decision.

The dark-factory sim config (`local.jsonl`: argv/env/agent/agentProtocol/
envBindings/runtimeContextMcp) cannot reach any of these — ACP `_meta`
and the advertised `mcpServers` are built by the codec, not the sim
config.

## Option (b): a different ACP runtime — none better

- `codex-acp@0.14.0`: G-MCP-2-verified **non-enumerating** (never issues
  `tools/list`) — strictly worse; cannot call MCP tools at all.
- `claude-code-acp`: same Claude tool-search family AND requires Claude
  OAuth, not just `ANTHROPIC_API_KEY` (tf-ahk finding).
- No other vetted ACP runtime with non-deferred direct MCP exposure is
  available.

## Option (c): live re-run — deliberately NOT run

A re-run now is uninformative and wasteful: (1) the #405-confirmed
external Anthropic usage limit persists until 2026-06-01 UTC; (2) even
with quota, the lever analysis above is source-verified — deferral is
unbypassable via sim config. #405 already established the trace behavior
across 3 runs. Re-running would reproduce the same stall and burn a
~9-minute run for no new information. Not papered with a futile run.

## The precise external dependency for the §6-run demo

§6 RUN is blocked behind exactly one of (architect/owner decision —
NOT this lane):

- **A1 (substrate, architect-gated):** Firegrid ACP codec advertises the
  runtime-context MCP server with a no-defer signal — i.e. set
  `_meta.claudeCode.options.mcpServers[<name>] = { type:'http', url,
  alwaysLoad:true }` (with a name that does not collide with the
  ACP-derived entry, or by injecting the server only via `_meta`), or set
  `_meta.disableBuiltInTools` to shrink the tool set below the tool-search
  threshold. This is a scoped, additive codec change but it IS substrate
  and was deliberately excluded from this lane.
- **A2 (upstream agent-runtime):** a `@agentclientprotocol/claude-agent-acp`
  release that forwards a per-server `alwaysLoad`/no-defer flag from ACP
  `McpServer` declarations (upstream feature request).
- **A3 (external):** Anthropic quota regained (≥ 2026-06-01 UTC) — even
  then A1 or A2 is still required for the planner to skip the ToolSearch
  indirection.

Recommendation: open a scoped, architect-gated substrate bead for **A1**
(codec advertises `alwaysLoad` for the runtime-context MCP server via ACP
`_meta.claudeCode.options`) — it is the only path fully in Firegrid's
control and is minimal/additive. Firegrid substrate + MCP surface remain
source-verified correct (#405); §6 durability independently PROVEN (#397).
This finding is the demo's precise blocking external dependency.

Coordinator/architect holds the gate; no self-merge.
