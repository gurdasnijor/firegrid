# `@firegrid/client-sdk`

Browser- and edge-safe Firegrid client APIs for application code.

`@firegrid/client-sdk` writes durable session intent and reads Firegrid durable
projections. It does not import `@firegrid/runtime`, start processes by itself,
own sandbox providers, or deliver live runtime input. `session.start()` records
a durable start request and returns an acknowledgement; host processes execute
that request through `@firegrid/host-sdk`.

## Public Surface

```ts
import {
  Firegrid,
  FiregridConfig,
  FiregridControlPlaneTableLive,
  FiregridClientOperations,
  FiregridLive,
  FiregridStandaloneLive,
  FiregridRuntimeTables,
  firegridRuntimeTableTags,
  local,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/client-sdk"
```

| Export | Purpose |
| --- | --- |
| `Firegrid` | Effect service tag for the client API. |
| `FiregridConfig` | Config service for Durable Streams URLs, namespace, content type, auth headers, and tx timeout. |
| `FiregridLive` | Client service layer. It expects a `RuntimeControlPlaneTable` in scope so it can share the same materialized context index as a host in the same process. |
| `FiregridStandaloneLive` | `FiregridLive` plus its own control-plane table layer. Use this for browser/edge readers or server code that is not also composing the runtime host in-process. |
| `FiregridControlPlaneTableLive` | Layer for the namespace-scoped runtime control-plane table. This is the browser-live table layer that can be safely shared with React table providers. |
| `FiregridClientOperations` | Protocol-backed operation catalog for client projections. Client decoders use these schema entries rather than a client-local contract or the runtime agent-tool projection. |
| `FiregridRuntimeTables` | DurableTable tag map for `ControlPlane` and `Output`. Runtime input is host/workflow owned and is not exposed here as a browser-write table. |
| `firegridRuntimeTableTags` | Table tag list for advanced compositions that provide all required table layers. |
| `local` | Helper constructors for local-process runtime intents. |
| `runtimeControlPlaneStreamUrl` | Namespace-scoped control-plane stream URL helper for advanced client table composition. Host-owned/per-context stream URL builders are not part of the client SDK surface. |

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

An explicit control-plane stream URL is still available for tests and special
deployments:

```ts
Layer.succeed(FiregridConfig, {
  controlPlaneStreamUrl: "http://127.0.0.1:8080/v1/stream/dev.runtime",
})
```

## Durable Sessions

The main app-facing surface is the session facade. It creates or loads a
RuntimeContext from a caller-owned external key, reads durable snapshots, and
waits for permission requests.
Its inputs are decoded through protocol-owned session operation schemas exposed
by `FiregridClientOperations`.

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

Server/host code that needs to send the initial prompt should use
`@firegrid/host-sdk` `appendRuntimeIngress`; the browser-safe client does not
append runtime input rows directly.

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
  // Send the response through host/app authority, not a browser table write.
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

`snapshot.agentOutputs` and `wait.forAgentOutput` are derived from
host-owned `RuntimeOutputTable.events` rows through protocol-owned observation
schemas. `snapshot.events` and `snapshot.logs` remain available for raw
inspectors and diagnostics.

`wait.forPermissionRequest` reads normalized PermissionRequest observations from
the same agent-output projection for the scoped session. The client resolves the
session's RuntimeContext row first, then opens the correct host-owned output
stream using that row's host binding. It returns either `{ matched: true,
request }` or `{ matched: false, timedOut: true }`.

`session.start()` is intentionally different from snapshot/wait.
It appends a `RuntimeStartRequestRow` and returns a request acknowledgement, not
a terminal process result. Host/server code that needs a synchronous terminal
result should use `@firegrid/host-sdk` `startRuntime({ contextId })`.

## Lower-Level Operations

`firegrid.launch` and `firegrid.open(contextId).snapshot` remain available for
lower-level integrations and tests.
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
- host-owned output events and logs;
- normalized agent-output observations for product session semantics.

For live React views, the current generic table provider path is safest for the
namespace control plane:

```tsx
import {
  FiregridControlPlaneTableLive,
  FiregridConfig,
  FiregridRuntimeTables,
} from "@firegrid/client-sdk"
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
generic RuntimeContext/session plumbing into `@firegrid/client-sdk`, keep factory
facts and provider semantics in the app.
