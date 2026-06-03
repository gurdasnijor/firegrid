# tf-2cfw — MCP Task State as Runtime-Output Projection

## Verdict

**SHRINK for `session_prompt` task state.** The sim proves that the `session_prompt`
MCP Task lifecycle can be represented without a spike-local durable task-event
log: the task id is self-describing, `tasks/get` derives status from existing
RuntimeContext output, `tasks/result` waits for terminal runtime output, and
`tasks/update` writes through the existing host permission response channel.

**Caveat:** this run did **not** literally kill and restart the host process
mid-task. It proves the stateless rehydration shape at the protocol seam
self-describing task id + durable runtime-output cursor, but the full
process-bounce proof remains a follow-up if the PO requires executable restart
evidence.

## Evidence

Simulation:
`packages/tiny-firegrid/src/simulations/mcp-task-projection-gateway/`

Trace:
`packages/tiny-firegrid/.simulate/runs/2026-06-03T10-52-46-665Z__mcp-task-projection-gateway/trace.jsonl`

The sim wire defines only request and response streams; there is no
`task-events` stream or append-only task log in the new sim
(`wire.ts:50-56`). A source grep for `task-events`, `appendTaskEvent`, and
`taskEvents` under the sim directory returned no matches.

The task id carries the durable rehydration key: operation, session id, input
id, output cursor, created time, TTL, and prompt marker
(`protocol.ts:27-35`, `protocol.ts:165-200`). On task creation, the adapter
captures the current runtime-output max sequence as `afterSequence`, builds the
self-describing task id, returns a working task, removes `params.task`, and
forwards the unaugmented `session_prompt` tool call to the inner MCP server
(`protocol.ts:449-497`).

`tasks/get` is a projection read: decode the task id, snapshot the existing
runtime output, filter by `sequence > afterSequence`, and compute
working/input_required/completed/failed from observed runtime output tags
(`protocol.ts:221-283`, `protocol.ts:401-415`, `protocol.ts:501-506`).

`tasks/result` is also projection-backed: it first checks the durable output
snapshot, otherwise waits on the existing session output stream until terminal
output, then re-snapshots runtime output to build the final CallToolResult
(`protocol.ts:344-370`, `protocol.ts:509-524`). It is not a new Deferred over
a new store.

`tasks/update` maps the latest projected `PermissionRequest` to the existing
`HostPermissionRespondChannel.binding.append` path (`protocol.ts:528-538`);
the host composes that append directly from `HostPermissionRespondChannel`
(`host.ts:306-312`).

The host projection source is existing runtime output: snapshots read
`RuntimeOutputTable.events.collection.toArray` through
`runtimeEventsForContextView` plus `runtimeAgentOutputObservationFromRow`, and
live waits use the existing `SessionAgentOutputChannel` stream
(`host.ts:290-305`). The host still composes real `FiregridRuntime`,
`ToolDispatchLive`, and `HostPlaneSessionControlRouterLive` (`host.ts:326-355`).

The executable prompt channel is generated from one `session.prompt` record and
invokes the production `RuntimeContextSessionWorkflow.execute` per-event path
(`host.ts:57-103`, `host.ts:139-185`).

## Trace Results

The trace shows a real local `claude-acp` spawn:
`trace.jsonl:97` (`firegrid.agent_event_pipeline.source.local_process.open_byte_pipe`)
and `trace.jsonl:197` (`unified.session.spawn/session:tiny-firegrid:mcp-task-projection-session`).

The MCP driver called `session_prompt`, repeatedly polled `tasks/get`, observed
`input_required`, sent `tasks/update`, and later called `tasks/result`
(`driver.ts:274-313`, `driver.ts:375-384`; trace `tasks/update` at
`trace.jsonl:347`, `tasks/result` at `trace.jsonl:443`).

The permission round-trip completed through the existing runtime path:
`trace.jsonl:309` / `trace.jsonl:325` show the permission request workflow,
`trace.jsonl:366` shows ACP permission response, `trace.jsonl:373` shows the
permission response session send, `trace.jsonl:382` shows permission relay,
and `trace.jsonl:386` shows `unified.permission-roundtrip.execute`.

The final driver span records:

- `task_statuses`: many `working`, then `input_required`, then `completed`
- `saw_input_required: true`
- `sent_task_update: true`
- `result_had_marker: true`
- `permission_roundtrip_completed: true`
- `projected_from_runtime_output: true`
- `spawn_target: npx -y @agentclientprotocol/claude-agent-acp@0.36.1`

See `trace.jsonl:444`.

The protocol creation span records `firegrid.mcp_task_projection.store: none`
and a task id whose payload includes `afterSequence`, `createdAtMs`, and
`ttlMs`; see `trace.jsonl:452`.

## TTL

Read-side TTL is expressible without a new durable timer store because the
receiver-generated task id carries `createdAtMs` and `ttlMs`, and projection
marks non-terminal tasks failed after expiry (`protocol.ts:27-35`,
`protocol.ts:251-252`, `protocol.ts:287-299`).

Automatic expiry side effects, such as interrupting a still-running underlying
operation at TTL, would need to be modeled as an existing durable-clock action
or workflow below the adapter. The sim does not add or prove such a timer.

## Lifecycle Adapter Shape

The reusable pattern is small:

1. Receiver-generated self-describing task id.
2. Operation-specific output cursor captured before dispatch.
3. Projection from existing durable output rows to MCP task state.
4. `tasks/update` mapped to the existing operation input channel.
5. `tasks/result` waits for the operation's existing terminal output.

The only per-operation pieces are the terminal predicate and input-required
mapper. For `session_prompt`, those are runtime-output `TurnComplete` /
`Terminated` / `Error` and `PermissionRequest` respectively
(`protocol.ts:229-283`). This looks like a reusable lifecycle adapter pattern,
not bespoke task-store sprawl.

## Bottom Line

For `session_prompt`, MCP task state can be a pure projection over Firegrid's
existing durable session/output substrate. The cutover does **not** need the
tf-ruue spike-local task-event log for this operation. The remaining open proof
is a literal host process bounce; the current sim demonstrates the no-store
rehydration shape but does not execute a full kill/restart.
