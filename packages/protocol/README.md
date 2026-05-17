# `@firegrid/protocol`

Browser-safe shared schemas and DurableTable declarations.

This package owns durable row contracts that must be shared between apps,
`@firegrid/client`, and `@firegrid/runtime`. It does not start processes,
create runtime services, import raw Durable Streams packages, or own provider
delivery policy.

## Public Subpaths

```ts
import * as launch from "@firegrid/protocol/launch"
import * as ingress from "@firegrid/protocol/runtime-ingress"
```

| Subpath | Purpose |
| --- | --- |
| `@firegrid/protocol/launch` | Launch input schemas, runtime context/run/output schemas, and `RuntimeControlPlaneTable` / `RuntimeOutputTable`. |
| `@firegrid/protocol/runtime-ingress` | Prompt input schemas and runtime ingress row contracts retained for host/workflow compatibility. |

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
- runtime ingress row types;
- legacy `RuntimeIngressTable` declarations for compatibility with historical
  row contracts.

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
- Runtime-private tables, workflow-engine state, durable-tool rows, and
  provider delivery policy stay in `@firegrid/runtime`.
- Do not add `@durable-streams/*` imports to this package.
