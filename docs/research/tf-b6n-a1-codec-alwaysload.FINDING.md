# DELIVERY + RESIDUAL — tf-b6n A1: ACP codec alwaysLoad (bypass ToolSearch)

Bead `tf-b6n` (P0, demo keystone). Implements the PO-authorized A1 from
#408/tf-p9s and verifies it live. **A1 succeeded for its purpose; a
distinct external residual remains — HARD-HALT on that residual (it is
genuinely A2/upstream + A3/external, NOT Firegrid, NOT A1-fixable).**

## A1 implemented (additive, source-verified-motivated)

`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`: the codec
now additively attaches an ACP `_meta` payload on `session/new`
re-advertising the runtime-context MCP server under a NON-COLLIDING alias
(`<name>-alwaysload`) with `alwaysLoad:true`, plus `disableBuiltInTools`,
inside the reserved `_meta` namespace. Other ACP agents MUST NOT assume
values at `_meta` keys → no behavior change for non-claude-acp paths;
omitted when there are no MCP servers. ACP `mcpServers` advertisement
unchanged. ACP codec test updated to the new contract.

Gate green: runtime typecheck, ACP codec 11/11, host-sdk codec-event-plane
6/6, lint, lint:deps, lint:dead, lint:dup 50/50, **lint:effect-quality
ratchet OK** (helper written functionally, no for-of).

## A1 VERIFIED to work (live run 2026-05-19T13-18-31-562Z, real key)

SOURCE-VERIFIED — the #405 ToolSearch discovery→invocation stall is
ELIMINATED:

- #405: `observedToolNames:["ToolSearch"]`; planner stalled calling the
  deferred-discovery meta-tool, never reasoned about the real tools.
- A1 run: **zero `ToolSearch` tool_call** (disableBuiltInTools removed the
  claude_code built-in toolset that hosts ToolSearch). The planner reasons
  DIRECTLY about the Firegrid tools by name — verbatim from the captured
  plan: "Delegate to a single implementer child session (`session_new`) …
  Wait for `github.pr.opened` … Spawn one reviewer session via
  `session_new`. Wait for `github.pr.review_approved` … loop via
  `session_prompt` … `schedule_me` a bounded CI recheck, then `wait_for
  github.ci.status` green … Attempt `execute` against
  `github.squashMergePullRequest`". A1 mechanically does exactly what #408
  predicted: it removes the ToolSearch indirection.

## RESIDUAL — HARD-HALT (external / A2-upstream, not Firegrid, not A1)

§6 still does not RUN (`simulate:proof` 0/6; `observedToolNames:[]`).
SOURCE-VERIFIED residual, distinct from the (now-fixed) ToolSearch stall:

- `firegrid.agent_event_pipeline.acp.prompt` span **status: `failure`**,
  duration ≈ **21.4s** (start→end ns), i.e. `connection.prompt()`
  REJECTED ~21s into the planner turn.
- The captured planner text is **truncated mid-sentence** ("…if the
  capability is not advertise…") — the model turn was interrupted/aborted
  while still authoring the plan, BEFORE emitting any `tool_use`. Hence
  zero `McpServer.tools/call`, `sawTurnComplete:false`.
- No usable `agentError` surfaced despite merged tf-ds2/#403: the
  `@agentclientprotocol/sdk` failure for this mode does not carry a
  JSON-RPC `{code,message}` `jsonRpcErrorMessage` can extract — a
  secondary observability gap (tf-ds2 covers only the JSON-RPC-shaped
  failure; this turn-abort yields a bare cause).
- No `429`/`529` (earlier grep "matches" were span/trace-id substrings —
  explicitly NOT a rate-limit signal; not over-claimed).

The planner-turn failing ~21s in, mid-plan, before tool use, with no
JSON-RPC-shaped error, is convergent with the #405-family external
Anthropic dependency (the model turn does not complete a sustained
planning+tool-use turn). The PO "HTTP200 probe" proves a single cheap call
works, not a ~21s+ planning turn. A1 cannot fix a failing model turn.

## Verdict

- **Land A1**: it is correct, additive, source-verified, and demonstrably
  eliminates the #405 ToolSearch demo blocker — material keystone progress
  ("§6 reasoned" now reasons directly about the real Firegrid tools) and a
  prerequisite for any further §6-run progress.
- **Residual is genuinely A2/upstream + A3/external**, NOT Firegrid: the
  claude-agent-acp model turn aborts ~21s in before tool invocation.
  Owed next (NOT this lane): (1) a longer-budget / quota-confirmed live
  re-run after the planner-turn failure mode is characterized with a
  real claude-agent-acp repro (as tf-7dq did for #405); (2) extend the
  codec error surface to also humanize non-JSON-RPC ACP turn-abort causes
  (small additive observability follow-on, separate bead) so this residual
  is self-diagnosing in the trace.

Firegrid substrate + MCP surface remain source-verified correct (#405);
§6 durability independently PROVEN (#397). Coordinator/architect holds the
gate; no self-merge.

## simulate:proof — latest (pasted per dispatch)

```
## §6 dark-factory proof — 2026-05-19T13-18-31-562Z__dark-factory-pipeline
- simulation: dark-factory-pipeline · status: completed
### ⚠️ §6 NOT fully proven — 0/6 required steps proven-run
| step | issued | backingFact | advanced | verdict |
| planner-plan | – | – | – | ✗ not-proven |
| human-approval-wait | – | – | – | ✗ not-proven |
| delegated-implementer | – | – | – | ✗ not-proven |
| review-round | – | – | – | ✗ not-proven |
| revision-loop | – | – | – | ❓ conditional |
| merge-signoff-wait | – | – | – | ✗ not-proven |
| durable-ci-watch | – | – | – | ✗ not-proven |
| clean-unwind | – | – | – | ⛔ substrate-blocked |
Durable readback fact event types: factory.trigger.accepted
```
(Pre-A1 #405 baseline: `observedToolNames:["ToolSearch"]`, stalled at
discovery. A1 removes that indirection; the residual is the upstream
model-turn abort above.)
