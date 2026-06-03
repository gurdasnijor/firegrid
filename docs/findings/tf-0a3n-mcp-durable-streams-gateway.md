# tf-0a3n MCP-over-Durable-Streams Gateway Spike

## Summary

This spike built a tiny-firegrid simulation for an MCP client and MCP server speaking Effect RPC over Durable Streams, then drove real Firegrid MCP tools through a real `FiregridRuntime` host and a real `claude-acp` spawn target. The trace proves that MCP JSON-RPC request/response traffic can cross Durable Streams and reach production MCP tool execution. It does **not** prove the full universal-gateway thesis yet: current synchronous `tools/call` semantics do not cleanly carry streaming output or permission response, and the current Effect MCP schema is pre-Tasks (`2025-06-18`) while the cleaner semantic fit is MCP Tasks from the `2025-11-25` spec.

Trace artifact:

`packages/tiny-firegrid/.simulate/runs/2026-06-03T09-26-42-983Z__mcp-durable-streams-gateway/trace.jsonl`

Run outcome: `DriverCompleted`; no computed verdict object was emitted.

## What Was Built

The sim lives at `packages/tiny-firegrid/src/simulations/mcp-durable-streams-gateway/`.

- The custom transport implements the Effect RPC `RpcServer.Protocol` and `RpcClient.Protocol` shapes, whose load-bearing hooks are `run` and `send` (`repos/effect/packages/rpc/src/RpcServer.ts:793`, `repos/effect/packages/rpc/src/RpcClient.ts:820`).
- Effect AI's MCP HTTP layer is itself just `McpServer.layer` plus `RpcServer.layerProtocolHttp`, which validates the seam we swapped (`repos/effect/packages/ai/ai/src/McpServer.ts:610`). Firegrid's production MCP host already composes MCP and `RpcServer.layerProtocolHttp` separately (`packages/runtime/src/unified/mcp-host/mcp-host.ts:210`).
- The spike transport uses two Durable Streams, `client-to-server` and `server-to-client`, with server read/send at `packages/tiny-firegrid/src/simulations/mcp-durable-streams-gateway/transport.ts:81` and client read/send at `packages/client-sdk/src/mcp-durable-streams-spike.ts:68`.
- Important limitation: the final sim uses direct `DurableStream.append` (`packages/tiny-firegrid/src/simulations/mcp-durable-streams-gateway/transport.ts:97`, `packages/client-sdk/src/mcp-durable-streams-spike.ts:91`), not the producer-id API. This proves Durable-Streams-carried MCP JSON-RPC, but it does not yet prove the final producer-sequenced transport design.
- The host composes a real `FiregridRuntime` (`host.ts:152`), real production adapter layer (`host.ts:160`), real MCP toolkit (`host.ts:121`), real `ToolDispatchLive` (`host.ts:171`), and a real host-plane session-control router (`host.ts:174`).
- The tiny-firegrid driver is an airgapped wrapper over a client-sdk spike helper (`packages/tiny-firegrid/src/simulations/mcp-durable-streams-gateway/driver.ts:1`). The helper uses the public Firegrid client once to create the parent route context (`packages/client-sdk/src/mcp-durable-streams-spike.ts:256`) because current MCP host resolution is context-scoped. After that, MCP calls drive `initialize`, `tools/list`, `session_new`, `wait_for`, `session_prompt`, another `wait_for`, and `call` over the durable transport (`packages/client-sdk/src/mcp-durable-streams-spike.ts:270`, `packages/client-sdk/src/mcp-durable-streams-spike.ts:278`, `packages/client-sdk/src/mcp-durable-streams-spike.ts:286`, `packages/client-sdk/src/mcp-durable-streams-spike.ts:288`, `packages/client-sdk/src/mcp-durable-streams-spike.ts:303`, `packages/client-sdk/src/mcp-durable-streams-spike.ts:317`, `packages/client-sdk/src/mcp-durable-streams-spike.ts:323`, `packages/client-sdk/src/mcp-durable-streams-spike.ts:343`).

