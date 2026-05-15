# `@firegrid/client`

Browser- and edge-safe Firegrid client APIs for application code.

`@firegrid/client` reads and writes Firegrid durable rows. It does not import
`@firegrid/runtime`, start processes by itself, own sandbox providers, or expose
runtime-host internals. When a caller needs to actively start a runtime, the
start authority is supplied by host/server composition through
`RuntimeStartCapability`; ordinary browser code should treat runtime execution as
something a host observes and performs.

## Public Surface

```ts
import {
  Firegrid,
  FiregridConfig,
  FiregridControlPlaneTableLive,
  FiregridLive,
  FiregridStandaloneLive,
  FiregridRuntimeTables,
  firegridRuntimeTableTags,
  local,
} from "@firegrid/client"
```

| Export | Purpose |
| --- | --- |
| `Firegrid` | Effect service tag for the client API. |
| `FiregridConfig` | Config service for Durable Streams URLs, namespace, content type, auth headers, and tx timeout. |
| `FiregridLive` | Client service layer. It expects a `RuntimeControlPlaneTable` in scope so it can share the same materialized context index as a host in the same process. |
| `FiregridStandaloneLive` | `FiregridLive` plus its own control-plane table layer. Use this for browser/edge readers or server code that is not also composing the runtime host in-process. |
| `FiregridControlPlaneTableLive` | Layer for the namespace-scoped runtime control-plane table. This is the browser-live table layer that can be safely shared with React table providers. |
| `FiregridRuntimeTables` | DurableTable tag map for `ControlPlane`, `Ingress`, and `Output`. Ingress and output are host-owned tables, so generic browser code usually reaches them through `snapshot()` rather than a single static provider layer. |
| `firegridRuntimeTableTags` | Table tag list for advanced compositions that provide all required table layers. |
| `local` | Helper constructors for local-process runtime intents. |

## Is It Browser Safe?

The production client entrypoints are browser/edge safe:

- no `@firegrid/runtime` import path;
- no Node-only module imports in production client source;
- no process environment reads;
- no process or sandbox start authority unless the app explicitly provides a
  host-side `RuntimeStartCapability`.

Tests under `packages/client/src/__tests__` may use Node fixtures. Those are not
part of the browser-facing package surface.

## Configuration

Applications pass Durable Streams configuration explicitly. For Electric Cloud,
`durableStreamsBaseUrl` can be the service-scoped root shown in the dashboard,
for example `https://api.electric-sql.cloud/v1/stream/<service-id>`. Firegrid
appends encoded stream names below that root.

```ts
import { FiregridConfig, FiregridStandaloneLive } from "@firegrid/client"
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

An explicit control-plane stream URL is still available for tests and special
deployments:

```ts
Layer.succeed(FiregridConfig, {
  controlPlaneStreamUrl: "http://127.0.0.1:8080/v1/stream/dev.runtime",
})
```

## Durable Sessions

The main app-facing surface is the session facade. It creates or loads a
RuntimeContext from a caller-owned external key, appends prompts, reads durable
snapshots, waits for permission requests, and writes permission responses.

```ts
import { Firegrid, local } from "@firegrid/client"
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

  yield* session.prompt({
    payload: { type: "text", text: "Plan the work for LIN-123." },
    idempotencyKey: "LIN-123:initial",
    metadata: { source: "linear.issue" },
  })

  return yield* session.snapshot()
})
```

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

`session.start()` is intentionally different from prompt/snapshot/wait. It
requires `RuntimeStartCapability`, which is supplied by runtime-host or app
server composition. Browser code can hold and observe sessions, but it should
not supervise local processes.

## Lower-Level Operations

`firegrid.launch`, `firegrid.prompt`, `firegrid.open(contextId).snapshot`, and
`firegrid.wait.for` remain available for lower-level integrations and tests.
Prefer `firegrid.sessions.createOrLoad(...)` for new RuntimeContext-backed app
work because it centralizes deterministic context identity and scoped session
operations.

## Browser UI Reads

For UI code, use the configured client for point-in-time runtime snapshots:

```ts
const snapshot = yield* firegrid.open(contextId).snapshot
```

The snapshot includes:

- the `RuntimeContext` row when it exists;
- run lifecycle rows from the namespace control plane;
- host-owned ingress inputs;
- host-owned output events and logs.

For live React views, the current generic table provider path is safest for the
namespace control plane:

```tsx
import {
  FiregridControlPlaneTableLive,
  FiregridConfig,
  FiregridRuntimeTables,
} from "@firegrid/client"
import {
  DurableTableProvider,
  useDurableLiveQuery,
  useDurableTable,
} from "effect-durable-operators/react"
import { eq } from "@tanstack/db"
import { Layer } from "effect"

const FiregridBrowserTablesLive = FiregridControlPlaneTableLive.pipe(
  Layer.provide(Layer.succeed(FiregridConfig, {
    durableStreamsBaseUrl: import.meta.env.VITE_DURABLE_STREAMS_BASE_URL,
    namespace: import.meta.env.VITE_FIREGRID_RUNTIME_NAMESPACE,
  })),
)

function Contexts() {
  const control = useDurableTable(FiregridRuntimeTables.ControlPlane)
  const { data = [] } = useDurableLiveQuery((q) =>
    q.from({ contexts: control.contexts.collection })
      .where(({ contexts }) => eq(contexts.createdBy, "factory")),
  [control])

  return data.map((row) => <span key={row.contextId}>{row.contextId}</span>)
}

export function App() {
  return (
    <DurableTableProvider
      layer={FiregridBrowserTablesLive}
      tables={[FiregridRuntimeTables.ControlPlane]}
    >
      <Contexts />
    </DurableTableProvider>
  )
}
```

Host-owned ingress/output tables are derived from each context's host binding.
Until a dedicated live helper is added for those per-context tables, prefer
`snapshot()` or an app-owned read model for browser progress panels.

## What Belongs In Firegrid vs. The App

Firegrid client owns product-neutral mechanics:

- deterministic session create/load by external key;
- RuntimeContext row creation through protocol host-authority helpers;
- host-owned ingress/output stream resolution from the context row;
- prompt and permission-response ingress writes;
- runtime snapshot reads;
- waiting for normalized runtime observation sources.

Application code owns product semantics:

- provider/webhook routes and secrets;
- app-owned fact tables and read models;
- product trigger identity such as Linear issue ids;
- planner prompts and provider capability policy;
- UI-specific joins, display copy, and domain-specific status.

That split is the intended cutover path for apps such as `apps/factory`: move
generic RuntimeContext/session plumbing into `@firegrid/client`, keep factory
facts and provider semantics in the app.
