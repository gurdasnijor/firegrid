# tf-taba Rec-1 stdio-jsonl codec live sim finding

## VERDICT: SHARP-EDGE-1

The native Codex CLI `codex exec --json` surface is not a Firegrid
`stdio-jsonl` agent protocol surface. When launched through Firegrid's
`stdio-jsonl` codec, Codex emits Codex-native JSONL event types
(`thread.started`, `turn.started`, `item.started`, `item.completed`,
`turn.completed`) that the codec records as recoverable Error events, so no
Firegrid `ToolUse` reaches `RuntimeToolUseExecutor`.

There is also a Codex-side permission gate equivalent: with noninteractive
`-a never`, Codex discovers the configured MCP probe server and starts an
`mcp_tool_call`, then cancels it before issuing MCP `tools/call`.

## Sim Added

- `packages/firelab/src/simulations/codec-stdio-jsonl-live/`
- Driver launches a real Codex CLI process via a local-process runtime:
  `node -e <bridge>` waits for Firegrid's first stdio-jsonl prompt frame, then
  execs `codex --sandbox read-only -a never -c mcp_servers.firegrid_stdio_probe.url=... exec --json`.
- Host starts a loopback MCP probe server that records `initialize`,
  `tools/list`, and `tools/call`, plus a normal `FiregridLocalHostLive`
  topology with `FiregridLocalProcessFromEnv`.

ACIDs exercised:

- `firegrid-runtime-agent-event-pipeline.VALIDATION.2`
- `firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.6`
- `firegrid-runtime-host-modularity.CODEC_RUNTIME.1`
- `firegrid-runtime-host-modularity.CODEC_RUNTIME.4`

## Trace Evidence

Run:

```bash
pnpm --filter firelab simulate:run codec-stdio-jsonl-live --timeout-ms 240000
```

Trace artifact:

```text
packages/firelab/.simulate/runs/2026-05-20T08-36-43-852Z__codec-stdio-jsonl-live/trace.jsonl
```

Observed raw wire:

- Firegrid sent its protocol frame to stdin:
  `{"type":"prompt", ... "prompt":{"role":"user", ...}}`
- Codex stdout used a different JSONL schema:
  `thread.started`, `turn.started`, `item.started`, `item.completed`,
  `turn.completed`.
- Codex attempted the MCP probe:
  `item.type=mcp_tool_call`, `server=firegrid_stdio_probe`,
  `tool=stdio_probe`, `status=in_progress`.
- Codex then cancelled before `tools/call`:
  `status=failed`, `error.message="user cancelled MCP tool call"`.

Driver span summary from the final run:

```text
firegrid.codec_stdio_jsonl_live.codex_mcp_methods=initialize,notifications/initialized,tools/list
firegrid.codec_stdio_jsonl_live.codex_mcp_tool_call_count=0
firegrid.codec_stdio_jsonl_live.codex_jsonl_types=item.completed,item.started,thread.started,turn.completed,turn.started
firegrid.codec_stdio_jsonl_live.codex_mcp_tool_attempts=firegrid_stdio_probe.stdio_probe:failed,firegrid_stdio_probe.stdio_probe:in_progress
firegrid.codec_stdio_jsonl_live.codex_mcp_tool_failures=user cancelled MCP tool call
firegrid.codec_stdio_jsonl_live.saw_codec_decode_error=true
firegrid.codec_stdio_jsonl_live.saw_runtime_tool_use=false
firegrid.codec_stdio_jsonl_live.saw_runtime_tool_result_roundtrip=false
```

## Source Cross-Check

- Upstream `zed-industries/codex-acp` is the already-covered ACP adapter, not
  a native Firegrid `stdio-jsonl` surface: its README title is "ACP adapter
  for Codex", says it "implements an ACP adapter around the Codex CLI", and
  lists "Client MCP servers" support
  (`https://github.com/zed-industries/codex-acp`, README lines 1-21 on
  `main` at HEAD `156cb0da12f6c7b1c697f90b5f22d5e14be31165`).
- `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:172`
  only accepts `text`, `assistant`, `tool_use`, `turn_complete`, `end_turn`,
  and `status` event types; other `type` values become recoverable Error
  events at line 179.
- `packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts:183`
  encodes Firegrid prompts as `{"type":"prompt", ...}` on stdin.
- `packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:161`
  selects `StdioJsonlSessionLive(bytes)` for `agentProtocol: "stdio-jsonl"`;
  the effective MCP server list is only recorded as a span attribute for this
  protocol at lines 163-168. The ACP branch forwards MCP servers into
  `AcpSessionLive` at lines 172-184.
- `packages/host-sdk/src/host/runtime-context-workflow-core.ts:406`
  runs `RuntimeToolUseExecutor` only after a normalized Firegrid `ToolUse`
  event exists. Because Codex JSONL never decodes to that event, the executor
  is not reached.
- `codex-cli 0.125.0` exposes `codex exec --json` as an output event stream.
  Its help says stdin is appended to the prompt if piped, so the sim bridge
  closes Codex stdin and passes the prompt as an argv argument while preserving
  Codex stdout unchanged for the Firegrid codec to decode.

## Consequence

`stdio-jsonl` is honest for Firegrid-owned fixture agents that speak its
protocol, but it is not live-compatible with native Codex CLI JSONL. A Phase 2
multi-codec cutover should not treat `codex exec --json` as the native
`stdio-jsonl` backend unless a deliberate Codex-JSONL adapter is added and its
permission/MCP policy is specified separately.

Codec catalog implication: the codec should not remain silently ambiguous. If
ACP coverage is confirmed for all target agents, `stdio-jsonl` is a deletion
candidate and the cross-codec `AgentSession` indirection should be re-evaluated
with only one live implementation. If a future stdio-jsonl consumer is planned,
that consumer should be named in the codec catalog and validated before Phase 2
depends on it.

Permission implication: the Codex `mcp_tool_call` cancellation under
noninteractive `-a never` is the same structural class as the ACP/Claude
can-use-tool gate. Permission gates are a general interactive agent-CLI
pattern, not ACP-specific. Future codec integrations should expect a
cross-codec `call(approval(...))`-style authority instead of treating approval
as a Claude-only workaround.
