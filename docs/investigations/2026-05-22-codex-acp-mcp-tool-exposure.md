# Findings — codex-acp surfaces only a partial Firegrid MCP toolset (progressive publication × no-refresh snapshot)

**Date:** 2026-05-22
**Status:** Root cause identified (source + trace + behavior triangulated). Firegrid-side fix proposed; ticket-worthy. One open question (why `tools/list_changed` fires 11×).
**Context:** Live ACP test/validation loop (see `docs/handoffs/2026-05-22-acp-live-validation-loop-handoff.md`). This session swapped the `acp-tool-elicitation` sim from claude-acp to codex-acp to ride out an Anthropic provider-degradation window, and in doing so surfaced a real MCP-tool-exposure bug.

---

## TL;DR

- **codex-acp is a viable ACP agent for the validation loop.** It speaks ACP, supports HTTP MCP, streams `session/update`, auto-approves permissions, and exercises the durable output cursor. A full 15-turn run completed with **0 errors** (`turn_count=15, error_count=0, aborted=false`).
- **But codex sees only a *subset* of the Firegrid runtime-context toolset.** The MCP server registered **all 11 tools** (`tool_profile=full`), yet across two codex builds the agent only ever called **`sleep`** (and a `startup` bootstrap tool). For `wait_for` / `send` / `wait_for_any` / `session_new` / `schedule_me` it told the user the tool "is not available in this session."
- **Root cause is an interaction bug, not a codex filter:** the Firegrid MCP server **publishes its toolset progressively** and fires `notifications/tools/list_changed` **11×** per run; the **Codex engine fetches the MCP tool list once at session start and has *no* `tools/list_changed` handler** (confirmed by source search across the codex-acp repo). So codex captured only the early subset and never refreshed. claude-acp honors `list_changed`, so it sees all 11.
- **Implication beyond codex:** *any* MCP client that snapshots tools once and ignores `tools/list_changed` will see a partial Firegrid toolset. The fragility is on the Firegrid side.
- **Operational takeaway:** use **claude-acp** for `wait_for`/`send`/`session_new`/`schedule_me`/child-session elicitation; codex-acp is fine for edge/transport/streaming/`sleep` validation and as a provider-outage fallback.

---

## 1. Background — why we tried codex at all

Two consecutive claude-acp runs were contaminated by **Anthropic provider degradation**:

| Run | Symptom | Edge classification |
|---|---|---|
| `…04-44…` | explicit `API Error: 529 {"type":"e…` (overloaded) + cascading turn timeouts; 0 tool calls | generic `timeout` |
| `…04-57…` | agent spawned + `initialize` + `session/new` OK, then **emitted nothing** for ~34s/turn | typed `agent_silent` (`AcpStdioEdgeTurnOutputError`, "agent produced no further output") |

The `04-57` wire confirmed the agent accepted `session/prompt` (id=2, id=3) and returned **zero** responses — a silent hang inside claude-acp's completion path, almost certainly the same degraded-provider window as `04-44` manifesting as a stall instead of a hard 529.

To keep the loop moving (and to get a different-provider control), we swapped the agent to **codex-acp** (OpenAI). That run was clean — and exposed the tooling finding below.

---

## 2. Method

1. **Hardened the elicitation driver** (`packages/tiny-firegrid/src/simulations/acp-tool-elicitation/driver.ts`) so contaminated runs are *contained and labeled* rather than smeared:
   - Per-turn **outcome classification** → span attr `firegrid.acp_elicitation.outcome` ∈ `{ok, empty_end_turn, provider_overloaded, acp_timeout, internal_error, driver_error}`.
   - **Fail-fast**: abort the matrix after **2 consecutive** failure outcomes (provider/timeout/internal/driver), skipping the remaining prompts so one bad provider window can't drain the runner budget. Driver span records `aborted` / `aborted_after` / `planned_turn_count` vs `turn_count`.
   - **Grouped + reordered prompts** (`prompts.ts`): `baseline` (cheap, runs first as a de-facto preflight) → `channel` → `child` → `scheduler`; each turn span carries `firegrid.acp_elicitation.group`.
