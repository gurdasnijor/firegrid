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

import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/workflow-engine"

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

## Synchronous Local Run

Use `pnpm firegrid:run` to launch one local-process command through the durable
runtime path and block for its exit code:

```sh
export DURABLE_STREAMS_BASE_URL="http://127.0.0.1:8080"
export FIREGRID_RUNTIME_NAMESPACE="firegrid-run-dev"

pnpm firegrid:run \
  --cwd "$PWD" \
  --prompt "summarize this workspace" \
  --secret-env AGENT_API_KEY=PARENT_AGENT_API_KEY \
  -- \
  node agent.mjs
```

The command after `--` is the child process argv. The entrypoint creates a
`RuntimeContext` row, appends the optional `--prompt` as a
`RuntimeIngressTable.inputs` row before `startRuntime`, runs the context through
`RuntimeContextWorkflow`, records runtime output in `RuntimeOutputTable`, and
then exits with the child exit code.

Flags:

- `--cwd PATH` writes `RuntimeContext.runtime.config.cwd`; the local-process
  provider spawns the child from that durable row value.
- `--prompt TEXT` writes the first input to `RuntimeIngressTable`; stdin
  delivery reads from durable ingress rather than bypassing it.
- `--secret-env CHILD_ENV[=HOST_ENV]` authorizes one env binding. Both sides are
  env-var names, never raw secret values. The durable row stores only
  `{ name: "CHILD_ENV", ref: "env:HOST_ENV" }`, and the host resolves the value
  at spawn time.

The local-process child environment is allowlisted: a minimal process baseline
such as `PATH`, plus `SandboxConfig.envVars` and `SandboxCommand.envVars`.
Unrelated host env vars, including `FIREGRID_DURABLE_STREAMS_TOKEN`, are not
passed to the child unless explicitly bound. Child stdout/stderr are untrusted
and journaled verbatim; a child that prints its own secret can still leak it.
See [Runtime Environment Boundary](../../docs/architecture/runtime-env-boundary.md)
for the boundary model.

For Electric Cloud, use the same command shape with env-backed configuration:

```sh
export DURABLE_STREAMS_BASE_URL="https://api.electric-sql.cloud/v1/stream/<service-id>"
export FIREGRID_RUNTIME_NAMESPACE="firegrid-run-dev"
export FIREGRID_DURABLE_STREAMS_TOKEN="<token>"

pnpm firegrid:run --cwd "$PWD" --prompt "hello" -- node agent.mjs
```

Use `pnpm firegrid:run:env` to load the root `.env` file. Do not pass tokens or
secret values as CLI flags. The production-shaped smoke runbook is
[Firegrid Run - Synchronous MVP](../../docs/runbooks/firegrid-run-sync-mvp.md).
The short local smoke command is:

```sh
pnpm smoke:firegrid-run
```

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