The client helper is deliberately named `mcp-durable-streams-spike`. It imports `effect-durable-streams` directly as the experimental custom transport (`packages/client-sdk/src/mcp-durable-streams-spike.ts:6`), so it should not be mistaken for a production browser-safe client contract. The zero-substrate production-client claim remains unproven.

Tiny-firegrid needed a narrow harness change so the driver can read the generated Durable Streams base URL from the existing `FiregridConfig` layer. That is exposed in the driver environment (`packages/tiny-firegrid/src/types.ts:38`) and the runner already constructs that config layer (`packages/tiny-firegrid/src/runner/runtime.ts:85`).

## Trace Evidence

Transport proof:

- The trace contains repeated `tiny_firegrid.mcp_durable.client.send` spans with `message_tag=Request`, followed by `tiny_firegrid.mcp_durable.server.receive` with `message_tag=Request`, then `tiny_firegrid.mcp_durable.server.send` with `message_tag=Exit`, and `tiny_firegrid.mcp_durable.client.receive` with `message_tag=Exit`.
- Those message pairs carried `McpServer.initialize` / `RpcClient.initialize`, `McpServer.tools/list` / `RpcClient.tools/list`, and multiple `McpServer.tools/call` / `RpcClient.tools/call` operations.

Production execution proof:

- The trace includes a real local process spawn span: `firegrid.agent_event_pipeline.source.local_process.open_byte_pipe` with executable `npx` and `arg_count=3`.
- The driver annotations record `spawn_target=npx -y @agentclientprotocol/claude-agent-acp@0.36.1`, `anthropic_api_key_present=true`, `tool_count=11`, and tool names `call,execute,send,session_cancel,session_close,session_new,session_prompt,sleep,wait_any,wait_for,wait_until`.
- `session_new` reached production routing: trace spans include `firegrid.channel.dispatch` for `host.sessions.create_or_load`, `session.prompt`, and `host.sessions.start`, followed by `unified.session.spawn/...`, `firegrid.agent_event_pipeline.acp.initialize`, and `unified.runtime-context-session.execute`.

Synchronous semantics boundary:

- The first `wait_for` returned a session output observation at `initial_output_sequence=0` with `initial_output_event_tag=Ready`.
- The permission probe did not produce a `PermissionRequest`; the second observed output tag was `Status`, and the driver recorded `permission_observed=false`.
- The generic MCP `call` tool attempt for `approval.operator` failed inside production routing with `UnknownChannelTarget: { "target": "approval.operator" }`. This matches source: `runCall` dispatches through `RuntimeChannelRouter` (`packages/runtime/src/unified/mcp-host/tool-dispatch.ts:191`), unknown routes fail in `makeRuntimeChannelRouter.route` (`packages/runtime/src/channels/router.ts:138`), while the permission-response route is registered on the **HostPlane** router (`packages/runtime/src/channels/host-plane-router.ts:61`).
- The schema text promises an approval fallback for `approval.*` targets (`packages/protocol/src/agent-tools/schema.ts:837`), but the implemented `runCall` path does not include that fallback. That is a concrete mismatch surfaced by the sim.

## MCP Tasks Semantic Read

MCP Tasks are the better semantic candidate for the universal gateway, but current local SDK support is not there yet.

Source-verified facts:

