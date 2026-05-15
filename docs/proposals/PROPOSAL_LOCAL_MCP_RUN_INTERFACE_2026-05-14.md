# Proposal: Unified Firegrid CLI Start Interface

## Problem

Firegrid now has route-scoped MCP host support and a local context bootstrap, but
the user-facing command boundary must not split into one-off binaries. A
developer should reach the two public local workflows through one Firegrid CLI
entrypoint:

- `pnpm firegrid -- run -- <agent>` creates a RuntimeContext, starts it, waits
  for process exit, and returns the child exit code.
- `pnpm firegrid -- start` creates a host-bound RuntimeContext, starts the local
  host plus MCP listener, prints the MCP URL, and stays alive for MCP Inspector
  or another client.

The `start` command is the long-running local host/MCP interface. It is not a
separate MCP-only product, sidecar, or callback server.

## Effect CLI Rule

Use `@effect/cli` as the command dispatch layer in `src/run.ts`. The root
command is `firegrid`; the public subcommands are `run` and `start`.

Effect owns the process and layer lifecycle:

- `repos/effect/packages/cli/README.md` shows `Command.make`,
  `Command.withSubcommands`, `Command.run`, and `NodeContext.layer`.
- `repos/effect/packages/platform-node/src/NodeRuntime.ts` exposes
  `NodeRuntime.runMain`.
- `repos/effect/packages/effect/src/Layer.ts` provides `Layer.scoped`,
  `Layer.scopedDiscard`, and `Layer.launch` for scoped resources and long-lived
  layers.

Firegrid should not add custom process management, a sidecar protocol, custom
JSON-RPC, manual `tools/list`, or manual `tools/call`.

## Command Contract

Primary commands:

```sh
pnpm firegrid -- run -- <agent command...>
pnpm firegrid -- start
pnpm firegrid -- start -- <agent command...>
```

Compatibility scripts may remain:

```sh
pnpm firegrid:run -- <agent command...>
pnpm firegrid:start
```

`run` preserves the synchronous run behavior: it requires an agent command,
creates a RuntimeContext row, optionally appends the initial prompt input,
calls `startRuntime`, waits for terminal evidence, and exits with the runtime
exit code. It is not a separate harness or test-only runner. It should use the
same host-bound RuntimeContext creation, prompt ingress, MCP attachment, and
runtime execution primitives that passive host mode uses when it consumes
control-plane launch events.

`start` is an MCP context bootstrap. It does not call `startRuntime`. It creates
a durable host-bound RuntimeContext because that row is the authority record
used by route-scoped MCP execution. With no agent argv, it seeds a minimal no-op
local-process intent through the same production primitives; with agent argv, it
uses the same run-config shape to customize the seeded intent.

Shared useful flags:

- `--cwd PATH`.
- `--prompt TEXT`.
- `--secret-env NAME[=ENV_NAME]`.

`start` additionally accepts:

- `--namespace NAME`, defaulting to `FIREGRID_RUNTIME_NAMESPACE` or a local
  development namespace.
- `--mcp-host HOST`, default `127.0.0.1`.
- `--mcp-port PORT`, default `0`.
- `--mcp-path PATH`, default `/mcp`.

When Firegrid launches an agent from this command family, the generated
route-scoped Firegrid MCP server is part of the agent launch contract by
default. The command should normalize the launch config to include a
`firegrid-runtime-context` MCP server pointing at the generated `mcpUrl`, then
let the selected adapter/backend lower that declaration into the agent's native
setup surface. ACP agents receive it through ACP session setup. CLI agents may
receive it through their native MCP configuration command, sandbox-local config,
or environment/config files owned by the selected backend. The CLI should not
require users to pass Firegrid's own MCP server explicitly.