2. **Swapped the agent** (`host.ts`): `argv` → `npx … codex-acp`, `agent` label → `codex-acp`, env binding `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` (both in `local.jsonl` and the host `FiregridEnvBindingsFromEnv` allow-list). A revert block to claude-acp is in the file comment. **Prompts unchanged** — tool names come from the MCP server, so the matrix is agent-agnostic.
3. **Tested two codex distributions:** `@zed-industries/codex-acp` (Rust engine) and `@agentclientprotocol/codex-acp` (TypeScript wrapper around the Codex app-server).
4. **Analyzed** with `scripts/acp-trace-health.py` + ad-hoc Python over the per-run `trace.jsonl` (one ended OTel span per line). The decisive window is the **ACP wire** (`firegrid.wire.raw` on the `local_process` byte stream) and the **MCP server spans** (`firegrid.mcp.register_toolkit`, `McpServer/Notifications.notifications/tools/list_changed`).

---

## 3. Findings

### 3.1 codex-acp works as an ACP agent (positive control)

`@agentclientprotocol/codex-acp` run `2026-05-22T05-10-24-835Z` — single clean trace (1 driver span, 1 traceId, **not** append-mixed):

- `turn_count=15, planned_turn_count=15, error_count=0, aborted=false` — **completed the full matrix.**
- **0 error spans**, 292 streamed `acp.session_update` (codex *does* stream incrementally — resolves a prior open question), **output-read amplification 1.03×** (healthy; near-zero re-walk).
- HTTP MCP attaches: `mcpCapabilities.http(true)`, `session/new` carries `mcpServers:[{type:http,…}]`, server registers the toolkit.
- `sleep` works end-to-end (`tools=[sleep 2]` → "I woke up"; `tools=[sleep 0.25]` → "All three sleeps completed").

> Note: ~106k spans for 15 turns is dominated by runtime substrate chatter — `firegrid.durable_table.get` ×24,862 — not codex. Consistent with the known `durable_table.get` chatter signal; out of scope here.

### 3.2 THE finding — codex surfaces only `sleep` + `startup` of 11 registered tools

The runtime-context MCP server registered the **full** toolset (`firegrid.mcp.register_toolkit` attrs):

```
tool_count   = 11
tool_profile = full
tool_names   = call, execute, schedule_me, send, session_cancel, session_close,
               session_new, session_prompt, sleep, wait_for, wait_for_any
```

But the **ACP wire** (`tool_call` notification titles) shows codex only ever invoked:

