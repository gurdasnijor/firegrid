# tf-yxdd CLI Dev-Server Lifecycle Classification

Date: 2026-05-20
Scope: adapter-axis carveout #3 from `docs/handoffs/one-substrate-cycle-2-synthesis.md` §2.3.

## Verdict

CLASSIFIED — disposition (a), named CLI local-dev exception.

`packages/cli/src/bin/run.ts` may own the scoped lifecycle for an embedded
loopback `DurableStreamTestServer` when `DURABLE_STREAMS_BASE_URL` is absent.
This is a local developer convenience, not production durable-substrate
authority. Production and externally managed runs still attach to an explicit
Durable Streams endpoint.

## Evidence

| Evidence | Result |
| --- | --- |
| `packages/cli/src/bin/run.ts` `durableStreamsEndpoint` acquisition | Reads `DURABLE_STREAMS_BASE_URL`; if present, returns that configured endpoint with `embedded: false`. |
| `packages/cli/src/bin/run.ts` embedded branch | Constructs `new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })`, starts it, and returns only its `baseUrl` plus `embedded: true`. |
| `packages/cli/src/bin/run.ts` release path | Uses `Effect.acquireRelease`; the release function calls `server.stop()` through `Effect.tryPromise(...).pipe(Effect.ignore)`. |
| `packages/cli/src/bin/run.ts` host configuration | Passes the resolved `baseUrl` into existing host/client configuration. The CLI does not construct durable table rows, workflow requests, or host-owned stream routes directly. |
| Dependency guardrail | `.dependency-cruiser.cjs` keeps `packages/cli/src/**` from importing `@firegrid/runtime`; the CLI remains a projection/execution boundary, not a runtime substrate owner. |

## Rationale

The feature specs already require this local development behavior:

- `firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.1`: configured
  `DURABLE_STREAMS_BASE_URL` wins.
- `firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.2`: absent configuration
  starts an embedded loopback `DurableStreamTestServer` as a scoped resource.
- `firegrid-local-mcp-run.EMBEDDED_DURABLE_STREAMS.3`: the embedded server is
  local-developer-only; production host commands attach to explicit endpoints.
- `firegrid-local-mcp-run.EFFECT_COMPOSITION.2`: lifecycle is acquired and
  released through Effect scope.

Moving this body below the runtime line would make runtime own a development
server launcher. The current body is narrower: it bootstraps a loopback endpoint
for `firegrid run` and then hands the endpoint to the existing host/runtime
composition. It does not own DurableTable authority, workflow-engine authority,
provider adapters, or production stream routing.

## Guardrail

The exception is conditional. If CLI code begins writing durable rows, invoking
workflow-engine internals, constructing host-owned Durable Streams URLs, or
starting a non-loopback/prod-capable server, this exception no longer applies
and that body must move below the runtime/substrate line.

## Implication For Cycle 2

The adapter-axis Outcome B carveouts are now fully classified: `tf-pisb`
relocated session byte-stream adapter bodies below runtime, `tf-r8ib` named the
MCP host HTTP server as a binding-edge exception, and `tf-yxdd` names the CLI
embedded Durable Streams lifecycle as a local-dev exception. Channel-axis CLI
projection cleanup can proceed without treating the embedded dev server as
durable-substrate authority.
