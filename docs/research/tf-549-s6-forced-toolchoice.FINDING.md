# TERMINAL FINDING — no available ACP path exposes forced tool-choice for the §6 planner

Bead `tf-549` (P0, demo keystone). **HARD-HALT, source-verified, not
papered.** The §6 demo conclusion: the Firegrid substrate is complete and
proven; live agent-driven §6 is blocked **solely** on agent-side forced
tool-invocation, and **no available ACP runtime — nor the ACP protocol
itself — exposes a forced tool-choice / must-call primitive.**

## The gap (cross-runtime, decision-grade, established)

Across claude-agent-acp AND codex-acp, fully constrained
(`disableBuiltInTools`, Firegrid-only MCP, sharpened tool-first prompt;
A1 #411, oca3 #420, tf-9q4 Run2, tf-u6l V2–V4): the planner **discovers
the Firegrid toolset and narrates the exact correct §6 plan in prose, then
stops — `tools/call` count = 0**. The model never emits a `tool_use`. The
question this bead answers: does ANY agent/ACP lever force a `tool_call`?

## Lever analysis — ALL source-verified NEGATIVE

**(a) claude-agent-acp / `@anthropic-ai/claude-agent-sdk@0.3.143`** — NO
forced-tool option. Full `sdk.d.ts` grep: only `allowedTools`,
`disallowedTools`, `toolAliases`, `permissionMode`
(default/acceptEdits/bypassPermissions/plan/dontAsk/auto), modes, models,
effort. **No `tool_choice` / `forcedTool` / `mustUseTool` / required-tool
option**, and the Agent SDK wraps the model loop and does **not** forward a
raw Anthropic `tool_choice`. claude-agent-acp passes
`_meta.claudeCode.options` straight into these SDK options (verified
tf-p9s/tf-u6l) — so there is nothing to set.

**(a-codex) `@zed-industries/codex-acp@0.14.0`** — ships only
`package.json` + a 2 KB `bin/codex-acp.js` launcher that spawns an opaque
platform-native binary (`codex-acp-darwin-arm`, …). No JS-exposed
forced-tool/`tool_choice` knob; the native binary surfaces none through
the ACP wrapper. Empirically (tf-9q4) codex-acp constrained also yields
`tools/call`=0.

**(b) raw Anthropic/OpenAI Messages-API `tool_choice:"any"/"required"`**
— the API supports it, but **no ACP runtime in scope forwards/exposes
it**: claude-agent-sdk hides the model loop entirely; codex-acp's native
binary exposes nothing. Dead via every ACP path.

**(c) other ACP runtimes (claude-code-acp / claude-acp variants)** — same
Claude Agent SDK family → same absence of `tool_choice`; claude-code-acp
additionally requires Claude OAuth, not an API key (tf-ahk). No known ACP
runtime exposes forced tool-choice.

**ACP protocol itself (`@agentclientprotocol/sdk`)** — `PromptRequest`
has only `prompt`, `sessionId`, `messageId?`, `_meta?` — **no
tool-forcing field**. `SetSessionConfigOptionRequest` is a generic
boolean/value-id setter keyed by `configId`; claude-agent-acp's advertised
`configOptions` are built from **modes / models / effort only**
(`buildConfigOptions(...)`), never tool-choice. The ACP spec defines **no
standardized forced-tool primitive**.

**(d) thin ACP shim injecting a forced first tool-call** — REJECTED as
papering. Hardcoding a `tool_call` is not agent-driven §6 choreography
(the planner still does not choose to invoke tools); the substrate
executing a scripted call is already proven by #397 / #417 and adds no
new evidence. A *genuine* forced-invocation shim would have to
re-implement the model loop against the raw Anthropic/OpenAI Messages API
with `tool_choice:"any"` — i.e. **a non-ACP custom agent runtime**, which
bypasses the entire ACP layer the dark-factory uses. That is an
architecture / PO decision, not a Firegrid substrate or ACP-config fix,
and is explicitly out of this lane's scope.

No 540s live-run was spent: the constrained behavior is already
decision-grade (tf-9q4 Run2, tf-u6l V2–V4), and this lever analysis is
source-verified from SDK/launcher/protocol code — a re-run cannot
manufacture a forced-tool capability the source proves absent. (Standing
discipline: source-verified > futile empirical re-confirmation.)

## Terminal conclusion (demo keystone)

- **Firegrid substrate: COMPLETE and proven.** §6 durability (#397),
  clean-unwind (#417), A1 ToolSearch-defer removal (#411), execute
  provider-edge (#388), MCP surface source-verified correct (#405).
- **Live agent-driven §6 is blocked solely on agent-side forced
  tool-invocation.** Every constrained ACP planner discovers the toolset
  and narrates the correct §6 plan but never emits `tools/call`.
- **No available ACP runtime, nor the ACP protocol, exposes forced
  tool-choice / a must-call mode** (source-verified: claude-agent-sdk
  0.3.143, codex-acp 0.14.0 launcher, @agentclientprotocol/sdk schema).
- The only genuine unblock is a **non-ACP custom agent** using the raw
  Anthropic/OpenAI Messages API with `tool_choice` forcing (the model
  still chooses which tool/args; it is merely forced to emit one) — an
  architecture/PO decision outside the ACP-based dark-factory substrate.
  Hardcoded shims are papering and are not delivered.

## Recommendation (Gurdas/architect decision; not autonomous)

1. Accept the demo story: **substrate complete & proven; the residual is
   a precisely-pinned, source-verified agent-side limitation — no ACP
   runtime/protocol exposes forced tool-choice.**
2. If a live agent-driven §6 is required: a scoped non-ACP planner
   (raw Messages API + Firegrid MCP tools as API tools + `tool_choice`)
   — new architecture, PO-gated, not a substrate fix.
3. Upstream feature requests (Gurdas's call, external publish): expose
   `tool_choice`/forced-tool in `@anthropic-ai/claude-agent-sdk` and/or
   a forced-tool ACP session option in `@agentclientprotocol/*`. Repro
   evidence already in #415 (tf-u6l).

Coordinator/architect holds the gate; no self-merge. No Firegrid code
changed (none is correct — the gap is agent-side and the only "fix"
inside ACP would be papering).
