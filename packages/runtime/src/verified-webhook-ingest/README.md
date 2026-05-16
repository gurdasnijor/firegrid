# Verified Webhook Ingest

`verified-webhook-ingest` is a narrow runtime-owned tracer surface for turning
an already-routed external webhook request into a schema-owned DurableTable fact.

It is not a Firegrid webhook product. Firegrid does not own HTTP routes,
callback URL minting, callback tokens, provider registration, source secrets,
tenant authorization, provider event taxonomies, or downstream prompt/session
dispatch from webhook payloads.

## Ownership

The product owns:

- the HTTP route, Worker, or serverless handler;
- raw request body capture;
- source id assignment;
- secret lookup and rotation;
- response status mapping;
- product-specific provider setup and operational policy.

Firegrid runtime owns:

- `VerifiedWebhookFactTable`, the durable fact table;
- `ingestVerifiedWebhook`, the verifier/translator function;
- deterministic fact keys `[source, externalEventKey]`;
- idempotent fact creation through `DurableTable.insertOrGet`;
- conflict rejection when the same key arrives with a different payload hash.

## Public API

This tracer intentionally exports a small API from `@firegrid/runtime` so a
product route or Worker can call the same path the scenario uses:

```ts
import {
  ingestVerifiedWebhook,
  VerifiedWebhookFactTable,
  verifiedWebhookFactTableLayerOptions,
  type VerifiedWebhookIngestConfig,
} from "@firegrid/runtime"
```

`VerifiedWebhookIngestConfig` is public for this runtime-owned adapter. It is
source configuration, not provider taxonomy:

```ts
const sourceConfig: VerifiedWebhookIngestConfig = {
  secret: WEBHOOK_SECRET,
  signatureHeaderName: "x-linear-signature",
  externalEventKeyPath: ["webhookId"],
  eventTypePath: ["type"],
  externalEntityKeyPath: ["data", "id"],
  selectedHeaderNames: ["x-linear-delivery"],
}
```

Defaults:

- `signatureHeaderName`: `x-firegrid-signature-256`
- `externalEventKeyPath`: `["id"]`
- `eventTypePath`: `["type"]`
- `externalEntityKeyPath`: omitted
- `selectedHeaderNames`: omitted

`selectedHeaderNames` is a capture allow-list, not an authority boundary. The
adapter still hard-filters common secret-bearing headers and always excludes the
configured signature header.

## Composition

Compose the fact table once where the product route or Worker can provide an
Effect runtime:

```ts
const layer = VerifiedWebhookFactTable.layer(
  verifiedWebhookFactTableLayerOptions({
    streamUrl: `${DURABLE_STREAMS_BASE_URL}/v1/stream/firegrid.verifiedWebhook`,
    headers: {
      authorization: () => `Bearer ${DURABLE_STREAMS_TOKEN}`,
    },
  }),
)
```

Then call `ingestVerifiedWebhook` after the HTTP framework has captured raw
bytes. The function acknowledges success only after the durable fact insert or
duplicate observation has completed:

```ts
const result = await Effect.runPromise(
  ingestVerifiedWebhook({
    source: "linear-demo",
    headers: Object.fromEntries(request.headers),
    rawBody,
    config: sourceConfig,
  }).pipe(Effect.provide(layer)),
)

return result._tag === "Inserted" || result._tag === "Duplicate"
  ? new Response(null, { status: 204 })
  : new Response(null, { status: 500 })
```

Product routes should map `VerifiedWebhookIngestError` deliberately:

- `webhook/verify`: reject, usually `401` or `400`;
- `webhook/decode-json`: reject malformed request, usually `400`;
- `webhook/derive-key`: reject unsupported payload, usually `400`;
- `webhook/conflict`: reject duplicate key with changed payload, usually `409`;
- `webhook/write-fact`: durable substrate failure, usually `503`.

## Why No Firegrid HTTP Service

Firegrid does not need a parallel webhook server to prove this path. The durable
boundary starts at the table fact:

```txt
product HTTP route / Worker
  -> ingestVerifiedWebhook(...)
  -> VerifiedWebhookFactTable.verifiedWebhookFacts.insertOrGet(...)
  -> durable fact row
```

Keeping the HTTP edge product-owned avoids turning Firegrid into a callback URL
manager, credential store, product-specific router, or generic webhook service.
It also keeps provider-specific verification quirks and response policies out of
the Firegrid substrate.

## WaitFor Observation

The fact row shape is ready for existing durable-tools observation. A runtime
composition can register the table collection with `SourceCollections`:

```ts
const sources = yield* SourceCollections
const table = yield* VerifiedWebhookFactTable
yield* sources.register(
  sourceCollectionStreamHandle(
    "firegrid.verifiedWebhook.verifiedWebhookFacts",
    table.verifiedWebhookFacts.rows(),
  ),
)
```

Workflow code can then wait on scalar fields:

```ts
yield* WaitFor.match({
  name: "linear-issue-updated",
  source: "firegrid.verifiedWebhook.verifiedWebhookFacts",
  trigger: [
    { path: ["source"], equals: "linear-demo" },
    { path: ["eventType"], equals: "Issue.updated" },
    { path: ["externalEntityKey"], equals: "issue:LIN-123" },
  ],
  resultSchema: VerifiedWebhookFactSchema,
})
```

The current tracer proves durable fact creation. The next proof can compose
`SourceCollections` and `WaitFor.match` around the same table without changing
the ingest boundary.
