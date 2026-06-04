# tf-0awo.19 FINDING - ACP ToolUse -> ToolResult relay is live

## Verdict

**CONFIRMED-LIVE.** A real ACP `tool_call` observation can still drive
`JournalObserverLive` into `ToolDispatchWorkflow`, which relays a
`ToolResult` back through the ACP codec and hits:

```text
ACP ToolResult input is out-of-band for this codec slice
```

The trace-confirmed failure is the typed codec failure and session-body failure
path. The observer currently wraps the forked workflow execution in
`Effect.orDie`, so this is the live defect boundary named by §3.2.

## Evidence

### Current verification run

Command:

```bash
pnpm --filter @firegrid/firelab simulate:run unified-kernel-validation
```

Run:

```text
packages/firelab/.simulate/runs/2026-06-02T11-16-05-056Z__unified-kernel-validation/trace.jsonl
```

Trace sequence:

| Line | Span | Evidence |
|---:|---|---|
| 108 | `firegrid.agent_event_pipeline.source.local_process.stdout_bytes` | real ACP subprocess emitted `session/update` with `sessionUpdate:"tool_call"`, `toolCallId:"call_1"`, `rawInput:{path:"/project/README.md"}` |
| 109 | `firegrid.agent_event_pipeline.acp.session_update` | ACP codec decoded that update as `firegrid.agent_output.tag:"ToolUse"` |
| 117 | `firegrid.workflow_engine.execution.resume.body` | `unified.tool-dispatch` workflow resumed for the observed tool call |
| 124-129 | `unified.tool.execute/call_1` | tool-dispatch activity executed for `call_1` |
| 135, 166 | `unified.tool.relay/call_1` | dispatch workflow attempted the relay back to the originating session |
| 161 | `firegrid.agent_event_pipeline.acp.tool_result` | failed with `ACP ToolResult input is out-of-band for this codec slice` at `acp/index.ts:817` |
| 162 | `firegrid.unified.adapter.send` | propagated `codec send failed` for `firegrid.unified.adapter.send.event_tag:"ToolResult"` |
| 170-171 | `unified.session.send/...`, `firegrid.unified.session.body` | runtime-context session body recorded the same `codec send failed` |
| 201-202 | `stdout_bytes`, `acp.session_update` | a second real `tool_call` (`call_2`) was decoded as `ToolUse`, proving this is not a one-off malformed row |

The same run's driver span records:

```text
firegrid.ukv.codec=acp
firegrid.ukv.agent_source=agentclientprotocol/typescript-sdk/src/examples/agent.ts
firegrid.ukv.migrated_probe.8.evidence="snapshot ToolUse count=0; trace surfaced ACP ToolResult codec gap during real tool-result relay"
```

This run is not a fake codec or recorder path. It is the production ACP codec
through the firelab `unified-kernel-validation` host. Its subprocess is
the official ACP TypeScript SDK example agent path recorded in the trace.

### PR #446 / tf-v7t trace read

PR #446's checked-in finding records the native `.mcp.json` registration arc:

- Run `2026-05-20T04-55-49-098Z__dark-factory`.
- Real `claude-agent-acp@0.36.1` planner.
- `McpServer.tools/call` server-side dispatches: `7`.
- `tool_call` session updates: `9`.
- `tool_call_update` session updates: `25`.

That trace proves the missing precondition from the later zero-ToolUse
`codex-acp-tool-calls` run: ACP can emit real journaled `ToolUse` under the
native `.mcp.json` path. It did not contain the later out-of-band error string;
the current UKV run above supplies that span-level failure.

### Existing SDD/finding record

`docs/sdds/SDD_FIREGRID_UNIFIED_PRODUCTION_CODEC_ADAPTER.md` already records
the target architecture: ACP-style codecs own tool dispatch internally, so
`JournalObserverLive` must not relay ACP tool calls as subscriber-produced
`ToolResult` input.

`docs/findings/tf-ll90-ukv-acp-tool-result-gap.md` records the earlier run
`2026-06-01T20-59-14-844Z__unified-kernel-validation` with the same sequence:
`acp.tool_result` -> `ACP ToolResult input is out-of-band for this codec slice`
-> `codec send failed`.

## Source Path

Current source still matches the failing trace:

- `packages/runtime/src/sources/codecs/acp/index.ts` decodes ACP
  `tool_call` and `tool_call_update` with `providerExecuted: true`.
- `packages/runtime/src/unified/observers.ts` forks
  `ToolDispatchWorkflow.execute(...)` for every `ToolUse` observation, without
  checking `providerExecuted`.
- `packages/runtime/src/unified/subscribers/permission-and-tool.ts` always
  constructs a `ToolResult` and relays it as `kind:"tool-result"`.
- `packages/runtime/src/sources/codecs/acp/index.ts` rejects that event in
  `sendToolResult`.

## Fix A Form

Fix A should be an observer gate:

```ts
case "ToolUse":
  if (observation.event.part.providerExecuted === true) return Effect.void
  return Effect.fork(ToolDispatchWorkflow.execute(...))
```

That is sufficient; no new schema field is required.

The protocol round-trip guard now proves the deciding field survives:

```text
packages/protocol/test/session-facade/schema.test.ts
```

The test encodes a `ToolUse` with `providerExecuted:true` through
`encodeRuntimeAgentOutputEnvelope`, decodes it through
`decodeRuntimeAgentOutputEnvelope`, projects the row through
`runtimeAgentOutputObservationFromRow`, and asserts
`observation.event.part.providerExecuted === true`.

Verification:

```text
pnpm --filter @firegrid/protocol test -- session-facade/schema.test.ts
# 9 files, 82 tests passed
```

This keeps `ToolUse` queryable as an observation while preventing the observer
from treating provider-executed ACP tool calls as host-executed tool requests.