| Build | Run | tool_call titles on the wire | turns |
|---|---|---|---|
| `@zed-industries/codex-acp` | `…05-05…` | `sleep 2` ×1, `sleep 0.25` ×3 | 13 (driver span didn't close — interrupted at capture) |
| `@agentclientprotocol/codex-acp` | `…05-10…` | `mcp__firegrid-runtime-context__startup` ×1, `sleep 2` ×1, `sleep 0.25` ×3 | **15 (clean completion)** |

For every other tool, codex **never issued a `tool_call`** and reported it absent (per-turn `text`):

- `known_lifecycle_wait`: "no `wait_for` tool is available in this session"
- `wait_for`: "`wait_for` is not available in this session… requested tool unavailable"
- `send`: "no `send` tool is available… I searched available **deferred tools** and only found unrelated"
- `wait_for_any_mixed`: "`wait_for_any` is not available in this session"
- child-session / scheduler turns: all `tools=[]`

This is **invoke-never**, not invoke-and-fail. The behavior **reproduced identically across both codex distributions**, so it is a Codex-engine trait, not a package bug.

The namespacing is visible on the wire: `mcp__firegrid-runtime-context__startup` — the Codex `CodexToolCallMapper.ts` names MCP tools `mcp.${server}.${tool}`, converted to `mcp__server__tool` for the OpenAI function name. The mapper itself does **no** filtering.

### 3.3 Root cause — progressive publication × no-refresh snapshot

Triangulated:

1. **Firegrid publishes the toolset progressively.** The server fires `McpServer/Notifications.notifications/tools/list_changed` **11×** per run (both runs). The toolset the agent can see therefore *changes over the session*, not just at registration.
2. **The Codex engine snapshots MCP tools once and never refreshes.** Source search across `agentclientprotocol/codex-acp` for `listChanged`, `list_changed`, `notifications/tools`, `tools/list`, `refreshTools` → **zero matches**. The only MCP-tool-listing path is `McpListToolsResponseEvent` from the underlying Codex app-server, fetched at session start. `CodexToolCallMapper.ts` does no filtering. (`@zed-industries/codex-acp`'s Rust `build_session_config()` likewise has no `list_changed` subscription.)
3. **Therefore** codex captured only the tools present at its first `tools/list` (`startup` + `sleep`) and ignored the 11 subsequent `list_changed` announcements that added `wait_for`/`send`/etc. It then truthfully told the model those tools don't exist.
4. **claude-acp honors `tools/list_changed`** and re-pulls — which is why it uses all 11 in the live Zed loop.

**Generalization:** the bug is on the Firegrid side. Any MCP client that does not subscribe to `tools/list_changed` — codex today, possibly other real-world MCP integrations — will see whatever partial toolset existed at its first fetch. Relying on `list_changed` to deliver the *core* toolset is non-portable.

### 3.4 The hardened driver contained the contamination (validated)

On the `04-57` claude-acp silent-hang run, the hardened driver behaved exactly as designed: turns 1 (`introspection`) and 2 (`sleep`) classified `internal_error`, **2 consecutive failures tripped the fail-fast**, `aborted=true, aborted_after=sleep`, remaining 13 prompts skipped — ~68s spent instead of a full-budget drain, and the run self-labeled as junk without DuckDB archaeology. (The edge's typed `agent_silent` reason does **not** reach the driver — the ACP client sees a generic `"Internal error"`, so the driver-side `outcome` lands on `internal_error`; correlate to the edge span for the precise reason.)

---

## 4. Recommendations

### Firegrid-side (the real fix)
1. **Publish the full runtime-context toolset synchronously *before* the agent's first `tools/list`**, instead of progressively + 11× `list_changed`. This makes the toolset portable to no-refresh MCP clients (codex and others) — not a codex workaround, a correctness/portability fix. **(File a ticket.)**
2. **Drill *why* `tools/list_changed` fires 11×** (open question §6) to decide between "register synchronously / earlier" vs "collapse the re-publishes." `register_toolkit` shows a single atomic 11-tool registration, so the 11 notifications come from elsewhere (per-context re-publish? per-session? a registration race). This determines the exact fix shape.
3. Consider a **conformance check**: assert the core toolset is present in the *initial* `tools/list` a fresh MCP client receives (no reliance on `list_changed`).

### Loop / tooling
4. **Agent matrix, not agent swap.** Keep codex-acp reachable as a *variant* (provider-outage fallback + cross-agent control), but route tool-elicitation findings through claude-acp. Consider a second sim id (e.g. `acp-tool-elicitation-codex`) so both run without editing `host.ts`.
5. **Driver classifier refinement (minor):** a silent-but-`end_turn` agent currently lands on `empty_end_turn` (not a failure → won't trip fail-fast). If we want silence to fail-fast, fold `empty_end_turn` into the failure set or correlate the edge `agent_silent` reason into the driver. Leave as-is unless silent-completion runs become common.
6. **`acp-trace-health.py` artifacts still apply:** `tool-call balance=0` is a span-name mismatch (tools *did* run); read the ACP wire `tool_call` titles for ground truth, as done here.

### Provider hygiene
7. The Anthropic 529 → silent-hang window (≈04:44–04:57) is upstream; the fail-fast is the right mitigation. No Firegrid action beyond the classification already shipped.

---

## 5. Evidence index (reproducible)

Decisive queries (run against the per-run `trace.jsonl`):

- **Registered toolset:** span `firegrid.mcp.register_toolkit` attrs `firegrid.mcp.tool_count` / `…tool_names` / `…tool_profile`.
- **What codex actually called:** `tool_call` notification `title`s extracted from `firegrid.wire.raw` attributes → only `sleep`/`startup`.
- **Per-turn outcome/text:** `firegrid.acp_tool_elicitation.turn` span attrs `firegrid.acp_elicitation.{label,group,outcome,tool_calls,text}`.
- **Run completion:** `firegrid.acp_tool_elicitation.driver` attrs `turn_count` / `error_count` / `aborted`.
- **Progressive publication:** count of `McpServer/Notifications.notifications/tools/list_changed` spans (= 11).
- **Codex no-refresh:** `gh api search/code q="<term> repo:agentclientprotocol/codex-acp"` for list_changed/refresh terms → none; `listTools` → `src/app-server/McpListToolsResponseEvent.ts`.

| Run | Build | Spans | Turns | Errors | Tool calls (wire) |
|---|---|---|---|---|---|
| `2026-05-22T04-44…` | claude-acp | 4647 | 0 useful | 28 (529 + timeouts) | none |
| `2026-05-22T04-57…` | claude-acp | 1005 | 2 (fail-fast) | `agent_silent` ×2 | none |
| `2026-05-22T05-05…` | zed/codex-acp | 107042 | 13 | 0 | `sleep` only |
| `2026-05-22T05-10…` | acp/codex-acp | 106209 | **15 (clean)** | 0 | `startup` + `sleep` |

---

## 6. Open questions

1. **Why does `tools/list_changed` fire 11×** when `register_toolkit` is a single atomic 11-tool registration? (Per-context re-publish across parent + child `session.start`? Per-turn? A registration race?) This pins the exact fix.
2. **Does the Codex app-server fetch `tools/list` before or after our toolkit publishes?** If we can guarantee publish-before-first-fetch, the no-refresh client is satisfied without any `list_changed` reliance.
3. **Which other ACP/MCP clients ignore `tools/list_changed`?** Worth checking the broader MCP ecosystem before assuming this is codex-only.

---

## 7. File / artifact index

| Concern | Path |
|---|---|
| Hardened elicitation driver (classification + fail-fast) | `packages/tiny-firegrid/src/simulations/acp-tool-elicitation/driver.ts` |
| Grouped prompt matrix | `packages/tiny-firegrid/src/simulations/acp-tool-elicitation/prompts.ts` |
| Agent swap (codex-acp; revert block to claude-acp in comment) | `packages/tiny-firegrid/src/simulations/acp-tool-elicitation/host.ts` |
| Trace-health analyzer | `scripts/acp-trace-health.py` |
| ACP stdio edge (typed `agent_silent` reason) | `packages/host-sdk/src/host/acp-stdio-edge.ts` |
| Codex tool mapper (no filtering; `mcp.${server}.${tool}` naming) | `agentclientprotocol/codex-acp:src/CodexToolCallMapper.ts` |
| Codex MCP list-tools event (single fetch) | `agentclientprotocol/codex-acp:src/app-server/McpListToolsResponseEvent.ts` |
| Prior loop handoff | `docs/handoffs/2026-05-22-acp-live-validation-loop-handoff.md` |
| Related: parent→child output gap (claude path) | `docs/investigations/2026-05-21-acp-parent-child-output-channel-gap.md` |

---

## 8. Reproduce

```bash
# codex-acp (current host wiring): needs OPENAI_API_KEY in env
TINY_FIREGRID_TIMEOUT="300 seconds" \
  pnpm --filter @firegrid/tiny-firegrid simulate:run acp-tool-elicitation

# analyze
python3 scripts/acp-trace-health.py \
  packages/tiny-firegrid/.simulate/runs/<run-id>/trace.jsonl

# ground-truth tool calls (the metric the health report can't be trusted on):
#   extract `tool_call` titles from firegrid.wire.raw attributes (see §5)

# switch back to claude-acp: restore the argv / agent label / ANTHROPIC_API_KEY
#   bindings per the revert block in host.ts (needs ANTHROPIC_API_KEY)
```
