# `@firegrid/client-sdk`

Browser- and edge-safe Firegrid client APIs for application code.

`@firegrid/client-sdk` is the TypeScript/app projection of Firegrid's protocol
contracts. Its methods are ergonomic wrappers over protocol-owned operation and
channel contracts: they validate app-shaped input, call the relevant semantic
channel/capability, and return typed results. The client does not define a
workflow graph, start processes by itself, own sandbox providers, or deliver
live runtime input. `session.start()` records a durable start request through
the host-control channel surface and returns an acknowledgement; host processes
execute that request through `@firegrid/host-sdk`.

The same protocol contracts can be projected into other bindings: CLI commands,
MCP tools, and future REST, gRPC, or JSON-RPC endpoints. Those bindings may look
different to their callers, but they should validate against the same protocol
schemas and lower to the same semantic channels. The client SDK is one
projection of the channel model, not the dominant way to configure a central
agent graph.

## Projection Model

Firegrid has three caller-facing shapes over the same protocol contracts:

| Caller | Surface | What the caller sees |
| --- | --- | --- |
| Application code | `firegrid.sessions.createOrLoad`, `session.start`, `session.permissions.respond`, `session.wait.forAgentOutput` | Typed methods scoped to a durable session. |
| Agents | `wait_for(channel, { match })`, `send(channel, payload)`, `call(channel, request)` | Opaque semantic channel names plus decoded payloads. |
| CLI / future RPC | Commands or endpoint handlers | Transport-shaped projection of the same schemas and channel contracts. |

Application code should choose the method surface unless it is implementing a
new binding. Agents use the verb surface. Neither surface should require table
names, stream URLs, workflow handles, runtime observation tags, or durable-row
builders.

## Public Surface

```ts
import {
  Firegrid,
  FiregridConfig,
  FiregridClientOperations,
  FiregridLive,
  FiregridStandaloneLive,
  local,
} from "@firegrid/client-sdk"
```

| Export | Purpose |
| --- | --- |
| `Firegrid` | Effect service tag for the client API. |
| `FiregridConfig` | Config service for Durable Streams URLs, namespace, content type, auth headers, and tx timeout. |
| `FiregridLive` | Client service layer for host-composed apps that already provide the required protocol-backed capabilities. |
| `FiregridStandaloneLive` | `FiregridLive` plus default browser/edge-safe client layers. Use this for app code that is not also composing the runtime host in-process. |
| `FiregridClientOperations` | Protocol-backed operation catalog for client projections. Client decoders use these schema entries rather than a client-local contract or the runtime agent-tool projection. |
| `local` | Helper constructors for local-process runtime intents. |

Compatibility exports for raw table diagnostics may remain in the package, but
they are not the product API. New application flows should use session methods
and semantic channel waits instead of importing durable table tags or stream URL
helpers.

## Is It Browser Safe?

The production client entrypoints are browser/edge safe:

- no `@firegrid/runtime` import path;
- no Node-only module imports in production client source;
- no process environment reads;
- no process or sandbox start authority.

Tests under `packages/client-sdk/test` may use Node fixtures. Those are not
part of the browser-facing package surface.

## Configuration

Applications pass Durable Streams configuration explicitly. For Electric Cloud,
`durableStreamsBaseUrl` can be the service-scoped root shown in the dashboard,
for example `https://api.electric-sql.cloud/v1/stream/<service-id>`. Firegrid
appends encoded stream names below that root.

```ts
import { FiregridConfig, FiregridStandaloneLive } from "@firegrid/client-sdk"
import type { DurableTableHeaders } from "@firegrid/protocol"
import { Layer } from "effect"

const token = import.meta.env.VITE_FIREGRID_DURABLE_STREAMS_TOKEN
const headers = token === undefined || token.length === 0
  ? undefined
  : ({
    Authorization: () => `Bearer ${token}`,
  }) satisfies DurableTableHeaders

export const FiregridBrowserLive = FiregridStandaloneLive.pipe(
  Layer.provide(
    Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: import.meta.env.VITE_DURABLE_STREAMS_BASE_URL,
      namespace: import.meta.env.VITE_FIREGRID_RUNTIME_NAMESPACE,
      ...(headers === undefined ? {} : { headers }),
    }),
  ),
)
```

Tests and diagnostic harnesses may still configure explicit transport URLs, but
end-user docs should treat those as deployment configuration, not as the way to
address Firegrid state.

## Durable Sessions

The main app-facing projection is the session facade. It creates or loads a
RuntimeContext from a caller-owned external key through
`HostSessionsCreateOrLoadChannel`, reads durable snapshots through normalized
observation projections, waits for agent output, and responds to permission
requests through the host permission channel. Its inputs are decoded through
protocol-owned session operation schemas exposed by `FiregridClientOperations`.

