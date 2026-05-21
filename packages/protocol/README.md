# `@firegrid/protocol`

Browser-safe shared schemas, operation contracts, channel contracts, fact
schemas, and shared durable row declarations.

This package owns durable row contracts that must be shared between apps,
`@firegrid/client`, and `@firegrid/runtime`. It does not start processes,
create runtime services, import raw Durable Streams packages, or own provider
delivery policy.

`@firegrid/protocol` is the source of truth for projection surfaces. Client SDK
methods, CLI flags/help, MCP tools, and future REST, gRPC, or JSON-RPC adapters
should all bind from these schemas instead of cloning their own contracts. The
projection may change the caller experience, but the underlying launch,
session, observation, verified-webhook fact, and channel contracts should remain
protocol-owned.

## Public Subpaths

```ts
import * as launch from "@firegrid/protocol/launch"
import * as ingress from "@firegrid/protocol/runtime-ingress"
import * as channels from "@firegrid/protocol/channels"
import * as verifiedWebhook from "@firegrid/protocol/verified-webhook"
```

| Subpath | Purpose |
| --- | --- |
| `@firegrid/protocol/launch` | Launch input schemas, runtime context/run/output schemas, and `RuntimeControlPlaneTable` / `RuntimeOutputTable`. |
| `@firegrid/protocol/runtime-ingress` | Prompt input schemas and runtime ingress row contracts retained for host/workflow compatibility. |
| `@firegrid/protocol/channels` | Channel target brand, channel factories, direction/source-class schemas, binding interfaces, and per-channel Context Tags. |
| `@firegrid/protocol/verified-webhook` | Source-neutral verified webhook fact schemas plus provider payload projections such as Linear fact decoding. |

## Channel Contracts

Channel contracts are the semantic transport surface. Protocol owns the target,
direction, schema, metadata, and per-channel `Context.Tag` identity. Live Layers
that bind a channel to durable tables, verified ingest, workflow execution, MCP
lookup, HTTP routes, or provider adapters live in host/runtime/app integration
packages.

Examples:

- `HostSessionsCreateOrLoadChannel` backs the
  `firegrid.sessions.createOrLoad(...)` client projection.
- `HostPermissionRespondChannel` and `SessionPermissionChannel` back
  `permissions.respond` projections and scoped permission policies.
- `SessionAgentOutputChannel` backs `session.wait.forAgentOutput(...)`.
- `VerifiedWebhookFactChannel` exposes generic verified webhook facts at
  `firegrid.verifiedWebhooks`; product-specific semantics such as Linear issue
  handling live in route/adaptor/app layers, not in the canonical channel name.

## Launch Contracts

`@firegrid/protocol/launch` exports:

- public launch schemas: `PublicLaunchRequestSchema`,
  `PublicLaunchRuntimeIntentSchema`;
- runtime intent helpers: `local`, `localJsonlJournal`,
  `normalizeRuntimeIntent`;
- runtime control-plane schemas and row types: `RuntimeContextSchema`,
  `RuntimeRunEventSchema`, `RuntimeContext`, `RuntimeRunEvent`;
- runtime output schemas and row types: `RuntimeEventSchema`,
  `RuntimeLogLineSchema`, `RuntimeEventRow`, `RuntimeLogLineRow`;
- shared DurableTables: `RuntimeControlPlaneTable` and
  `RuntimeOutputTable`.

```ts
import {
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  local,
} from "@firegrid/protocol/launch"
```

## Runtime Ingress Contracts

`@firegrid/protocol/runtime-ingress` exports:

- `PublicPromptRequestSchema`;
- `promptToRuntimeIngressRequest`;
- `makeRuntimeIngressInputRow`;
- runtime ingress row types.

```ts
import {
  makeRuntimeIngressInputRow,
  promptToRuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
```

## Boundary Rules

- Keep protocol browser-safe.
- Put shared DurableTable declarations here only when both client/app and
  runtime need the same row contract.
- Put operation schemas here when more than one binding projects the same
  contract, such as TypeScript client, CLI, MCP, REST, gRPC, or JSON-RPC.
- Runtime-private tables, workflow-engine state, durable-tool rows, and
  provider delivery policy stay in `@firegrid/runtime`.
- Do not add `@durable-streams/*` imports to this package.
