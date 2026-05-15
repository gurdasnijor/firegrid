# Proposal: Local MCP Run Interface

## Problem

After the route-scoped MCP host work, Firegrid has the right runtime pieces but
no simple public command that a developer can run to exercise them. The current
paths are split:

- `pnpm firegrid:host` starts a long-lived host but expects an external Durable
  Streams endpoint and does not create a RuntimeContext or print an MCP URL.
- `pnpm firegrid:run` creates and starts one context, then exits with the child
  process exit code. That is correct for synchronous run smoke, but it is the
  wrong shape for MCP Inspector or a long-lived MCP client.

The local interface should be one command that starts the host/MCP scope,
creates a host-bound context through production primitives, prints the concrete
MCP URL, and stays alive.

## Effect Composition Rule

This is not a new Firegrid process manager. It is a small Effect entrypoint.

Use the same library-owned lifecycle shape as Effect examples:

- `repos/effect/packages/platform-node/src/NodeRuntime.ts` exposes
  `NodeRuntime.runMain`.
- `repos/effect/packages/platform-node/examples/http-router.ts` runs an HTTP
  layer with `NodeRuntime.runMain(Layer.launch(HttpLive))`.
- `repos/effect/packages/platform-node/examples/http-tag-router.ts` composes
  `NodeHttpServer.layer(...)`, route layers, and `Layer.launch`.
- `repos/effect/packages/effect/src/Layer.ts` provides `Layer.scoped`,
  `Layer.scopedDiscard`, and `Layer.launch` for scoped resources and long-lived
  layers.

Firegrid should express local MCP as:

```ts
const HostAndMcpLive = FiregridMcpServerLayer({
  host: "127.0.0.1",
  port: 0,
  path: "/mcp",
}).pipe(
  Layer.provideMerge(FiregridLocalHostLive({
    durableStreamsBaseUrl: durableStreams.baseUrl,
    namespace,
    input: true,
    localProcessEnv,
  })),
  Layer.tap(() =>
    Effect.gen(function*() {
      const context = yield* insertLocalRuntimeContext(intent, {
        contextId,
        createdBy: "firegrid:mcp:local",
      })
      const address = yield* HttpServer.addressFormattedWith(Effect.succeed)
      const mcpPath = runtimeContextMcpPath("/mcp").replace(
        ":contextId",
        encodeURIComponent(context.contextId),
      )
      yield* Console.log(JSON.stringify({
        type: "firegrid.mcp.local.ready",
        contextId: context.contextId,
        mcpUrl: new URL(mcpPath, address).toString(),
        namespace,
        durableStreamsBaseUrl: durableStreams.baseUrl,
        embeddedDurableStreams: durableStreams.embedded,
      }))
    })
  ),
)

NodeRuntime.runMain(Layer.launch(HostAndMcpLive))
```

The code above is illustrative. The implementation should keep the same shape:
Effect scope owns acquisition and release, `Layer` owns host/MCP composition,
`Layer.launch` owns the long-lived process lifetime, and `NodeRuntime.runMain`
is the process boundary.

## Command Contract

Add:

```sh
pnpm firegrid:mcp:local
pnpm firegrid:mcp:local:env
pnpm firegrid:mcp:local -- [agent command...]
pnpm firegrid:mcp:local:env -- [agent command...]
```

Initial flags should mirror the already-validated `firegrid:run` input where
useful:

- `--namespace NAME`, defaulting to a local development namespace.
- `--mcp-host HOST`, default `127.0.0.1`.
- `--mcp-port PORT`, default `0`.
- `--mcp-path PATH`, default `/mcp`.
- `--cwd PATH`.
- `--prompt TEXT`.
- `--secret-env NAME[=ENV_NAME]`.
- optional `-- [agent command...]`.

With no agent argv, the command seeds a minimal no-op `RuntimeContext` through
`insertLocalRuntimeContext` and prints the MCP URL. That is the default path:
callers should not need to provide dummy argv just to get a valid MCP context.

With agent argv, the command uses the existing local-process run-config shape to
customize the seeded `RuntimeContext` intent.

The command does not call `startRuntime` as part of the local MCP bootstrap.
This is intentional: it is an MCP context bootstrap, not a synchronous run path.
MCP tools need a durable, host-bound `RuntimeContext` as their authority record
so `requireLocalContext` can gate tool calls and `CurrentRuntimeContext` can be
provided during execution. The runtime intent still exists because
`RuntimeContext` is the canonical durable context record; even a not-yet-started
context needs a valid intent for later execution or inspection.

If `DURABLE_STREAMS_BASE_URL` is set, use it. If it is absent, start an embedded
loopback `DurableStreamTestServer` as a scoped local development resource. The
embedded server is not a product service and is not used by `firegrid:host`.

Print exactly one ready record to stdout after the context and MCP listener are
available:

```json
{
  "type": "firegrid.mcp.local.ready",
  "contextId": "ctx_...",
  "mcpUrl": "http://127.0.0.1:49152/mcp/runtime-context/ctx_...",
  "namespace": "firegrid-local-mcp",
  "durableStreamsBaseUrl": "http://127.0.0.1:49151",
  "embeddedDurableStreams": true
}
```

Human-readable diagnostics can go to stderr if needed. Tooling should consume
the JSON ready record from stdout.

## Required Reuse

The implementation should reuse:

- `FiregridLocalHostLive` for host session and host-owned stream authority.
- `insertLocalRuntimeContext` for host-bound context creation.
- `FiregridMcpServerLayer` for MCP toolkit mounting.
- `runtimeContextMcpPath` plus `encodeURIComponent(contextId)` for URL
  construction.
- Existing `firegrid:run` config parsing helpers where possible.

It should not introduce:

- `FIREGRID_MCP_CONTEXT_ID`.
- Host identity env vars.
- A sidecar process model.
- Custom JSON-RPC, manual `tools/list`, or manual `tools/call`.
- Manual host-owned Durable Streams URL construction.
- A Firegrid-owned process supervisor.

## Proposed Write Set

Implementation PR:

- `src/mcp-local.ts` - the small NodeRuntime entrypoint.
- `src/run.ts` or `packages/runtime/src/runtime-host/sync-run.ts` - only if a
  parse helper must be shared with `firegrid:run`; keep behavior unchanged and
  allow no-argv local MCP bootstrapping.
- `package.json` - add `firegrid:mcp:local` and `firegrid:mcp:local:env`.
- `scenarios/firegrid/src/tracer-021-local-mcp-run.test.ts` - public command
  smoke using the real MCP SDK.
- `README.md` and/or `packages/runtime/README.md` - short usage snippet.

No runtime-host workflow, host authority, MCP protocol, durable-tools, or app
code changes are required.

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
