# Proposal: Verified Webhook Fact Source API

Status: API composition proposal for implementation review

The existing `packages/runtime/src/verified-webhook-ingest/README.md` remains
the usage baseline for `ingestVerifiedWebhook`. This proposal defines the one
missing ergonomic interface: register verified webhook facts as a short,
agent-facing `wait_for` source.

## Programmer API

Add one layer-shaped helper under
`packages/runtime/src/verified-webhook-ingest/` and the runtime barrel:

```ts
export const verifiedWebhookFactSourceName = "firegrid.verifiedWebhooks"

export class VerifiedWebhookFactSource {
  static readonly defaultSourceName = verifiedWebhookFactSourceName

  static layer(options?: {
    readonly sourceName?: string
  }): Layer.Layer<never, never, SourceCollections | VerifiedWebhookFactTable>
}
```

`VerifiedWebhookFactSource.layer(...)` registers
`VerifiedWebhookFactTable.verifiedWebhookFacts` with `SourceCollections` under
`options?.sourceName ?? verifiedWebhookFactSourceName`. Any registration Effect
can stay internal.

Do not add `VerifiedWebhookSourceDeclaration` in this slice. Product routes
already have the source id and `VerifiedWebhookIngestConfig`; bundling them does
not remove enough code to justify another public type.

Do not add `scalarPayloadFields` in this slice. Current v1 agent matching is
only the top-level fact fields `source`, `externalEventKey`,
`externalEntityKey`, and `eventType`. Selected headers and raw payload remain
stored for inspection. Matching headers, nested payload fields, or correlation
ids requires a later scalar projection schema or path-aware `wait_for` input.

## Product Route Composition

Register the source in startup/layer composition, then keep each HTTP request
handler focused on ingesting the already-routed request.

```ts
import {
  ingestVerifiedWebhook,
  verifiedWebhookFactTableLayerOptions,
  VerifiedWebhookFactSource,
  VerifiedWebhookFactTable,
  DurableToolsWaitForLive,
  type VerifiedWebhookIngestConfig,
} from "@firegrid/runtime"
import { Effect, Layer } from "effect"

const verifiedWebhookLayer = VerifiedWebhookFactTable.layer(
  verifiedWebhookFactTableLayerOptions({
    streamUrl,
    headers,
  }),
)

const waitForLayer = DurableToolsWaitForLive({ streamUrl: durableToolsStreamUrl })

export const routeLayer = Layer.mergeAll(
  verifiedWebhookLayer,
  waitForLayer,
  VerifiedWebhookFactSource.layer(),
)

const source = "linear:workspace:abc"
const linearConfig: VerifiedWebhookIngestConfig = {
  secret: await lookupSecret(source),
  signatureHeaderName: "linear-signature",
  externalEventKeyPath: ["webhookId"],
  eventTypePath: ["type"],
  externalEntityKeyPath: ["data", "id"],
  selectedHeaderNames: ["linear-delivery", "linear-event"],
}

const result = await Effect.runPromise(
  ingestVerifiedWebhook({
    source,
    headers: Object.fromEntries(request.headers),
    rawBody,
    config: linearConfig,
  }).pipe(Effect.provide(routeLayer)),
)
```

The route can still map typed ingest errors to HTTP statuses as described in
the existing README.

## Agent `wait_for` Usage

The current `wait_for` tool accepts `eventQuery.whereFields` as
`Record<string, string | number | boolean>` and maps each key to a top-level
field predicate. Agents should use the short source name:

```ts
{
  eventQuery: {
    stream: "firegrid.verifiedWebhooks",
    whereFields: {
      source: "linear:workspace:abc",
      eventType: "Issue",
      externalEntityKey: "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9"
    }
  },
  timeoutMs: 60000
}
```

For a permission resolution fact, the product route maps:

- `permissionId` to `externalEventKey`;
- `contextId` or `parentSessionId` to `externalEntityKey`;
- the permission fact kind to `eventType`.

Agent input:

```ts
{
  eventQuery: {
    stream: "firegrid.verifiedWebhooks",
    whereFields: {
      source: "app:permissions",
      eventType: "permission_resolved",
      externalEventKey: "perm_123",
      externalEntityKey: "ctx_789"
    }
  },
  timeoutMs: 300000
}
```

Direct matching on `correlationId`, selected headers, or nested payload fields
requires a follow-up scalar projection schema or path-aware `wait_for` input.

Do not add a new agent tool for this slice. The current `wait_for` tool is
sufficient once the source name is stable and short.

## Minimal Implementation Slice

1. Add `verifiedWebhookFactSourceName = "firegrid.verifiedWebhooks"`.
2. Add `VerifiedWebhookFactSource.layer({ sourceName? })`.
3. Export both from `@firegrid/runtime`.
4. Add one focused test or tracer update:
   - compose `VerifiedWebhookFactTable`;
   - compose `VerifiedWebhookFactSource.layer()`;
   - ingest one verified webhook fact with `ingestVerifiedWebhook`;
   - call `WaitFor.match` against `firegrid.verifiedWebhooks`;
   - assert the matched row is the persisted verified webhook fact.

## Non-Goals

- No new agent tool.
- No provider registry.
- No Linear runtime taxonomy.
- No Firegrid HTTP server.
- No public source declaration type in this slice.
- No scalar payload/header projection in this slice.
