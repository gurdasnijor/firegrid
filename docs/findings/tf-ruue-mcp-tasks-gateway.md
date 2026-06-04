# tf-ruue Finding: MCP Tasks Gateway Spike

## Verdict

**Positive, with protocol-shape caveats.** A task-augmented `tools/call` wrapper over `RpcServer.Protocol` can carry Firegrid's full session lifecycle over a durable-streams wire: session creation, prompt dispatch, streaming output represented as task status/result, and a completed permission round-trip through `input_required` followed by `tasks/update`.

This is not a claim that MCP Tasks delete Firegrid's execution router or make operations durable by themselves. The sim keeps the channel router and per-event workflow below MCP, and uses Tasks as the ingress-visible state machine.

## What was built

The simulation is `packages/firelab/src/simulations/mcp-tasks-gateway/`.

- The durable wire is three `effect-durable-streams` streams: requests, responses, and task events (`wire.ts:55-77`). The simulation client speaks that durable-streams HTTP wire directly with raw `fetch` and imports only `@firegrid/client-sdk/firegrid` plus `effect` (`driver.ts:1-6`, `driver.ts:92-199`).
- The task store is an append-only durable task-event log with status values `working`, `input_required`, `completed`, `failed`, and `cancelled` (`wire.ts:33-53`). In-process refs/fibers are only the live execution/awaiting-input handles (`protocol.ts:33-56`, `protocol.ts:369-388`).
- The integration point is the pluggable `RpcServer.Protocol`, whose contract is `run`, `send`, `disconnects`, and client lifecycle methods (`repos/effect/packages/rpc/src/RpcServer.ts:793-813`). This is the same seam `@effect/ai`'s MCP server uses before it delegates requests or sends client-RPC messages (`repos/effect/packages/ai/ai/src/McpServer.ts:378-421`).
- `@effect/ai` is still pinned to MCP protocol `"2025-06-18"` (`repos/effect/packages/ai/ai/src/McpServer.ts:308`), and its `tools/call` schema has only `name` and `arguments`, with no Task fields (`repos/effect/packages/ai/ai/src/McpSchema.ts:1219-1229`). That is why the spike wraps the protocol rather than forking handler schemas.
- The wrapper splices Tasks into `initialize`, advertises `execution.taskSupport` on `tools/list`, and terminates `tasks/get`, `tasks/result`, `tasks/update`, and `tasks/cancel` itself (`protocol.ts:317-361`, `protocol.ts:451-529`).
- On task-augmented `tools/call`, the receiver generates a fresh task id, immediately appends a `working` task event, returns a task handle, strips the task field, and forwards the original tool call inward (`protocol.ts:411-449`). This matches the 2025-11-25 Tasks rule that task ids are receiver-generated and that a task-augmented call returns task data before the operation result.
- For `session_prompt`, the wrapper follows the real `SessionAgentOutputChannel` stream, emits `working` for streamed status/text, emits `input_required` for a real permission request, and completes the task only after terminal prompt output (`protocol.ts:191-285`, `protocol.ts:551-570`).
- `tasks/update` maps the related task input to `HostPermissionRespondChannel.binding.append`, preserving the real permission response path below MCP (`protocol.ts:484-510`, `host.ts:281-299`).

## Host Composition

The host is a real `FiregridRuntime` with a real claude ACP spawn target (`host.ts:304-335`, `driver.ts:8-12`). The generated prompt channel is a spike-local `session.prompt` durable-event binding that calls `RuntimeContextSessionWorkflow.execute(..., { discard: true })`, not a fake codec or recorder (`host.ts:139-185`). The MCP toolkit is registered against the real `FiregridAgentToolkit`, with a gateway context resolved from the control-plane table (`host.ts:197-225`, `host.ts:255-269`). Prompt lifecycle observation is sourced from protocol launch views over the runtime output table on the host side (`host.ts:228-244`).

