# tf-ze8f MCP-shaped-hole foundation finding

## Verdict

Phase-1 foundation is productionized for `session_prompt`.

The production `FiregridMcpServerLayer` now has an opt-in durable-streams
`@effect/rpc` protocol path while preserving the existing HTTP listener path
(`packages/runtime/src/unified/mcp-host/mcp-host.ts:114`,
`:127`, `:238`, `:273`). The durable path wraps MCP task requests for
`session_prompt` and derives task state from existing `RuntimeOutputTable`
rows, not a separate task-event store (`packages/runtime/src/unified/mcp-host/task-projection.ts:179`,
`:367`, `:377`, `:614`).

## Production shape

- Durable MCP wire: `requests` and `responses` streams named
  `<namespace>.firegrid.mcp.<streamId>.<suffix>`, implemented as an
  `RpcServer.Protocol` over the durable-streams HTTP wire
  (`packages/runtime/src/unified/mcp-host/durable-streams-protocol.ts:12`,
  `:39`, `:97`, `:113`, `:168`).
- Task projection: task ids encode `operation`, `contextId`, `inputId`, output
  `cursor`, creation time, ttl, and poll interval
  (`packages/runtime/src/unified/mcp-host/task-projection.ts:21`, `:101`,
  `:450`).
- `tasks/get` and `tasks/result` read/replay `RuntimeOutputTable` and project
  status/result from session output (`task-projection.ts:367`, `:377`, `:614`).
- `tasks/update` maps to the existing `HostPermissionRespondChannel` and does
  not write task state (`task-projection.ts:414`, `:565`, `:642`).

## Trace proof

Trace:
`packages/firelab/.simulate/runs/2026-06-03T11-18-10-877Z__mcp-production-task-projection/trace.jsonl`

Load-bearing lines:

- Production MCP toolkit registered: trace line 40.
- Durable MCP client used `initialize`, `tools/list`, `tools/call`, repeated
  `tasks/get`, `tasks/update`, and `tasks/result`: trace lines 52, 54, 63,
  84/90/94/95/142/143/144/163/170/171/172/213/291/292/305/324, 226, 325.
- Production durable context resolver ran under `agent-tools`, proving the
  production MCP host path, not a sim-local handler: trace line 56.
- Real claude-acp spawn/session path ran: trace lines 80, 87, 93, 121.
- Real permission request arrived from ACP: trace line 179.
- MCP `tasks/update` supplied the response; Firegrid relayed it through the
  existing permission/session path: trace lines 226, 257, 260, 261.
- Terminal prompt completed and the driver recorded:
  `saw_input_required=true`, `sent_task_update=true`,
  `result_had_marker=true`, `permission_roundtrip_completed=true`: trace line
  326.

## Boundary

This is foundation only. It does not delete HTTP, client-sdk reads, parallel
catalogs, or any old surface. It proves the durable MCP transport and the
`session_prompt` lifecycle adapter can live in production without a net-new
task store. Broader cutover still needs per-operation lifecycle adapters where
operations have different terminal predicates or input-required events.