- The official MCP `2025-11-25` Tasks spec says Tasks are experimental durable state machines for polling and deferred result retrieval: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#tasks
- Servers/clients must declare task capabilities, and `tools/call` has tool-level `execution.taskSupport` negotiation: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#capabilities
- Task-augmented `tools/call` returns a task handle immediately; the actual tool result comes later through `tasks/result`: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#creating-tasks
- `notifications/tasks/status` is optional in the cross-client MCP contract, but Firegrid owns the TS client. That means the Firegrid TS client can be notification-first for live UX while still using task state/result as the durable reconnect/recovery source: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#task-notifications
- `input_required` is the permission/human-input fit: the receiver moves the task to `input_required`, includes `io.modelcontextprotocol/related-task` on needed input messages, and returns to `working` after input arrives: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks#input-required-status
- Current vendored/current `@effect/ai` MCP schema does not expose `tasks/get`, `tasks/result`, `notifications/tasks/status`, `CreateTaskResult`, or `execution.taskSupport` (source-verified by `rg "tasks/get|tasks/result|notifications/tasks/status|taskSupport|CreateTaskResult" repos/effect/packages/ai/ai/src packages/runtime/src packages/protocol/src`). The only `input_required` hit in product code is Firegrid's own session status literal (`packages/protocol/src/agent-tools/schema.ts:449`).

That changes the thesis shape:

- Do not frame polling as the preferred Firegrid client path. Because Firegrid owns the TS client, make it notification-first for live status/output, with task state/result as the durable recovery source when the client starts late, reconnects, or misses a notification.
- Model long-running Firegrid tool calls as MCP task-augmented `tools/call` once the schema/runtime stack supports `2025-11-25` Tasks.
- Back task state/result with Firegrid's existing durable workflow/output tables below the MCP ingress.
- Use `tasks/get` / `tasks/result` as the durable task state/result source, not as a reason to discard live notifications in the Firegrid TS client.
- Permission should become task `input_required` plus related-task input/elicitation, not a bespoke synchronous `approval.operator` runtime-channel call.

## Answer To The Spike Question

Can a client drive the full lifecycle over MCP-over-Durable-Streams, trace-proven?

Partially. The trace proves durable-streams MCP transport feasibility for request/response traffic and proves real production tool execution through MCP, including a real `claude-acp` subprocess spawn. It does not prove a full lifecycle with streaming output plus completed permission round-trip.

Can MCP express streaming output and permission round-trip cleanly?

Current synchronous MCP tools do not express it cleanly. The sim reached `session_new`, `wait_for`, and `session_prompt`, but observed only `Ready` then `Status`, not `PermissionRequest`, and the approval route failed as an unknown runtime channel. MCP Tasks likely simplify the semantics: output/status is task state/result polling with optional notifications, and permission is task `input_required` with related-task input.

Boundary named:

- Transport boundary: feasible over Durable Streams, but final producer-sequenced transport remains unproven because this spike used direct append.
- Current MCP implementation boundary: `@effect/ai` is on the older MCP schema and lacks `2025-11-25` Tasks.
- Firegrid MCP tool boundary: generic `call` dispatches only through `RuntimeChannelRouter`; permission response lives in `HostPlaneChannelRouter`, despite the protocol schema text saying `approval.*` has a fallback.

## Relation To `codex-acp-tool-calls`

This result is not a contradiction of `packages/tiny-firegrid/src/simulations/codex-acp-tool-calls`. That sim drives the session lifecycle from the client SDK (`sessions.createOrLoad`, `session.prompt`, `session.start`, `session.wait.forAgentOutput`) and asks the spawned Codex ACP agent to call exactly one MCP `sleep` tool. In other words, it proves the **agent-side MCP tool-call path** works while client/control-plane lifecycle and output waiting remain on the client SDK. This spike moved more of the client/control path onto MCP (`session_new`, MCP `wait_for`, MCP `session_prompt`, MCP `call`) and surfaced the divergence: the tool surface has a working agent tool path, but it does not yet have the same client/control semantics as the client SDK, especially around output streaming and permission response.

## Next Spike

1. Add or vendor MCP Tasks schema support (`tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`, `notifications/tasks/status`, `CreateTaskResult`, `execution.taskSupport`) in the MCP layer.
2. Re-run this sim with task-augmented `tools/call` for `session_new` / `session_prompt` and a Firegrid TS client loop that is notification-first for live output/status, with `tasks/get` / `tasks/result` used for durable recovery and final result retrieval.
3. Replace the direct append transport with a producer-id implementation once the message flow is settled, then prove producer-sequenced request and response streams in trace.
