# tf-4cik.1 Agent Runtime Conformance Matrix

Spec source: `firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.*`.

| Row | SandboxProvider | Session mode | Codec / transport | Fault class | Expected source boundary | Expected codec boundary | Durable evidence | Trace artifact | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `acp-permission-tool-roundtrip` | `local-process` | `codec` | `ACP` | happy path | Byte-pipe stdout/stderr acquisition only | ACP session updates normalize to `AgentOutputEvent`; permission response is codec-delivered input | Ready, ToolUse observation, PermissionRequest, PermissionResponse, TurnComplete, Terminated | `firegrid.agent_runtime_fixture.replay_fixture` span | pass |
| `stdio-jsonl-client-result-roundtrip` | `local-process` | `codec` | `stdio-jsonl` | happy path | Process stdin/stdout/stderr byte streams | stdio-jsonl lines normalize output and encode ToolResult input | Ready, ToolUse dispatch candidate, ToolResult input, TextChunk, TurnComplete, Terminated | `firegrid.agent_runtime_fixture.replay_fixture` span | pass |
| `fake-mcp-provider-permission-gate` | `effect-ai` | `codec` | fake MCP/provider | permission-gate stall | Provider session acquisition is live-only; no credential literals in replay payload | Provider request becomes PermissionRequest and waits for PermissionResponse | PermissionRequest commits; missing PermissionResponse classified as stall | `firegrid.agent_runtime_fixture.replay_fixture` span | expected fault |
| `restart-disconnect-after-committed-output` | `local-process` | `raw` | raw byte stream | crash mid-action | Source reports early exit/disconnect only | Raw bytes stay raw output observations; no protocol correlation in source | Committed output survives replay; disconnect is terminal evidence | `firegrid.agent_runtime_fixture.replay_fixture` span | expected fault |
| `codec-double-advertisement` | `local-process` | `codec` | `stdio-jsonl` | codec double-advertisement | Source sees two frames and does not infer capability state | Codec classifies duplicate Ready/capability advertisement | First Ready retained; duplicate classified as recoverable protocol fault | `firegrid.agent_runtime_fixture.replay_fixture` span | expected fault |
| `live-canary-codex-acp` | `local-process` | `codec` | `ACP` | live-agent canary | Real child process byte-pipe acquisition only when env-gated | Real ACP agent should produce tool-use observations | Skipped unless `FIREGRID_AGENT_RUNTIME_LIVE_CANARY=1` and credentials are present | skipped row span | unsupported in CI |

Fuzz classes exercised by the deterministic rows:

- chunk splitting
- frame coalescing
- stdout/stderr interleaving
- malformed/incomplete JSON
- early process exit
- stdin close/EPIPE
- slow/hung response
- duplicate tool ids
- permission request without response
- response after disconnect
- provider env/secret leakage
- restart/replay around a committed output row
