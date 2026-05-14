# 020: Verified Webhook Ingest To Durable Facts

Status: Spike output for Tracer G from
`docs/tracers/019-workflow-driven-runtime-next-wave.md`.

This tracer answers how an external-style webhook becomes a schema-owned
durable fact that `wait_for` can observe. It does not implement an adapter.

## Recommendation

Use a tiny product-owned ingest adapter in front of Firegrid's DurableTable row
write. Do not add a parallel Firegrid HTTP service.

The adapter owns HTTP request parsing, raw-body HMAC verification, source
configuration, and translation from provider JSON into one schema-owned durable
row operation. Firegrid owns the durable row contract, idempotent row write, and
`wait_for` observation path.

Direct Durable Streams ingest is not enough for arbitrary webhook JSON today:
the base protocol accepts bytes at a stream URL, while DurableTable materializes
rows from State Protocol change events. A provider webhook payload such as a
Linear-like JSON object is not already a State Protocol insert/upsert event and
cannot by itself create a DurableTable row.

## Sources

- `features/firegrid/firegrid-durable-tools.feature.yaml`
- `features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`
- `features/firegrid/firegrid-durable-subscriber-webhooks.feature.yaml`
- `packages/effect-durable-operators/src/DurableTable.ts`
- `packages/effect-durable-streams/README.md`
- `packages/effect-durable-streams/src/protocol/Http.ts`
- `docs/research/firegrid-state-protocol-mapping.md`
- Durable Streams Protocol:
  `https://raw.githubusercontent.com/durable-streams/durable-streams/main/PROTOCOL.md`
- Durable State docs:
  `https://durablestreams.com/durable-state`

## Concrete Answers

### 1. Direct POST to stream URL

An arbitrary webhook sender cannot POST directly to a Durable Streams stream URL
and create a DurableTable row unless it already speaks the State Protocol row
format for the target table.

The Durable Streams base protocol defines stream creation, byte append, reads,
closure, and idempotent producer headers. It leaves message schema and framing
to higher-level protocols. DurableTable writes use `@durable-streams/state`
helpers to append JSON State Protocol events shaped like:

```json
{
  "type": "firegrid.webhook.fact",
  "key": "[\"linear-demo\",\"evt_123\"]",
  "value": { "...": "..." },
  "headers": { "operation": "insert", "txid": "..." }
}
```

A provider webhook body does not carry `type`, `key`, `headers.operation`, or
the Firegrid-owned row value shape. Posting it as-is would at most append raw
bytes; it would not be a materialized DurableTable insert.

### 2. HMAC verification location

HMAC verification needs to live before the DurableTable row write.

Today there is no Firegrid or Durable Streams endpoint config that accepts an
arbitrary provider request, verifies an HMAC over the raw body, transforms the
payload into a State Protocol table change, and then appends it. The local
`effect-durable-streams` endpoint config is client-side Durable Streams request
configuration, not a server-side webhook verifier.

Acceptable v0 locations:

- a product-owned Worker/serverless function;
- a small route in an existing product HTTP service;
- a local test adapter used only by the tracer scenario.

The adapter may call `DurableTable.insertOrGet` / `insert` / `upsert`, or it may
produce the exact State Protocol event through the table's schema helpers where
that is already exposed. It should not raw-append provider JSON.

### 3. Smallest adapter contract

The adapter boundary should be this small:

```ts
interface VerifiedWebhookIngestRequest {
  readonly source: string
  readonly headers: ReadonlyMap<string, string>
  readonly rawBody: Uint8Array
  readonly receivedAt: string
}

interface VerifiedWebhookIngestResult {
  readonly factKey: readonly [source: string, externalEventKey: string]
  readonly outcome: "inserted" | "duplicate" | "conflict"
}
```

Adapter steps:

1. Read the raw request body exactly as received.
2. Verify the configured HMAC scheme against raw bytes and request headers.
3. Decode the body as JSON only after verification.
4. Derive `source`, `externalEventKey`, optional `externalEntityKey`,
   `eventType`, `payloadSha256`, and source-neutral metadata.
5. Write one DurableTable row operation:
   `verifiedWebhookFacts.insertOrGet(row)` for idempotent fact creation.
6. Acknowledge success only after the DurableTable operation is accepted and
   observable through the table layer.

If `insertOrGet` returns an existing row with the same `payloadSha256`, the
adapter returns `duplicate`. If the same key maps to a different payload hash,
the adapter returns `conflict` and does not overwrite the original fact in this
MVP. A future conflict table can preserve conflict evidence if a product needs
that operational surface.

### 4. First fact row shape

Use one schema-owned, source-neutral fact table. It should be generic enough for
Linear-like events, but it should not become a generic webhook product.

Proposed table identity:

```txt
DurableTable name: firegrid.webhookFacts
Collection: verifiedWebhookFacts
Primary key: factKey = JSON tuple [source, externalEventKey]
```

Proposed row:

```ts
interface VerifiedWebhookFact {
  readonly factKey: readonly [source: string, externalEventKey: string]
  readonly source: string
  readonly externalEventKey: string
  readonly externalEntityKey?: string
  readonly eventType: string
  readonly receivedAt: string
  readonly verifiedAt: string
  readonly signatureScheme: string
  readonly payloadSha256: string
  readonly selectedHeaders: Readonly<Record<string, string>>
  readonly payload: unknown
}
```

