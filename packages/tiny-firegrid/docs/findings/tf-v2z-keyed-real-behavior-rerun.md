# FINDING — tf-v2z: keyed real-behavior re-run of key-dependent sims

The persisted `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (now in `~/.zshenv`,
inherited by subprocesses) lets these sims exercise REAL agent behavior
instead of only structure / degrade-path. Re-ran at origin/main HEAD with
`TINY_FIREGRID_TIMEOUT="300 seconds"`. Honest verdicts below; nothing
papered.

## 1. execute-provider-side-effect-pipeline — REAL-BEHAVIOR PASS

Run `2026-05-19T13-20-46-216Z__execute-provider-side-effect-pipeline`
(status completed). Deterministic/agent-free substrate probe (no key).

```
sawExecuteToolUse: true
sawProviderStdout: true
resultTextExcerpt: "FIREGRID_EXECUTE_OBSERVED:FIREGRID_EXECUTE_SIDE_EFFECT_OK"
```

The `execute` agent-tool now genuinely runs a real SandboxProvider command
and its stdout is observed back through the public client. The #390
known-gap `dark-factory.execute.provider_side_effect`
(`agent-tool-host-live.ts` returned `unsupportedAgentTool` for `execute`)
is **RESOLVED on origin/main HEAD** (oca2 fix landed). Evidence supersedes
the static known-gap for `execute`.

## 2. permission-flow-pipeline — REAL FINDING (auth resolved; permission round-trip still not exercised)

Run `2026-05-19T13-17-50-345Z__permission-flow-pipeline`
(status **failed: SimulationRunTimeout 5m**, summary null). Real
`@zed-industries/claude-code-acp@0.16.2`, `ANTHROPIC_API_KEY` present.

Trace span tally:

```
acp.initialize x2, acp.new_session x2, acp.prompt x2
agent_output: Ready x1, TextChunk x6, ToolUse x4, Status x6, TurnComplete x1
session/request_permission: 0   (NONE)
simulate.run.timeout x1
```

Two distinct facts:

- **Progress vs the prior tf-ahk finding (auth boundary RESOLVED by the
  key):** the embedded prior localization (sim lines ~220–221) recorded
  claude-code-acp exiting with "ZERO model output, ZERO tool call, ZERO
  session/request_permission" because `ANTHROPIC_API_KEY` alone did not
  drive a prompt turn (it advertises only the `claude-login` OAuth
  authMethod). With the persisted key this keyed run shows the OPPOSITE:
  the agent drove a real model turn (6 TextChunk), made **4 real ToolUse
  calls**, and reached **TurnComplete + Ready**. The agent-internal
  model-invocation/auth boundary is no longer the blocker.

- **Remaining REAL finding (precise, not papered):** despite making 4
  ToolUse calls, the agent emitted **zero `session/request_permission`**.
  The permission-flow sim asserts a durable PermissionRequest →
  PermissionResponse(Allow) → resume round-trip; with no request ever
  emitted, the driver waits and the run times out at 5m. Root cause: in
  its default ACP permission posture claude-code-acp **auto-permits** the
  tool calls this prompt induces — it does not gate them behind
  `session/request_permission`. The Firegrid substrate path is sound
  (initialize/new_session/prompt/ToolUse/TurnComplete all observed); the
  unmet premise is "a real tool-enumerating agent will emit a permission
  request." It does not, for these tools, in default mode.

  To actually exercise the human-gate path the sim must either drive an
  operation claude-code-acp genuinely gates, or set an ACP session
  permission `mode` that forces prompting (the ACP `configOptions.mode`
  select exposes prompting vs `dontAsk`/`bypassPermissions`). This is a
  sim-premise/agent-config gap, not a Firegrid substrate defect, and is a
  sharper, key-verified successor to the key-less #380 RED and tf-ahk.

## 3. codex-acp-tool-call-pipeline — see run §below (sharpened)

Initial keyed run `2026-05-19T13-17-44-337Z__codex-acp-tool-call-pipeline`
(status completed): `sawReady:true`, `sawSleepToolUse:false`,
`resultTextExcerpt:"FIREGRID_TOOL_RESULT sleep slept=true"`. Trace shows a
REAL MCP round-trip DID occur: `McpServer.initialize`, `tools/list` ×17,
`tools/call` ×1, `register_toolkit` (8 tools incl `sleep`), an
`acp.session_update` with `agent_output.tag:"ToolUse"` and a
`tool_call_update` Status. So a ToolUse round-trip happened but the
harness's narrow `part.name === "sleep"` assertion did not match.

The sim was sharpened to record `observedToolNames` + `sawAnyToolUse`.
Sharpened re-run `2026-05-19T13-26-16-240Z__codex-acp-tool-call-pipeline`
(status completed):

```
sawReady: true
sawAnyToolUse: true
sawSleepToolUse: false
observedToolNames: ["sleep 0"]
resultTextExcerpt: "FIREGRID_TOOL_RESULT"
```

**Verdict — REAL tool-call round-trip PROVEN; precise codec name-surface
finding (NOT a clean PASS, NOT papered):**

The real codex-acp agent genuinely exercised the Firegrid MCP `sleep`
tool-call end to end (Ready → MCP initialize → tools/list ×17 → tools/call
×1 → observed ToolUse → terminal `FIREGRID_TOOL_RESULT`). The substrate /
tool-execution path WORKS with a real keyed agent.

However the surfaced `ToolUse.part.name` is **`"sleep 0"`** — the ACP
`tool_call` human-readable **title** (tool name + rendered `durationMs 0`
argument) — NOT the canonical Firegrid MCP tool name `"sleep"`. So an
exact-match assertion (`part.name === "sleep"`) cannot reliably identify
the tool, and `sawSleepToolUse` is correctly false even though `sleep`
ran.

Finding `codex-acp.tooluse_partname_is_acp_title`: the ACP
`tool_call` → AgentOutputEvent ToolUse mapping in
`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts` surfaces
the ACP tool_call title/label as `part.name` rather than the canonical
tool name. A consumer that asserts on the Firegrid tool name cannot match
it. This is a precise, real codec name-surface gap — strictly stronger
than the key-less degrade, and distinct from "the tool did not run."

Discipline: NOT papered by loosening the harness to a prefix/`includes`
match (that would mask the codec gap). The sim now honestly reports
`PARTIAL` + `observedToolNames` so the gap is falsifiable from run.json.
Routing: the codec tool-name surface fix is separate review-scoped runtime
work (substrate-boundary/scope — a toy must not edit the runtime ACP codec
unprompted); recorded for coordinator routing.
