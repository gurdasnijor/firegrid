# tf-788q MCP observation reads

## Summary

Phase 2b extends the production durable-streams MCP gateway so the client-sdk MCP client can read RuntimeContext observations without importing host substrate tables. The covered client reads are:

- `observations.listContexts` / `observations.watchContexts` over MCP `resources/read firegrid://runtime/contexts`.
- `observations.snapshot(contextId)` and session-handle `snapshot()` over MCP `resources/read firegrid://runtime/contexts/{contextId}/snapshot`.
- `observations.waitForAgentOutput(...)` / session `wait.forAgentOutput(...)` over MCP `resources/read firegrid://runtime/contexts/{contextId}/agent-output/wait`.
- `observations.waitForPermissionRequest(...)` / session `wait.forPermissionRequest(...)` over MCP `resources/read firegrid://runtime/contexts/{contextId}/permission-request/wait`.

`watchContexts` is MCP-served but not MCP-subscribed: the pinned `@effect/ai` server advertises resources with `subscribe: false` and `resources/subscribe` is not implemented, so this phase keeps watch as client-side polling over the contexts resource rather than inventing a custom subscription method.

## Source Shape

The production MCP protocol wrapper now advertises resources on initialize and intercepts `resources/list` / `resources/read` in the same durable protocol seam that already handles Tasks. `resources/read` maps resource URIs to control-plane/output projections, while `session_prompt` Tasks continue to use the existing task projection path: [task-projection.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/runtime/src/unified/mcp-host/task-projection.ts:507), [task-projection.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/runtime/src/unified/mcp-host/task-projection.ts:763), [task-projection.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/runtime/src/unified/mcp-host/task-projection.ts:782).

The observation runtime is a projection over existing `RuntimeControlPlaneTable` / `RuntimeOutputTable` rows: contexts and snapshots read table collections; waits read the existing output row stream and map rows with `runtimeAgentOutputObservationFromRow`: [task-projection.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/runtime/src/unified/mcp-host/task-projection.ts:878), [task-projection.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/runtime/src/unified/mcp-host/task-projection.ts:914), [task-projection.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/runtime/src/unified/mcp-host/task-projection.ts:921).

The production `FiregridMcpServerLayer` durable-streams branch wires those existing row sources into the projection runtime; the client path remains separate and airgapped: [mcp-host.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/runtime/src/unified/mcp-host/mcp-host.ts:269), [mcp.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/client-sdk/src/mcp.ts:64), [mcp.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/client-sdk/src/mcp.ts:459).

## Trace Evidence

Successful run:

`packages/tiny-firegrid/.simulate/runs/2026-06-03T12-28-48-390Z__mcp-client-sdk-observations/trace.jsonl`

Evidence:

- Real claude-acp spawn: trace line 103 has `unified.session.spawn/...`; the span includes the child execution id and is under the real runtime session path.
- MCP resource surface was used: trace line 140 has `firegrid.client.mcp.rpc.resources/list`; trace lines 141/142/144/145 and 283/433 have `firegrid.client.mcp.rpc.resources/read`.
- Permission round-trip remained MCP Tasks-backed: trace line 343 has `firegrid.client.mcp.rpc.tasks/update`, line 362 has `firegrid.agent_event_pipeline.acp.permission_response`, line 383 has `unified.permission-roundtrip.execute`, and line 432 has `firegrid.client.mcp.rpc.tasks/result`.
- Driver annotations at trace line 434 record `watch_observed_child=true`, `snapshot_agent_output_count=21`, `initial_output_matched=true`, `permission_wait_matched=true`, `sent_task_update=true`, `result_had_marker=true`, and `permission_roundtrip_completed=true`.

The simulation that produced this trace is [driver.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/tiny-firegrid/src/simulations/mcp-client-sdk-observations/driver.ts:119) and uses the production host layer via [index.ts](/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-788q-mcp-observation-reads/packages/tiny-firegrid/src/simulations/mcp-client-sdk-observations/index.ts:8).

## Boundary

This makes the remaining observation reads MCP-served enough for Phase 3 deletion planning, with one caveat: true server-push `watchContexts` is still not proven. This phase intentionally uses polling over MCP `resources/read` because the current Effect MCP server lists resources but has `resources/subscribe` as not implemented (`repos/effect/packages/ai/ai/src/McpServer.ts:1277` and `:1305`). That is not a new Firegrid substrate surface, but it is a semantics boundary for anyone expecting subscription-style watch delivery.