The public durable identity is `sessionId`. In v1, `sessionId` is encoded
exactly as `RuntimeContext.contextId`; `contextId` remains on handles as a
compatibility alias while app code migrates to the session vocabulary. This
alias does not create a second table, lookup service, or parent/child hierarchy.

```ts
import { Firegrid, local } from "@firegrid/client-sdk"
import { Effect } from "effect"

export const createPlanner = Effect.gen(function*() {
  const firegrid = yield* Firegrid

  const session = yield* firegrid.sessions.createOrLoad({
    externalKey: { source: "linear.issue", id: "LIN-123" },
    runtime: local.jsonl({
      argv: ["node", "planner.mjs"],
      agentProtocol: "stdio-jsonl",
    }),
    createdBy: "factory",
  })

  return yield* session.snapshot()
})
```

`local.jsonl(...)` is the protocol launch intent helper. CLI presets such as a
future `pnpm firegrid -- run --agent claude ...` should compile to the same
shape rather than introducing a second runtime configuration model.

Applications send prompts through the scoped session method:

```ts
yield* session.prompt({
  idempotencyKey: "initial",
  payload: "Review the Linear issue and propose the next action.",
})
```

Today, `createOrLoad`, `start`, and `permissions.respond` are routed through
protocol-owned channels. `prompt` is the named residual direct input-intent
write pending `tf-fyyk`, because the current public prompt methods return
stored-row acknowledgements while the prompt channels return `void`.

When an app already knows the durable session id, attach to it without
restating runtime config:

```ts
const session = yield* firegrid.sessions.attach({ sessionId })

const snapshot = yield* session.snapshot()
```

`sessions.attach` is a client handle operation. It does not start a runtime,
load ACP history, replay a transcript, or allocate another durable identity.

If the session is running and emits a permission request, the scoped handle keeps
callers from restating RuntimeContext identity:

```ts
const permission = yield* session.wait.forPermissionRequest({
  timeoutMs: 30_000,
})

if (permission.matched) {
  yield* session.permissions.respond({
    permissionRequestId: permission.request.permissionRequestId,
    decision: { _tag: "Allow", optionId: "allow" },
  })
}
```

For product session reads, use normalized agent-output observations instead of
parsing raw output rows:

```ts
const next = yield* session.wait.forAgentOutput({
  afterSequence: lastSeenSequence,
  timeoutMs: 30_000,
})

const snapshot = yield* session.snapshot()
for (const output of snapshot.agentOutputs) {
  console.log(output.sequence, output._tag, output.event)
}
```

`snapshot.agentOutputs` and `wait.forAgentOutput` are derived through the
`SessionAgentOutputChannel` projection and protocol-owned observation schemas.
`snapshot.events` and `snapshot.logs` remain available for raw inspectors and
diagnostics.

`wait.forPermissionRequest` reads normalized PermissionRequest observations from
the same agent-output channel projection for the scoped session. It returns
either `{ matched: true, request }` or `{ matched: false, timedOut: true }`.

`session.start()` is intentionally different from snapshot/wait. It dispatches
through the protocol host-control start channel and returns a request
acknowledgement, not a terminal process result. Host/server code that needs a
synchronous terminal result should use a host-owned run helper, not a browser
client method.

## Attaching External MCP Tools

To give an agent provider tools (Linear, GitHub, Slack, Notion, your own
servers), attach external MCP servers through the runtime's `mcpServers` config.
This is the paved road — it already exists; there is nothing else to build. Each
entry is a `{ name, server: { type: "url", url, headers? } }` declaration that
Firegrid passes through to the agent's session (the ACP `newSession` call). The
agent connects to those MCP servers and calls their tools directly; Firegrid
wraps that tool use with durable sessions, observation, permissioning, waits, and
replay.

```ts
const session = yield* firegrid.sessions.createOrLoad({
  externalKey: { source: "linear.issue", id: "LIN-123" },
  runtime: local.jsonl({
    argv: ["node", "planner.mjs"],
    agentProtocol: "stdio-jsonl",
    mcpServers: [
      {
        name: "linear",
        server: {
          type: "url",
          url: "https://mcp.example.com/linear",
          headers: {
            authorization: { ref: "env:LINEAR_MCP_TOKEN" },
          },
        },
      },
    ],
  }),
  createdBy: "factory",
})
```

`mcpServers` is **client-owned config**: the caller authors the URL, non-secret
headers, and secret header refs end-to-end, and Firegrid carries that as launch
intent without interpreting provider semantics. No provider semantics live in
`@firegrid/protocol` — there is no `linear.*`/`github.*` channel in the protocol
catalog. The protocol stays a neutral substrate; provider tools are described
entirely by the MCP servers you attach.

