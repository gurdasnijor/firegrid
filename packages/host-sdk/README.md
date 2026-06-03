# @firegrid/host-sdk

Host-plane composition for Firegrid: host layer composition, agent provider
installation, route-scoped MCP exposure, agent-tool bindings, runtime start
capability, and the live `RuntimeToolUseExecutor` layer.

This package projects `@firegrid/protocol` operations into host-side Effect
Layers and Effect AI `Tool`/`Toolkit` values, and composes whatever runtime
substrate `@firegrid/runtime` exposes.

Host SDK is the host-author projection of the same protocol contracts consumed
by `@firegrid/client-sdk`, command-line entrypoints, MCP clients, and future
REST, gRPC, or JSON-RPC bindings. It installs concrete capabilities and channel bindings;
it does not define a central orchestration graph. Application and agent-facing
surfaces should see sessions, tools, channels, and observations, while workflow
engines, stream URLs, provider handles, and Durable Streams plumbing stay below
the host boundary.

## Boundary

- May import: `@firegrid/protocol`, `@firegrid/runtime`, `@effect/ai`,
  `@effect/platform-node`, `@modelcontextprotocol/sdk`.
- Must not import: `@firegrid/client-sdk`.
- `@firegrid/runtime` must not import this package. Runtime owns the narrow
  `RuntimeToolUseExecutor` capability tag; this package provides the live
  layer (`firegrid-host-sdk.TOOL_EXECUTOR_SEAM`).

## Bindings vs execution

Per `firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6`, agent-tool **bindings**
(protocol schema → Effect AI `Tool`/`Toolkit` values, MCP failure schema) are
separated from **execution** (`toolUseToEffect` lowering, `AgentToolHost`
seam, `ScheduledInputWorkflow`, the toolkit handler workflow):

- `@firegrid/host-sdk/agent-tools/bindings` — pure binding values.
- `@firegrid/host-sdk/agent-tools/execution` — host execution + lowering.
- `@firegrid/host-sdk/agent-tools` — convenience barrel re-exporting both.
- `@firegrid/host-sdk/host` — host composition, config, commands, MCP server.