Shape notes:

- `source` is a configured source id such as `linear-demo`, not a product
  taxonomy owned by Firegrid.
- `externalEventKey` should come from the provider delivery id or event id.
- `externalEntityKey` is optional and useful for waits keyed by issue,
  repository, customer, task, or similar external entity identity.
- `selectedHeaders` excludes signatures, auth headers, cookies, and secrets.
- `payload` remains source-owned JSON. Firegrid does not model Linear fields.

The composite primary key should follow
`firegrid-durable-tools.BOUNDARIES.6`: encode through a schema transform to a
JSON tuple string, not an ad hoc separator.

### 5. Redelivery idempotency

At-least-once redelivery should be idempotent at the domain key, not only at the
Durable Streams producer-header layer.

The adapter derives the primary key deterministically:

```txt
factKey = [source, externalEventKey]
```

Then it calls `DurableTable.insertOrGet(row)`.

Expected outcomes:

- first delivery: `Inserted`;
- same key and same payload hash: `Found`, treated as duplicate success;
- same key and different payload hash: `Found`, treated as conflict without
  replacing the original fact.

If a provider does not supply a stable event or delivery id, the product adapter
must define a source-specific deterministic key. Firegrid should not guess a
fallback key from arbitrary JSON because that would turn product semantics into
substrate policy.

### 6. `wait_for` observation path

The existing durable-tools path is sufficient:

1. Declare the `VerifiedWebhookFact` DurableTable.
2. Compose the table layer once in the runtime scope.
3. Register `verifiedWebhookFacts` with `SourceCollections`.
4. Workflow code calls `WaitFor.match` against scalar fields.

Example trigger:

```ts
yield* WaitFor.match({
  name: "linear-issue-updated",
  source: "firegrid.webhookFacts.verifiedWebhookFacts",
  trigger: [
    { path: ["source"], equals: "linear-demo" },
    { path: ["eventType"], equals: "Issue.updated" },
    { path: ["externalEntityKey"], equals: "issue:LIN-123" },
  ],
  resultSchema: VerifiedWebhookFactSchema,
  timeoutMs: 60_000,
})
```

This matches `firegrid-durable-tools.SUBSCRIPTION.1` and
`firegrid-durable-tools.SUBSCRIPTION.3`: the router subscribes to the source
DurableTable collection with initial state included, evaluates scalar
predicates, writes wait completion evidence, and completes the workflow deferred
with the raw matched row. The call site decodes the row.

## Proposed Acceptance Criteria

- `firegrid-tracer-g-webhook-ingest.INGEST.1`: A verified inbound HTTP
  request is acknowledged only after one schema-owned DurableTable fact row is
  inserted or recognized as a duplicate by primary key.
- `firegrid-tracer-g-webhook-ingest.INGEST.2`: Invalid HMAC, missing required
  event key, malformed JSON, and duplicate-different-payload conflict are
  rejected before any successful fact overwrite.
- `firegrid-tracer-g-webhook-ingest.INGEST.3`: The adapter writes through
  DurableTable `insertOrGet` or generated State Protocol table helpers; it does
  not raw-append provider JSON to Durable Streams.
- `firegrid-tracer-g-webhook-ingest.IDEMPOTENCY.1`: Re-delivery with the same
  source and external event key does not produce a second logical fact and does
  not launch duplicate agent or workflow work.
- `firegrid-tracer-g-webhook-ingest.WAIT.1`: A workflow or agent-visible
  `wait_for` call can observe the durable fact through `SourceCollections`
  without a new dispatcher or polling loop.
- `firegrid-tracer-g-webhook-ingest.BOUNDARY.1`: Firegrid does not define a new
  HTTP ingress service, product-specific Linear client, generic webhook server,
  callback URL minting layer, or top-level package for this path.

These ACIDs can either remain tracer-local or become a small future feature
file. They do not require edits to
`firegrid-workflow-driven-runtime.feature.yaml` or
`firegrid-durable-tools.feature.yaml` for this spike.

## Non-Goals

- No runtime-host workflow changes.
- No workflow-engine changes.
- No new top-level package.
- No generic webhook server.
- No product-specific Linear client.
- No Firegrid-owned callback URL minting, callback token issuance, signature
  secret storage, or provider event taxonomy.
- No per-message workflow activity for inbound payload processing.

## Upstream Limitation To Account For

Durable Streams is the durable byte stream and idempotent producer protocol.
Durable State is the structured table-change protocol layered on top. Neither
one currently provides a Firegrid-configurable server-side verifier/translator
that can receive arbitrary webhook JSON, verify provider HMAC signatures, and
materialize a DurableTable row.

That limitation is acceptable. The Firegrid-shaped boundary is:

```txt
external webhook
  -> product-owned verifier/translator adapter
  -> DurableTable insertOrGet verified webhook fact
  -> SourceCollections / WaitFor observation
  -> workflow or agent action
```

The adapter is the only non-durable ingress edge. Its output is the durable
fact, and all downstream work starts from that fact.