### Hosted MCP connections (Smithery, etc.)

A hosted MCP provider that bundles many connections behind one endpoint — e.g. a
[Smithery](https://smithery.ai/docs/use/connect) namespace
(`https://mcp.smithery.run/{namespace}`) — is **one** `mcpServers` entry: the
namespace endpoint as `url`, plus a scoped service token as a header. Connection
management (OAuth flows, token refresh, config collection, per-user scoping) is
the hosted provider's job, not Firegrid's. Firegrid attaches the endpoint and
observes the resulting tool use.

```ts
mcpServers: [
  {
    name: "smithery",
    server: {
      type: "url",
      url: "https://mcp.smithery.run/my-app",
      headers: {
        authorization: { ref: "env:SMITHERY_SERVICE_TOKEN" },
      },
    },
  },
]
```

### Credential boundary

Provider auth travels in the entry's `headers`, but provider secrets must not be
embedded as literal values in durable launch intent. Secret-bearing MCP headers
use the same ref discipline as `RuntimeEnvBinding { name, ref }`: the durable
row stores a reference and the host resolves it when attaching/spawning the
session.

Use a header value of `{ ref: "env:VAR_NAME" }` for secret-bearing headers:

```ts
headers: {
  authorization: { ref: "env:SMITHERY_SERVICE_TOKEN" },
}
```

The host must authorize the exact header ref before resolution. Public,
non-secret headers may still be literal strings, but literal secret-shaped MCP
header values are rejected before they enter the durable plane.

### Provider actions are MCP tools first

A provider action (create a Linear comment, open a PR, post to Slack) is an **MCP
tool the agent calls** by default — Firegrid journals the call + result as durable
agent-output observations for replay/audit, and can gate it with a permission
request. Promote a provider action into a Firegrid durable channel **only** when
there is concrete pressure for Firegrid-owned durability around the side effect
itself (claim-before-side-effect, durable evidence rows, retries, or a waitable
completion receipt). The one-line test: *if the agent crashed mid-action, does
Firegrid need to own knowing whether the side effect happened?* No → MCP tool;
yes → durable channel. See the design rationale in
`docs/proposals/tf-x1jx-external-mcp-attachment-design.md`.

## Lower-Level Operations

`firegrid.launch` and `firegrid.open(contextId).snapshot` remain available for
lower-level integrations and tests.
Prefer `firegrid.sessions.createOrLoad(...)` for new RuntimeContext-backed app
work because it centralizes deterministic context identity and scoped session
operations.

Transport-specific APIs should stay above this layer. If a product exposes
Firegrid through HTTP, REST, gRPC, JSON-RPC, or another RPC shape, that adapter
should decode its transport request into the same protocol operation schemas
and channel contracts that `FiregridClientOperations` exposes, then delegate to
the appropriate client, host, or runtime capability. It should not clone schemas
or invent a parallel graph DSL.

## Browser UI Reads

For UI code, use the configured client for point-in-time runtime snapshots:

```ts
const snapshot = yield* firegrid.open(contextId).snapshot
```

The snapshot includes:

- the `RuntimeContext` row when it exists;
- run lifecycle rows from the namespace control plane;
- host-owned output events and logs;
- normalized agent-output observations for product session semantics.

For live product views, prefer `session.wait.*` methods or an app-owned read
model that subscribes through documented semantic channels. Raw table providers
are appropriate for inspectors and diagnostics only; they should be labeled as
raw storage views, not product session APIs.

## What Belongs In Firegrid vs. The App

Firegrid client owns product-neutral mechanics:

- deterministic session create/load by external key;
- RuntimeContext creation through protocol host-authority helpers and
  `HostSessionsCreateOrLoadChannel`;
- start and permission-response dispatch through protocol-owned
  host-control/session channels;
- prompt dispatch remains the documented residual direct input-intent write
  pending `tf-fyyk`;
- runtime snapshot reads;
- waiting for normalized runtime observation channels.

Application code owns product semantics:

- provider/webhook routes and secrets;
- app-owned fact tables and read models;
- product trigger identity such as Linear issue ids;
- optional app-specific channel bindings over generic Firegrid facts, such as
  narrowing `firegrid.verifiedWebhooks` to a Linear issue workflow;
- planner prompts and provider capability policy;
- UI-specific joins, display copy, and domain-specific status.

That split is the intended cutover path for apps such as `apps/factory`: move
generic RuntimeContext/session plumbing into `@firegrid/client-sdk`, keep factory
facts and provider semantics in the app.
