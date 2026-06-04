# FINDING — tf-xyo: thin ACP-shim forced tool-call — HARDENED TERMINAL FINDING

The shim angle (oca3) of the demo keystone. oca1 owns the native
tool_choice angle; this lane owns the thin ACP-interposer angle. Honest
result, not papered: the shim provably engaged and the constrained planner
still issued ZERO Firegrid `tools/call`. This hardens the tf-9q4
cross-runtime terminal finding and adds a precise architectural boundary.

## What was built (additive, gate-green, substrate untouched)

`packages/firelab/src/bin/acp-force-tool-shim.mjs`: a transparent
stdio ndjson interposer between the Firegrid ACP codec and the real ACP
agent. Its ONLY lever is an honest forced-retry contract — when a
`session/prompt` turn ends with no `session/update{sessionUpdate:tool_call}`
observed, the shim sends an escalating additional `session/prompt`
(reserved id; that injected response swallowed so the codec's protocol
state is untouched) demanding exactly one Firegrid tool call and nothing
else. The agent must still emit the tool_call itself; the shim only
refuses to accept prose-only completion. Bounded (MAX_FORCES=4). Wired via
additive `DARK_FACTORY_FORCE_TOOL_SHIM=1` (default off → argv unchanged).

## Live run — codex-acp + shim (the best candidate: no startup/turn-abort)

Run `2026-05-19T13-55-07-211Z__dark-factory-pipeline`
(`DARK_FACTORY_PLANNER_AGENT=codex-acp DARK_FACTORY_FORCE_TOOL_SHIM=1`,
540s, origin/main HEAD). `plannerAgentKind=codex-acp`, `sawReady=true`,
`sawAgentError=false`, completed.

**The shim engaged (evidenced, not assumed):** `firegrid.agent_output.tag:
TextChunk` ×**144** and `acp.session_update` ×**172** — a ~6x explosion
over the unshimmed constrained run (tf-9q4 claude ≈22 TextChunk, same
planner prompt). That volume is the forced-retry loop driving repeated
extra turns. The planner prose even answers the forcing directly: *"I'll
first inspect the local Firegrid/acai instructions and discover whether
the required factory tools … are exposed … If they are not exposed, the
simulation's halt rule applies."*

**Outcome:** Firegrid runtime-context toolset discovered (`tools/list`
×16, `register_toolkit` ×2). Total tool activity: exactly ONE `tool_call`
+ one `tool_call_update` — and `observedToolNames=["Read SKILL.md"]`
(codex's own exploration tool, surfaced as the ACP tool_call title per the
known tf-2p4 codec name-surface gap). **Zero Firegrid `tools/call`.**
`s6FullLoopProven=false`, **0/6**, `advancedGateEventTypes=[]`. The run
ended with `DARK_FACTORY_FINDING`.

## Conclusion — hardened + a precise architectural boundary

1. **Shim-resistant.** A thin ACP-layer forced-retry interposer, which
   provably drove many extra forced turns, could NOT make the constrained
   codex-acp planner emit a single Firegrid `tools/call`. Combined with
   tf-9q4 (cross-runtime: claude-agent-acp AND codex-acp both
   narrate/explore-not-invoke), the agent-side forced-invocation gap is now
   cross-runtime AND shim-resistant.

2. **Why — the architectural boundary (decision-grade):** an ACP-layer
   interposer can refuse prose-only completion and re-drive the turn, but
   it CANNOT make the underlying model *choose* a tool. Tool-choice forcing
   (`tool_choice: required/any`) lives inside the agent's own
   model-request, which is internal to codex/claude and NOT reachable from
   the ACP protocol layer. So forced tool invocation is not achievable by a
   thin ACP shim by construction — it must be a native agent/model
   tool_choice control. This is exactly the complementary half of oca1's
   native angle: between these two lanes, the shim angle is now closed as
   "provably insufficient at the ACP layer," concentrating the keystone on
   native tool_choice.

The Firegrid §6 substrate + #401/#406/#402/#409 instrumentation remain
sound and demo-ready (MCP discovery/advertisement verified again here).
The sole remaining lever is native tool_choice forcing (oca1). The shim
switch is shipped + gate-ready as negative evidence and as a reusable
forced-retry harness should a native fix want a belt-and-suspenders ACP
contract on top. NOT papered: no matcher loosening; the agent genuinely
made no Firegrid call despite the shim.
