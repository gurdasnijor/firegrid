# Proposal: DurableTable Collection Row Observation

Status: implementation-driving API proposal

Firegrid already has the primitive: `DurableTable` collections are the durable
fact surface and the live observation surface.

- A product that wants to ingest GitHub PR, Linear, permission, or webhook
  updates defines a `DurableTable` collection and writes rows through normal
  table actions.
- A UI or client that wants realtime changes uses that same collection's
  existing live query/subscription surface.
- An agent or workflow that wants to wait registers that same collection under a
  short source name for `wait_for`.

The missing ergonomic surface is not a new event projection abstraction or a
source layer. It is a Firegrid-agnostic row observation stream on each
DurableTable collection facade:

```txt
DurableTable collection -> rows() -> sourceCollectionStreamHandle(name, rows) -> wait_for
```

Verified webhooks should consume this generic collection registration path.
They should not gain a product-specific `VerifiedWebhookFactSource.layer`.

## Existing Generic Boundary

`packages/effect-durable-operators/src/DurableTable.ts` already owns the
stream-to-table materialization and live collection boundary:

```ts
const tableLayer = SomeTable.layer({
  streamOptions: { url, contentType, headers },
  txTimeoutMs,
})
```

The resulting collection facade is used for writes, queries, live
subscriptions, and `wait_for` source registration. `effect-durable-operators`
should not learn about Firegrid `wait_for`, `SourceCollections`, or runtime
source names. It remains a Firegrid-agnostic operators package whose handoff is
the generated `DurableTableCollectionFacade`.

Durable Streams remains the lower-level retained log transport. It stores and
delivers stream events, but it does not know about table materialization,
schema-owned table collections, live UI queries, or `wait_for` source names.

## Proposed DurableTable API

Add one generic method to every `CollectionFacade` in
`packages/effect-durable-operators/src/DurableTable.ts`:

```ts
interface CollectionFacade<Row extends object, Key> {
  readonly collection: DurableTableCollection<Row>
  readonly rows: () => Stream.Stream<Row, DurableTableError>
  // existing write/query/get/subscribe methods remain unchanged
}
```

`rows()` emits current non-deleted rows and live non-deleted row changes using
the same TanStack collection subscription semantics DurableTable already wraps.
It is just the common row-observation case of the existing generic
`subscribe(...)` hook.

Runtime durable-tools can register row streams with
`sourceCollectionStreamHandle(name, facade.rows())`. If a product wants layer-shaped
registration, it can still call `SourceCollections.register(...)` inside its
own Layer; no new public layer helper is needed unless implementation proves it
removes real code.

## Caller Composition

Given a table declaration:

```ts
export class VerifiedWebhookFactTable extends DurableTable(
  "firegrid.verifiedWebhook",
  { verifiedWebhookFacts: VerifiedWebhookFactSchema },
) {}
```

The product or host composition supplies the Durable Streams options to the
table layer, uses the collection normally for durable writes and live
observation, then registers that same collection under a source name for
`wait_for`:

```ts
const verifiedWebhookTableLayer = VerifiedWebhookFactTable.layer(
  verifiedWebhookFactTableLayerOptions({
    streamUrl,
    headers,
  }),
)

const registerVerifiedWebhookFacts = Effect.gen(function* () {
  const sources = yield* SourceCollections
  const table = yield* VerifiedWebhookFactTable
  yield* sources.register(
    sourceCollectionStreamHandle(
      "firegrid.verifiedWebhooks",
      table.verifiedWebhookFacts.rows(),
    ),
  )
})
```

Verified webhook ingest remains:

```ts
yield* ingestVerifiedWebhook({
  source,
  headers,
  rawBody,
  config,
})
```

UI/client usage remains ordinary DurableTable collection usage. There is no
webhook/event projection API between the table and live UI updates.

There is no Firegrid-owned webhook POST endpoint in this API. If an external
provider sends HTTP, the product/app route or Worker captures raw body bytes,
headers, source id, and source secret, then calls the ingest helper inside the
layer above.

## Agent `wait_for` Source Names

`wait_for.eventQuery.stream` is a `SourceCollections` registry key, not a
DurableTable namespace or collection id. The source name is caller- or
product-chosen and should be short enough for agents to type:

```ts
{
  eventQuery: {
    stream: "firegrid.verifiedWebhooks",
    whereFields: {
      source: "linear:workspace:abc",
      eventType: "Issue",
      externalEntityKey: "2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9",
    },
  },
  timeoutMs: 60000,
}
```

Current `whereFields` keys map to top-level row fields. Header matching,
payload matching, and correlation-id matching require a later scalar projection
schema or path-aware `wait_for` input.

Permission facts can use existing top-level fields by mapping:

- `permissionId` to `externalEventKey`;
- `contextId` or `parentSessionId` to `externalEntityKey`;
- the permission fact kind to `eventType`.

## Package Boundary

`effect-durable-operators` owns:

- `DurableTable.layer({ streamOptions })`;
- collection facade generation for writes, queries, and live subscriptions;
- collection row observation through `rows()`;
- request header passthrough types for table stream options;
- no imports from `@firegrid/*`.

`@firegrid/runtime` durable-tools owns:

- `SourceCollections`;
- `sourceCollectionStreamHandle`;
- `WaitFor.match` over registered source names.

Product/runtime composition owns:

- stream URLs and auth headers;
- source names;
- product-owned HTTP routes or Workers, when external providers are involved.

## Minimal Implementation Slice

1. Add `rows()` to `DurableTable` collection facades.
2. Register source collections with `sourceCollectionStreamHandle(name, facade.rows())`.
3. Add a focused DurableTable test proving `rows()` emits an existing row and a
   later live row without emitting deleted rows.
4. Keep existing durable-tools tests as coverage for
   `sourceCollectionStreamHandle(...) -> WaitFor.match`.
5. Add a follow-up verified-webhook tracer or focused runtime test:
   - compose `VerifiedWebhookFactTable.layer(...)`;
   - register `sourceCollectionStreamHandle("firegrid.verifiedWebhooks", table.verifiedWebhookFacts.rows())`;
   - call `ingestVerifiedWebhook`;
   - prove `WaitFor.match` observes the persisted fact.

## Non-Goals

- No webhook HTTP endpoint.
- No Firegrid callback URL minting or callback token issuance.
- No provider registry.
- No Linear-specific helper.
- No schema migration for payload or header projection.
- No new agent tool.
- No `VerifiedWebhookFactSource.layer`.
- No `sourceCollectionLayer` unless a later implementation proves it removes
  real product composition code.
- No new event projection abstraction.
- No changes to session tools or host-context work.
