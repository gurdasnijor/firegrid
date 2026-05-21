# tf-ukvr ACP OTel Live MCP Finding

## Verdict

GREEN. The production `firegrid acp` stdio edge can export a file-backed OTel
artifact that makes live runtime-context MCP discovery and tool execution
inspectable without writing diagnostics to ACP stdout.

This finding covers:

- `firegrid-zed-acp-stdio-external-agent.VALIDATION.6`
- `firegrid-zed-acp-stdio-external-agent.CLI_HELPER.4`
- `firegrid-observability.HOST_PROCESS_EXPORTERS.3`

## Command

The final smoke was run from the PR worktree root:

```bash
cp /tmp/tf-ukvr-acp-otel-smoke.mjs packages/host-sdk/.tf-ukvr-acp-otel-smoke.mjs && node packages/host-sdk/.tf-ukvr-acp-otel-smoke.mjs; rc=$?; rm -f packages/host-sdk/.tf-ukvr-acp-otel-smoke.mjs; exit $rc
```

The smoke driver launched the production CLI path with:

```bash
pnpm exec tsx packages/cli/src/bin/run.ts acp \
  --namespace acp-smoke-1779389252810 \
  --otel-file /Users/gnijor/gurdasnijor/firegrid-worktrees/tf-ukvr-acp-otel-export/.firegrid-smoke/acp-smoke-1779389252810.jsonl \
  --agent tf-ukvr-backing-acp-smoke \
  --agent-protocol acp \
  --cwd /Users/gnijor/gurdasnijor/firegrid-worktrees/tf-ukvr-acp-otel-export \
  -- /opt/homebrew/Cellar/node/25.2.1/bin/node --input-type=module -e '<backing ACP agent source>'
```

The backing ACP agent accepted Firegrid's ACP `newSession` request, read the
injected runtime-context MCP server, issued JSON-RPC `initialize`,
`tools/list`, and `tools/call` against that MCP URL, and returned the ACP text
update `MCP_OBS listCount=11 callOk=true`.

## Artifact

Local artifact:

```text
/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-ukvr-acp-otel-export/.firegrid-smoke/acp-smoke-1779389252810.jsonl
```

The artifact is intentionally under ignored `.firegrid-smoke/`; this finding
records the durable result while keeping the large machine-local trace out of
git.

Driver summary:

```json
{
  "artifact": "/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-ukvr-acp-otel-export/.firegrid-smoke/acp-smoke-1779389252810.jsonl",
  "initializedProtocolVersion": 1,
  "stopReason": "end_turn",
  "userMessageId": "firegrid-acp-smoke-turn-1",
  "updates": [
    "MCP_OBS listCount=11 callOk=true"
  ],
  "spanLineCount": 1024,
  "counts": {
    "firegrid.acp_stdio_edge.initialize": 1,
    "firegrid.acp_stdio_edge.new_session": 1,
    "firegrid.acp_stdio_edge.prompt": 1,
    "firegrid.mcp.register_toolkit": 1,
    "McpServer.initialize": 1,
    "McpServer.tools/list": 1,
    "McpServer.tools/call": 1
  },
  "stderrTail": []
}
```

## Span Evidence

Required live-debug spans in the JSONL artifact:

| Span | Count | Evidence |
| --- | ---: | --- |
| `firegrid.acp_stdio_edge.initialize` | 1 | ACP client initialized the production stdio edge. |
| `firegrid.acp_stdio_edge.new_session` | 1 | ACP session creation reached Firegrid host-plane session routing. |
| `firegrid.acp_stdio_edge.prompt` | 1 | ACP prompt dispatch reached Firegrid runtime input routing. |
| `firegrid.mcp.register_toolkit` | 1 | Runtime-context MCP toolkit was registered for the live session. |
| `McpServer.initialize` | 1 | Backing ACP agent initialized the injected MCP server. |
| `McpServer.tools/list` | 1 | Backing ACP agent discovered the Firegrid MCP tool catalog. |
| `McpServer.tools/call` | 1 | Backing ACP agent called the Firegrid `sleep` tool. |

The `firegrid.mcp.register_toolkit` span carried:

```json
{
  "firegrid.mcp.tool_count": 11,
  "firegrid.mcp.tool_names": "call,execute,schedule_me,send,session_cancel,session_close,session_new,session_prompt,sleep,wait_for,wait_for_any",
  "firegrid.mcp.tool_profile": "full"
}
```

## Conclusion

The opt-in `--otel-file` exporter produced the live evidence this task needed:
the ACP edge spans, the runtime-context MCP registration span, MCP
`tools/list`, MCP `tools/call`, and the backing ACP agent's explicit
`MCP_OBS listCount=11 callOk=true` observation. This is the path needed to
debug opaque Zed tool-catalog failures from a production `firegrid acp` run.