`src/run.ts` should remain a thin command-dispatch boundary. CLI options and
positional argv should be converted into the launch input owned by
`packages/protocol/src/launch/schema.ts`, then decoded and normalized through
Effect Schema before any RuntimeContext row is created. This keeps the
human-facing CLI, durable launch ingress, and test smoke path on one contract.
The implementation should follow the established Effect patterns in
`Schema.decodeUnknown` / transform-style decoding, and use `@effect/cli`
only to collect command arguments, not as a second source of launch truth.
When choosing the final command shape, cross-check the vendored Effect
interfaces in `repos/effect/packages/effect/src/Schema.ts`,
`repos/effect/packages/cli/src/Command.ts`, `repos/effect/packages/cli/README.md`,
and `repos/effect/packages/platform/src/Command.ts`; product code must still
import from package dependencies, not from `repos/`.

If `DURABLE_STREAMS_BASE_URL` is set, `start` uses it. If it is absent, `start`
acquires an embedded loopback `DurableStreamTestServer` as a scoped local
development resource. The embedded server is not a product service and is not
used by `firegrid:host`.

After the context and MCP listener are available, `start` prints exactly one
ready record to stdout:

```json
{
  "type": "firegrid.start.ready",
  "version": 1,
  "contextId": "ctx_...",
  "mcpUrl": "http://127.0.0.1:49152/mcp/runtime-context/ctx_...",
  "namespace": "firegrid-local",
  "durableStreamsBaseUrl": "http://127.0.0.1:49151",
  "embeddedDurableStreams": true
}
```

Human-readable diagnostics can go to stderr. Tooling should consume the JSON
ready record from stdout.

## Required Reuse

The implementation should reuse:

- `FiregridLocalHostLive` for host session and host-owned stream authority.
- `insertLocalRuntimeContext` for host-bound context creation.
- `FiregridMcpServerLayer` for MCP toolkit mounting.
- `runtimeContextMcpPath` plus `encodeURIComponent(contextId)` for URL
  construction.
- Existing `firegrid run` config builders for RuntimeContext intent and
  optional prompt ingress.
- A shared launch-config schema for Firegrid-neutral MCP server declarations,
  so CLI arguments and durable RuntimeContext launch ingress normalize through
  the same contract before adapter-specific lowering. The public declaration is
  `name` plus `server: { type: "url"; url; headers? }`; ACP's
  `{ type: "http" }` session setup shape is adapter lowering, not the launch
  contract.
- `packages/protocol/src/launch/schema.ts` as the schema-owned launch contract
  for both CLI-derived and durable-ingress launch input.

It should not introduce:

- `FIREGRID_MCP_CONTEXT_ID`.
- Host identity env vars.
- A sidecar process model.
- A CLI-only launch DTO that bypasses the protocol launch schemas.
- Custom JSON-RPC, manual `tools/list`, or manual `tools/call`.
- Manual host-owned Durable Streams URL construction.
- A Firegrid-owned process supervisor.

## Acceptance Criteria

Tracked in `features/firegrid/firegrid-local-mcp-run.feature.yaml`:

- `firegrid-local-mcp-run.LOCAL_COMMAND.1`
- `firegrid-local-mcp-run.LOCAL_COMMAND.2`
- `firegrid-local-mcp-run.LOCAL_COMMAND.3`
- `firegrid-local-mcp-run.LOCAL_COMMAND.4`
- `firegrid-local-mcp-run.LOCAL_COMMAND.5`
- `firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.1`
- `firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.2`
- `firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.3`
- `firegrid-local-mcp-run.MCP_ROUTE.1`
- `firegrid-local-mcp-run.MCP_ROUTE.2`
- `firegrid-local-mcp-run.EFFECT_COMPOSITION.1`
- `firegrid-local-mcp-run.EFFECT_COMPOSITION.2`
- `firegrid-local-mcp-run.EFFECT_COMPOSITION.3`
- `firegrid-local-mcp-run.AUTHORITY_BOUNDARY.1`
- `firegrid-local-mcp-run.AUTHORITY_BOUNDARY.2`
- `firegrid-local-mcp-run.VALIDATION.1`
- `firegrid-local-mcp-run.VALIDATION.2`
