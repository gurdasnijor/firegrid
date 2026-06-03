# `@firegrid/runtime`

Host-side Firegrid runtime package.

The runtime observes durable control-plane and ingress tables, starts sandbox
providers, writes runtime output rows, owns the workflow engine, and exposes
runtime-owned workflow definitions.

`@firegrid/runtime` is the execution substrate below Firegrid's projection
surfaces. Client SDK methods, CLI commands, MCP tools, and future REST, gRPC, or
JSON-RPC adapters should bind protocol contracts and delegate down to runtime
capabilities through host composition. Runtime should not import those bindings
or expose workflow handles as the application-facing API.

For the stable operational map of the runtime package, see
[Runtime Architecture](ARCHITECTURE.md). The SDDs remain decision records.

## Public Subpaths

```ts
import {
  FiregridRuntimeHostLive,
} from "@firegrid/runtime/composition/host-live"
import { startRuntime } from "@firegrid/runtime/composition/host-public"

import { DurableStreamsWorkflowEngine } from "@firegrid/runtime/engine/durable-streams-workflow-engine"
```

| Subpath | Purpose |
| --- | --- |
| `@firegrid/runtime/composition/host-live` | Runtime host Layer composition. |
| `@firegrid/runtime/composition/host-public` | `startRuntime`, ingress helpers, and public host facade helpers. |
| `@firegrid/runtime/engine/durable-streams-workflow-engine` | Low-level durable `@effect/workflow` engine substrate for engine tests and tiny-firegrid simulations. |
| `@firegrid/runtime/subscribers/wait-router` | Runtime-owned wait workflow definitions. |
| `@firegrid/runtime/subscribers/runtime-control` | Runtime-control workflow definitions and dispatcher surfaces. |

## Runtime Host

`FiregridRuntimeHostLive` wires the runtime tables and local-process sandbox
provider. Provide it once per host process.

```ts
import {
  FiregridRuntimeHostLive,
} from "@firegrid/runtime/composition/host-live"
import { startRuntime } from "@firegrid/runtime/composition/host-public"
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
`RuntimeContext` row, routes the optional `--prompt` through host-owned
`appendRuntimeIngress` before `startRuntime`, runs the context through
`RuntimeContextWorkflow`, records runtime output in `RuntimeOutputTable`, and
then exits with the child exit code.

Flags:

- `--cwd PATH` writes `RuntimeContext.runtime.config.cwd`; the local-process
  provider spawns the child from that durable row value.
- `--prompt TEXT` writes the first input by completing the owner workflow's
  runtime-input `DurableDeferred`; stdin delivery does not bypass host routing.
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

## Runtime With Workflow

`FiregridRuntimeHostWithWorkflowLive` adds the durable workflow engine to the
host layer. Use it when workflows need
`WorkflowEngine.WorkflowEngine`.

```ts
import { FiregridRuntimeHostWithWorkflowLive } from "@firegrid/runtime"

const Live = FiregridRuntimeHostWithWorkflowLive({
  durableStreamsBaseUrl: "http://127.0.0.1:8080",
  namespace: "dev",
  input: true,
})
```

## Boundary Rules

- Runtime product code uses shared DurableTable declarations, not raw
  `@durable-streams/client` or `@durable-streams/state`.
- Provider-specific behavior lives with providers, not in protocol.
- Runtime-private workflow tables stay in this package.
- Acquire runtime layers once per host scope; do not create table layers per
  row operation.

## Mapping this package's Effect surface

This is the largest Effect surface in the repo (services, layers, typed errors).
Before refactoring runtime composition, map it with the Effect language service
rather than grepping — these commands read the **resolved** Effect types:

```sh
pnpm --filter @firegrid/runtime overview     # census: every Service / Layer / Yieldable Error here
pnpm effect:layerinfo --file packages/runtime/src/<f>.ts --name <LayerName>   # one layer's provides/requires + composition
pnpm effect:quickfixes                       # Effect-idiom cleanups with diffs
```

`overview` is the shrink scoreboard — re-run it after a consolidation to confirm
the service/layer count actually dropped. See
[`docs/TOOLING.md` → Effect diagnostics & devtools](../../docs/TOOLING.md) for
the full workflow.
