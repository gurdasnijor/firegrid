# tf-vgpv client-sdk MCP client finding

## Verdict

The client-sdk now has a production MCP client over the durable-streams wire.
It drives `session_new`, `session_prompt`, task state streaming, `tasks/update`
permission response, and `tasks/result` through the production
`FiregridMcpServerLayer` path.

This is a no-deletion phase. The existing `Firegrid` direct client path still
captures `RuntimeControlPlaneTable` and `RuntimeOutputTable`
(`packages/client-sdk/src/firegrid.ts:930`, `:935`, `:936`) and still owns
snapshot/watch/wait reads (`firegrid.ts:984`, `:1034`, `:1042`). Phase 3 can
target those caller-facing read/watch/wait surfaces once the MCP client covers
the remaining observation methods.

## Client shape

- New package export: `@firegrid/client-sdk/mcp`
  (`packages/client-sdk/package.json:16`, `packages/client-sdk/src/index.ts:37`).
- Airgapped imports: the new module imports only `@effect/rpc` types,
  `@firegrid/protocol/agent-tools`, and `effect`
  (`packages/client-sdk/src/mcp.ts:1`, `:2`, `:8`). It does not import
  `@firegrid/runtime`, `effect-durable-operators`, or durable-table facades.
- Durable wire client: it writes JSON-RPC requests to
  `<namespace>.firegrid.mcp.<streamId>.requests` and reads responses from the
  matching `.responses` stream (`mcp.ts:105`, `:111`, `:178`, `:199`, `:209`).
- MCP operations: `initialize`, `tools/list`, `tools/call`,
  `tasks/get`, `tasks/result`, and `tasks/update` are exposed by the client
  (`mcp.ts:324`, `:329`, `:330`, `:337`, `:349`, `:355`, `:356`).
- Session facade: `sessions.createOrLoad` calls the production `session_new`
  tool, and the returned session handle exposes `promptTask`, `taskStates`,
  `taskResult`, and `respondToPermission` (`mcp.ts:361`, `:367`, `:379`).

## Trace proof

Trace:
`packages/tiny-firegrid/.simulate/runs/2026-06-03T12-04-08-283Z__mcp-client-sdk-gateway/trace.jsonl`

The sim imports the new client-sdk MCP export and uses it for the lifecycle
under proof (`packages/tiny-firegrid/src/simulations/mcp-client-sdk-gateway/driver.ts:6`,
`:132`, `:140`, `:143`, `:148`, `:155`, `:160`). It reuses the production
MCP host layer from Phase 1, not a sim-local MCP host
(`packages/tiny-firegrid/src/simulations/mcp-client-sdk-gateway/index.ts:2`,
`:11`).

Load-bearing trace lines:

- Real child spawn through production MCP `session_new`: trace lines 102-103.
- Real ACP permission request emitted by the spawned agent: trace line 363.
- Client-sdk MCP `tasks/update` accepted the permission response: trace line
  328.
- Existing Firegrid permission relay ran after the update: trace lines 375-376.
- Client-sdk MCP `tasks/result` returned the terminal result: trace line 429.
- Driver recorded `task_statuses=...input_required...completed`,
  `sent_task_update=true`, `result_had_marker=true`, and
  `permission_roundtrip_completed=true`: trace line 430.

## Deletion Implication

This makes a Phase 3 deletion path plausible for the caller-facing session
lifecycle surface currently implemented through direct client reads/waits in
`packages/client-sdk/src/firegrid.ts`. It does not by itself delete the old
surface, and it does not yet replace generic `snapshot`, `watchContexts`, or
all channel wait/read methods; those still need MCP-side observation coverage
before removal.
