# UKV Real ACP Path Rejects ToolResult

## Finding

The unified-kernel-validation sim now drives the production ACP path through
the public client surface and a real subprocess, but the production ACP codec
rejects `ToolResult` inputs emitted by the unified tool-dispatch path.

Evidence run:

- `packages/tiny-firegrid/.simulate/runs/2026-06-01T20-59-14-844Z__unified-kernel-validation/trace.jsonl`

Production path evidence:

- Line 32: `firegrid.unified.signal.send` for the public `session.prompt`
  idempotency key.
- Line 45: `firegrid.agent_event_pipeline.source.local_process.open_byte_pipe`
  opens a real local-process byte pipe.
- Line 53: `firegrid.unified.adapter.start_or_attach` reports
  `firegrid.unified.adapter.kind=production-codec`.
- Line 70: `firegrid.unified.adapter.send` decodes the prompt as an ACP
  `Prompt`.
- Line 401: `firegrid.agent_event_pipeline.acp.prompt` sends the prompt to the
  vendored official ACP TypeScript SDK example agent.

Gap evidence:

- Line 188: `firegrid.agent_event_pipeline.acp.tool_result` fails with
  `ACP ToolResult input is out-of-band for this codec slice`.
- Line 189: `firegrid.unified.adapter.send` propagates `codec send failed` for
  `firegrid.unified.adapter.send.event_tag=ToolResult`.
- Line 197: `unified.session.send/...` records the same `codec send failed`
  failure while resuming the unified runtime-context session workflow.

## Classification

Category 2 implementation gap. The public client reached durable signaling,
the unified workflow, `ProductionCodecAdapterLive`, `LocalProcessSandboxProvider`,
and a real ACP subprocess. The failure is in the production ACP codec path once
the off-the-shelf agent emits tool calls and Firegrid attempts to send a tool
result back.

## Impact

Single-agent ACP sessions that emit tool calls cannot complete the normal
tool-result round trip on the unified kernel. This is core single-agent
behavior, not a simulation-only issue.