The firelab runner now provides the public `FiregridConfig` service to drivers so this simulation can read the already-public durable-streams base URL and namespace without adding a client-sdk spike export (`types.ts:28-38`, `runner/runtime.ts:232-249`).

## Trace Evidence

Run:

`packages/firelab/.simulate/runs/2026-06-03T10-25-46-724Z__mcp-tasks-gateway/trace.jsonl`

`pnpm --filter firelab simulate -- show 2026-06-03T10-25-46-724Z__mcp-tasks-gateway` reported 500 spans, 1 trace, and 0 errored spans.

Load-bearing trace rows:

- Real spawn occurred: `unified.session.spawn/...` and workflow activity execution are present (`trace.jsonl:118-119`, `trace.jsonl:193-194`), and a real local process byte pipe opened for `npx` (`trace.jsonl:101`).
- The driver observed the task lifecycle `working,...,input_required,working,...,completed`, with `saw_input_required=true`, `sent_task_update=true`, `result_had_marker=true`, and `permission_roundtrip_completed=true` (`trace.jsonl:491`).
- The permission request was emitted by the ACP pipeline with policy `forward` (`trace.jsonl:412`).
- The client sent `tasks/update` (`trace.jsonl:378`), which produced the ACP permission response (`trace.jsonl:409`).
- The existing workflow permission relay and durable deferred result completed (`trace.jsonl:424`, `trace.jsonl:429`, `trace.jsonl:374`).

## Protocol Caveats

The 2025-11-25 MCP Tasks page says Tasks are experimental, receiver-generated, requestor-polled durable state machines; it also says task notifications are optional and requestors should keep polling: <https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks>. SEP-2663 then moves Tasks out of the core spec into an extension, introduces `tasks/get`, `tasks/update`, and `tasks/cancel`, removes `tasks/list`, and removes the old blocking `tasks/result` shape: <https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663>.

The spike therefore treats the protocol syntax as provisional:

- It intentionally does not implement `tasks/list`.
- It keeps task behavior behind `wire.ts` and `protocol.ts`, so the on-wire shape can be reshaped to SEP-2663 without touching runtime execution.
- It implements `tasks/result` because the task asked for it and because the 2025-11-25 page still defines it, but the decision-grade part is not the exact `tasks/result` method. The decision-grade part is that Firegrid can expose a durable task state machine over MCP ingress and complete the permission round-trip via task input.

## Boundary Found

The generic two-phase wrapper is enough to turn a normal `tools/call` result into a task, including the rule that `isError:true` maps to a failed task while preserving the original `CallToolResult` (`protocol.ts:363-367`, `protocol.ts:571-582`).

The full `session_prompt` lifecycle is **not** generic. It needs operation-aware follow logic that attaches the task to the child session's output stream and maps `PermissionRequest` into `input_required` (`protocol.ts:191-285`). That is the real boundary: MCP Tasks can express the lifecycle cleanly, but Firegrid must supply per-operation lifecycle adapters for operations whose visible completion is not equal to the immediate tool-handler return.

Open items not proven by this sim:

- Host restart rehydration of active task fibers was not tested. Durable task events persist, but active `tasks/cancel` fiber handles and pending TTL timers are still live-process state.
- TTL expiry is represented in the task records but not driven by a durable timer in this spike.
- Notifications were not required. Because Firegrid owns the TypeScript client, polling the durable task event stream was sufficient; optional MCP notifications can be added as acceleration, not correctness.
- The separate `approval.*` routing bug is not addressed here.

## Conclusion

MCP Tasks are viable as the universal gateway state model for this lifecycle, provided the implementation is framed as a migratable protocol seam rather than a committed 2025-11-25 core-Tasks implementation. The strongest source-verified claim is: **task-augmented MCP ingress over durable streams can drive a real claude ACP session through prompt streaming and a permission round-trip without a separate client surface or runtime imports on the client side.**
