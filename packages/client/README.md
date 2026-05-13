# `@firegrid/client`

Browser-safe Firegrid client APIs for applications.

The client writes and reads through shared Firegrid DurableTables. It does not
start processes, own sandbox providers, or import `@firegrid/runtime`.

## Public Surface

```ts
import {
  Firegrid,
  FiregridConfig,
  FiregridDurableTablesLive,
  FiregridLive,
  FiregridRuntimeTables,
  firegridRuntimeTableTags,
  local,
} from "@firegrid/client"
```

| Export | Purpose |
| --- | --- |
| `Firegrid` | Effect service tag for the client API. |
| `FiregridLive` | Layer that acquires runtime control-plane, ingress, and optional output tables from config. |
| `FiregridConfig` | Config service for Durable Streams base URL, namespace, explicit URLs, content type, and tx timeout. |
| `FiregridDurableTablesLive` | Layer that acquires the shared runtime DurableTables for UI observation. |
| `FiregridRuntimeTables` | `{ ControlPlane, Ingress, Output }` DurableTable tag map. |
| `firegridRuntimeTableTags` | Table tag list for `DurableTableProvider`. |
| `local` | Helper constructors for local-process runtime intents. |

## Configure

Most apps should provide a Durable Streams base URL and a stable namespace.
If the base URL is already service-scoped, for example Electric Cloud's
`.../v1/stream/<service-id>`, Firegrid appends encoded stream names directly
under that prefix.

```ts
import { FiregridConfig, FiregridLive } from "@firegrid/client"
import { Layer } from "effect"

const FiregridBrowserLive = FiregridLive.pipe(
  Layer.provide(
    Layer.succeed(FiregridConfig, {
      durableStreamsBaseUrl: import.meta.env.VITE_DURABLE_STREAMS_BASE_URL,
      namespace: import.meta.env.VITE_FIREGRID_RUNTIME_NAMESPACE,
    }),
  ),
)
```

Explicit stream URLs are still available for tests and special deployments:

```ts
Layer.succeed(FiregridConfig, {
  controlPlaneStreamUrl: "http://127.0.0.1:8080/v1/stream/dev.runtime",
  inputStreamUrl: "http://127.0.0.1:8080/v1/stream/dev.ingress",
  dataPlaneStreamUrl: "http://127.0.0.1:8080/v1/stream/dev.output",
})
```

## Launch And Prompt

```ts
import { Firegrid, local } from "@firegrid/client"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const firegrid = yield* Firegrid

  const handle = yield* firegrid.launch({
    requestedBy: "demo-app",
    runtime: local.jsonl({
      argv: ["node", "agent.mjs"],
    }),
  })

  yield* firegrid.prompt({
    contextId: handle.contextId,
    payload: { type: "text", text: "hello" },
    idempotencyKey: `${handle.contextId}:initial`,
  })

  return yield* handle.snapshot
})
```

`launch` creates a runtime context row. `prompt` writes an ingress input row.
The runtime host observes those tables and performs the side effects.

## Observe Tables In React

Use `FiregridDurableTablesLive` with
`effect-durable-operators/react` to bind UI directly to Firegrid tables.

```tsx
import {
  FiregridDurableTablesLive,
  FiregridRuntimeTables,
  firegridRuntimeTableTags,
} from "@firegrid/client"
import {
  DurableTableProvider,
  useDurableLiveQuery,
  useDurableTable,
} from "effect-durable-operators/react"
import { eq } from "@tanstack/db"

function Contexts() {
  const control = useDurableTable(FiregridRuntimeTables.ControlPlane)
  const { data = [] } = useDurableLiveQuery((q) =>
    q.from({ contexts: control.contexts.collection })
      .where(({ contexts }) => eq(contexts.createdBy, "demo-app")),
  [control])

  return data.map((row) => row.contextId)
}

export function App() {
  return (
    <DurableTableProvider
      layer={FiregridDurableTablesLive}
      tables={firegridRuntimeTableTags}
    >
      <Contexts />
    </DurableTableProvider>
  )
}
```

## API Shape

`FiregridService` exposes:

- `launch(request)` -> `RuntimeContextHandle`
- `prompt(request)` -> durable ingress row
- `open(contextId)` -> `RuntimeContextHandle`
- `watchContexts(predicate?)` -> live `Stream<RuntimeContext>`

`RuntimeContextHandle.snapshot` reads the current context, run rows, output
events, and output logs. It is a point-in-time read, not a live stream.
