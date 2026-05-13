# `@firegrid/runtime`

Host-side Firegrid runtime package.

The runtime observes durable control-plane and ingress tables, starts sandbox
providers, writes runtime output rows, owns the workflow engine, and exposes
runtime-only durable tools.

## Public Subpaths

```ts
import {
  FiregridRuntimeHostLive,
  FiregridRuntimeHostFromConfig,
  startRuntime,
} from "@firegrid/runtime/runtime-host"

import {
  DurableStreamsWorkflowEngine,
  fireDueWorkflowClocks,
} from "@firegrid/runtime/workflow-engine"

import {
  DurableToolsWaitForLive,
  WaitFor,
  SourceCollections,
  sourceCollectionHandle,
} from "@firegrid/runtime/durable-tools"
```

| Subpath | Purpose |
| --- | --- |
| `@firegrid/runtime/runtime-host` | Runtime host Layer, config, `startRuntime`, and ingress helpers. |
| `@firegrid/runtime/workflow-engine` | Durable `@effect/workflow` engine backed by Firegrid tables. |
| `@firegrid/runtime/durable-tools` | Runtime-only durable tools, currently `WaitFor.match`. |

## Runtime Host

`FiregridRuntimeHostLive` wires the runtime tables and local-process sandbox
provider. Provide it once per host process.

```ts
import {
  FiregridRuntimeHostLive,
  startRuntime,
} from "@firegrid/runtime/runtime-host"
import { Effect } from "effect"

const HostLive = FiregridRuntimeHostLive({
  durableStreamsBaseUrl: "http://127.0.0.1:8080",
  namespace: "dev",
  input: true,
})

const program = startRuntime({ contextId: "ctx_123" }).pipe(
  Effect.provide(HostLive),
  Effect.scoped,
)
```

Use `FiregridRuntimeHostFromConfig` for env-driven host composition:

```sh
export DURABLE_STREAMS_BASE_URL="http://127.0.0.1:8080"
export FIREGRID_RUNTIME_NAMESPACE="dev"
export FIREGRID_RUNTIME_INPUT_ENABLED="true"

pnpm firegrid:host
```

`FIREGRID_DURABLE_STREAMS_TOKEN` is optional and is passed as a per-request
Authorization header when present.

## Runtime With Workflow

`FiregridRuntimeHostWithWorkflowLive` adds the durable workflow engine to the
host layer. Use it when workflows or durable tools need
`WorkflowEngine.WorkflowEngine`.

```ts
import { FiregridRuntimeHostWithWorkflowLive } from "@firegrid/runtime"

const Live = FiregridRuntimeHostWithWorkflowLive({
  durableStreamsBaseUrl: "http://127.0.0.1:8080",
  namespace: "dev",
  input: true,
})
```

## Durable Tools

`@firegrid/runtime/durable-tools` currently ships `WaitFor.match`, a
workflow-handler primitive that persists a wait row and resumes when the
subscription router observes a matching row in a registered DurableTable
source collection.

Read the detailed durable-tools guide:

- [durable-tools README](src/durable-tools/README.md)
- [Durable tools SDD](../../docs/proposals/SDD_FIREGRID_DURABLE_TOOLS.md)

## Boundary Rules

- Runtime product code uses shared DurableTable declarations, not raw
  `@durable-streams/client` or `@durable-streams/state`.
- Provider-specific behavior lives with providers, not in protocol.
- Runtime-private workflow and durable-tool tables stay in this package.
- Acquire runtime layers once per host scope; do not create table layers per
  row operation.
