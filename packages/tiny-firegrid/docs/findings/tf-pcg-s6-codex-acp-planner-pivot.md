# FINDING — tf-pcg: §6 dark-factory planner pivot to codex-acp + live run

Honest verdict, nothing papered. Two separable results.

## A. Planner-agent pivot mechanism — PASS

`dark-factory-pipeline` is now parameterized by
`DARK_FACTORY_PLANNER_AGENT`:

- unset / anything else → `claude-agent-acp` (existing behavior, default
  preserved; ANTHROPIC_API_KEY, claude-acp argv/agent/env policy);
- `codex-acp` (or `codex`) → codex-acp planner reusing the tf-v2z-proven
  launch shape (`@zed-industries/codex-acp@0.14.0`, `agent: codex-acp`,
  `agentProtocol: acp`, OPENAI_API_KEY binding + codex env policy).

Additive, type-checked, full gate green incl `lint:effect-quality`
(baseline preserved). Live run confirms the switch works end-to-end:
`plannerAgentKind: "codex-acp"`, `sawReady: true`, `sawAgentError: false`,
status `completed`, NO auth/startup error (contrast claude-agent-acp's
ToolSearch + post-A1 turn-abort stall). The pivot itself is proven.

## B. §6 choreography under the codex-acp planner — PRECISE FINDING

Run `2026-05-19T13-33-49-057Z__dark-factory-pipeline`
(`DARK_FACTORY_PLANNER_AGENT=codex-acp`, `TINY_FIREGRID_TIMEOUT=540s`,
origin/main HEAD with merged A1 #411 + #406 + #401 + #402).

`simulate:proof -- latest`: **s6FullLoopProven=false, 0/6 required steps
proven**, every step `issued=false`. `advancedGateEventTypes: []`. Durable
readback: only `factory.trigger.accepted` (the up-front seed).

`observedToolNames` (real ToolUse, public client):

```
Read SKILL.md
Read dark-factory-pipeline.ts
Read tf-7dq-s6-dark-factory-acp-startup-halt.md
Read package.json
Search firegrid-runtime-context|wait_for|session_new|session_prompt|... in packages
Search wait_for|session_new|session_prompt|... in .
Tool: codex/list_mcp_resource_templates
Tool: codex/list_mcp_resources
pwd && rg --files -g 'AGENTS.md' -g 'package.json' ...
```

**Finding `dark-factory.codex_acp_explores_not_invokes`:** with the codex-acp
planner the agent spends the entire window on **codex-native repo
exploration and MCP-resource listing** (Read/Search/`codex/list_mcp_*`/rg)
and **never issues the Firegrid runtime-context §6 tools**
(`wait_for` / `session_new` / `session_prompt` / `mcp__firegrid-runtime-context__*`).
No §6 gate is reached, so #406 in-sequence advancement never fires
(`advancedGateEventTypes: []`) and the proof matrix is 0/6.

Critically — the known codec name-surface gap (bead **tf-2p4**: ToolUse
`part.name` surfaces as the ACP tool_call *title*, e.g. `"sleep 0"`) does
**NOT** explain this. There are **zero** Firegrid-tool-shaped titles in
`observedToolNames` at all; the agent demonstrably issued only codex-native
exploration tools. The harness is not under-counting — codex-acp genuinely
did not invoke the Firegrid choreography toolset for the §6 prompt. (The
matcher was deliberately NOT loosened.)

### Contrast with tf-v2z (codex-acp PROVEN to invoke Firegrid MCP)

tf-v2z proved codex-acp invokes a Firegrid MCP tool end-to-end — but with a
*tiny single-instruction prompt* ("make EXACTLY ONE call to the Firegrid
`sleep` tool"). The §6 dark-factory planner prompt is large and
multi-stage; under it codex-acp does not converge on the runtime-context
toolset — it explores the repo/MCP resources instead. So "codex-acp can
invoke Firegrid MCP" (true, tf-v2z) does not transfer to "codex-acp drives
§6 from the dark-factory planner prompt" (false here). This is the precise,
real, demo-relevant gap.

### Routing

Neither claude-agent-acp (ToolSearch/turn-abort, oca1 #411) nor codex-acp
(explores-not-invokes, here) currently drives §6 end-to-end through the
public surface. The §6 substrate path remains sound (#401/#406/#402
instrument it; trigger fact durable+readable). The remaining gap is
agent-side: getting a real planner to *issue* the Firegrid runtime-context
choreography tools under the full §6 prompt. Candidate directions
(coordinator decision, not taken here — scope/substrate-boundary):
prompt-shaping to steer the agent to the runtime-context toolset first;
constraining/pre-listing the MCP toolset; or an agent/runtime that binds
the runtime-context MCP server more directly. Recorded for routing; the
pivot mechanism (A) is shipped and gate-ready so codex-acp is an available
planner the moment the agent-side issue is addressed.
