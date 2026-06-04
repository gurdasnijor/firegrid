# tf-ll90.4 — cancel/close real-path finding

Date: 2026-06-01
Run: `2026-06-01T21-09-23-935Z__control-plane-cancel-close`
Trace: `packages/firelab/.simulate/runs/2026-06-01T21-09-23-935Z__control-plane-cancel-close/trace.jsonl`
Bead: `tf-ll90.4`

This run includes the runner fix from
`origin/codex/tf-ll90.15-sim-enforcement-gate`; that fix officially lands via
PR #783. The cancel/close sim code stays in this bead.

## Probe

The sim folder is exactly `index.ts`, `driver.ts`, and `host.ts`.
`driver.ts` imports only `@firegrid/client-sdk` and `effect`.

`host.ts` composes the real unified production factory with codec sugar:

```text
FiregridHost({ durableStreamsBaseUrl, namespace, codec: "acp", envPolicy })
```

The `envPolicy` authorizes only
`FIREGRID_FAKE_ACP_FIXTURE=env:FIREGRID_FAKE_ACP_FIXTURE` for the existing
driver launch config. With the PR #783 leaf-agent update, the spawned process at
`packages/firelab/src/bin/fake-acp-agent-process.ts` runs the official ACP
SDK example agent over the real local-process sandbox.

The driver uses the public client seam:

- `firegrid.launch` with a local-process ACP runtime
- `firegrid.sessions.attach`
- `session.start`
- `session.prompt`
- `firegrid.channels.call("session.cancel", { sessionId, reason })`
- `session.prompt` after the cancel attempt
- `firegrid.channels.call("session.close", { sessionId, reason })`
- `session.snapshot`

## Real Path Evidence

`simulate:show` reported:

```text
spans: 236  traces: 1  errored: 7  sides: sdk=133 driver=92 subprocess=10
```

The start/prompt path now reaches the real host/session path:

```text
trace line 30: unified.runtime-context-session.resume
trace line 31: firegrid.unified.signal.send
trace line 41: firegrid.agent_event_pipeline.source.local_process.byte_stream
trace line 42: firegrid.agent_event_pipeline.source.local_process.open_byte_pipe
trace line 45: firegrid.agent_event_pipeline.acp.initialize
trace line 49: firegrid.unified.adapter.start_or_attach
trace line 76: firegrid.agent_event_pipeline.acp.session_update
trace line 132: firegrid.agent_event_pipeline.acp.session_update
trace line 205: firegrid.agent_event_pipeline.acp.session_update
trace line 231: firegrid.agent_event_pipeline.source.local_process.exit
trace line 232: firegrid.agent_event_pipeline.acp.exit
```

The subprocess spans carry the real local-process command evidence:

```text
trace line 41: process.provider=local-process command.executable=/opt/homebrew/Cellar/node/25.2.1/bin/node
trace line 42: process.provider=local-process command.executable=/opt/homebrew/Cellar/node/25.2.1/bin/node
```

The public prompt after the cancel attempt also traverses signaling:

```text
trace line 217: firegrid.unified.signal.send
trace line 218: firegrid.client.channel.session_prompt.append target=session.prompt
trace line 219: firegrid.client.session.prompt
```

The official ACP example agent emits a tool call. The current codec slice
records an unrelated tool-result limitation before cancel/close:

```text
trace line 184: firegrid.agent_event_pipeline.acp.tool_result
status: ACP ToolResult input is out-of-band for this codec slice
```

That error is not cancel/close ingress evidence.

## Cancel/Close Evidence

No cancel request reaches the real session/kernel path. The public cancel call
still fails at the SDK channel surface:

```text
trace line 203:
firegrid.cancel_close.driver.session_cancel
target=session.cancel
status: { "target": "session.cancel", "verb": "call", "cause": Error: unknown channel: session.cancel }
```

No close request reaches the real session/kernel path. The public close call
fails the same way:

```text
trace line 220:
firegrid.cancel_close.driver.session_close
target=session.close
status: { "target": "session.close", "verb": "call", "cause": Error: unknown channel: session.close }
```

Documented absence in the same trace:

```text
terminal: 0
deregister: 0
session.cancel: 1
session.close: 1
```

The only `session.cancel` match is trace line 203, the SDK unknown-channel
failure. The only `session.close` match is trace line 220, the SDK
unknown-channel failure.

The final snapshot reads no runtime run rows for the public context:

```text
trace line 222: firegrid.runtime.runs query.row_count=0
trace line 224: firegrid.runtimeOutput.events query.row_count=0
trace line 225: firegrid.runtimeOutput.logs query.row_count=0
```

## Finding

With the PR #783 runner fix applied, the sim now proves the normal public
start/prompt path reaches the real composed host, production ACP codec, real
local-process sandbox, and ACP subprocess.

It does not prove that a real cancel input reaches the kernel and is ignored.
The real finding is earlier: the public client exposes no `session.cancel` or
`session.close` channel target in this composition. Both calls fail as
`FiregridChannelError` / `unknown channel` before reaching
`UnifiedSignalingChannelBindingsLive`, `RuntimeContextSessionWorkflow`,
`ProductionCodecAdapterLive`, or the ACP subprocess.

Therefore this run cannot characterize terminal/deregister behavior after a
real cancel input, because no real cancel input is admitted. It does document
that the real host/session path emits no `terminal` or `deregister` spans in
response to these public cancel/close attempts, and that the absence is caused
by missing public ingress rather than by a downstream kernel consumer.
