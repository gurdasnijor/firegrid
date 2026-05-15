# Durable Webhook Facts And `wait_for`

Audience: product and runtime engineers wiring provider webhooks into Firegrid
durable fact flows.

Use this pattern when a product-owned HTTP route receives a provider webhook
and a durable process or agent should later wait for that verified fact with
`wait_for`.
Verified webhooks are one concrete producer of the broader Firegrid pattern:
durable facts are ordinary DurableTable rows, and durable-tools can expose any
registered DurableTable collection to `wait_for`.

## Ground Truth

- Spec: `features/firegrid/firegrid-verified-webhook-ingest.feature.yaml`
- Spec: `features/firegrid/firegrid-durable-tools.feature.yaml`
- Runtime README:
  `packages/runtime/src/verified-webhook-ingest/README.md`
- `wait_for` README: `packages/runtime/src/durable-tools/README.md`
- Verified ingest scenario:
  `scenarios/firegrid/src/tracer-020-verified-webhook-ingest.test.ts`
- Source registration proof:
  `packages/runtime/src/durable-tools/WaitFor.test.ts`
- Agent `wait_for` lowering:
  `packages/runtime/src/agent-tools/tool-use-to-effect.ts`
- Agent `wait_for` protocol schema:
  `packages/protocol/src/agent-tools/schema.ts`
- Agent `wait_for` tests:
  `packages/runtime/src/agent-tools/tool-use-to-effect.test.ts`
- Source collection helper:
  `packages/runtime/src/durable-tools/internal/source-collections.ts`
- Table declaration:
  `packages/runtime/src/verified-webhook-ingest/table.ts`

## Shape

The product owns the HTTP edge. That route or Worker captures the raw request
bytes, resolves the source id and secret, decides provider response status, and
calls `ingestVerifiedWebhook`.

Firegrid runtime owns the durable fact contract. `ingestVerifiedWebhook`
verifies the HMAC over raw bytes, decodes JSON only after verification, derives
the deterministic fact key `[source, externalEventKey]`, and writes through
`VerifiedWebhookFactTable.verifiedWebhookFacts.insertOrGet`.

Facts land in a normal `DurableTable`:

```txt
DurableTable namespace: firegrid.verifiedWebhook
Collection: verifiedWebhookFacts
Primary key: factKey = [source, externalEventKey]
```

That same collection is the durable fact store, the live subscription surface,
and the `wait_for` source. `SourceCollections` exposes its rows to the
durable-tools router with `sourceCollectionHandle(...)`; no second queue or
provider-specific registry is needed.

Today the ground-truth APIs are concrete and low-level: the product composes
the table layer, runtime composition registers `sourceCollectionHandle`, and
callers use either the programmer-facing `WaitFor.match` API or the
agent-facing `wait_for` tool. A future product/client API may wrap this wiring,
but that ergonomic wrapper is not the current implementation surface.

## Product Route

Compose the fact table once in the product route or Worker runtime:

```ts
import {
  VerifiedWebhookFactTable,
  ingestVerifiedWebhook,
  verifiedWebhookFactTableLayerOptions,
} from "@firegrid/runtime"
import { Effect } from "effect"

const verifiedWebhookFacts = VerifiedWebhookFactTable.layer(
  verifiedWebhookFactTableLayerOptions({
    streamUrl: `${DURABLE_STREAMS_BASE_URL}/v1/stream/firegrid.verifiedWebhook`,
    headers: {
      authorization: () => `Bearer ${DURABLE_STREAMS_TOKEN}`,
    },
  }),
)

const result = await Effect.runPromise(
  ingestVerifiedWebhook({
    source: "linear-demo",
    headers: Object.fromEntries(request.headers),
    rawBody,
    config: sourceConfig,
  }).pipe(Effect.provide(verifiedWebhookFacts)),
)
```

Map `VerifiedWebhookIngestError` at the product edge. For example,
verification and JSON/key derivation failures are usually client rejections,
conflicts are usually `409`, and durable write failures are usually `503`.
The runtime adapter deliberately does not own product response policy.

## Register The Source

Register the DurableTable collection with durable-tools in the runtime-host
scope that also provides `DurableToolsWaitForLive` and the workflow engine:

```ts
import {
  SourceCollections,
  VerifiedWebhookFactTable,
  sourceCollectionHandle,
} from "@firegrid/runtime"
import { Effect } from "effect"

const verifiedWebhookFactsSource = "firegrid.verifiedWebhooks"

const registerVerifiedWebhookFacts = Effect.gen(function*() {
  const sources = yield* SourceCollections
  const table = yield* VerifiedWebhookFactTable

  yield* sources.register(
    sourceCollectionHandle(
      verifiedWebhookFactsSource,
      table.verifiedWebhookFacts,
    ),
  )
})
```

`sourceCollectionHandle` consumes the collection facade's row observation
stream. The router receives initial state and live changes through one
subscription path, so the wait path can match a fact that already exists or
one that arrives later.

The source name is a product/runtime registration key. The table namespace is
still `firegrid.verifiedWebhook`, and the collection is still
`verifiedWebhookFacts`.

## Programmer-Facing Wait API

`WaitFor.match` is currently the lower-level workflow-handler API. Product or
runtime code that is already inside that handler boundary waits on scalar row
fields:

```ts
import { VerifiedWebhookFactSchema, WaitFor } from "@firegrid/runtime"

const outcome = yield* WaitFor.match({
  name: "linear-issue-updated",
  source: "firegrid.verifiedWebhooks",
  trigger: [
    { path: ["source"], equals: "linear-demo" },
    { path: ["eventType"], equals: "Issue.updated" },
    { path: ["externalEntityKey"], equals: "issue:LIN-123" },
  ],
  resultSchema: VerifiedWebhookFactSchema,
  timeoutMs: 60_000,
})
```

The trigger DSL is an AND of scalar field-equality predicates. Put identity
that callers need to match on top-level fact fields such as `source`,
`externalEventKey`, `externalEntityKey`, and `eventType`; do not make the
router understand provider-specific payloads.

## Agent-Facing `wait_for` Tool

Agents use the canonical `wait_for` tool with an `eventQuery`. The tool's
`eventQuery.stream` is the same source name registered with
`SourceCollections`; `whereFields` lowers to the same scalar field-equality
trigger used by `WaitFor.match`:

```json
{
  "eventQuery": {
    "stream": "firegrid.verifiedWebhooks",
    "whereFields": {
      "source": "linear-demo",
      "eventType": "Issue.updated",
      "externalEntityKey": "issue:LIN-123"
    }
  },
  "timeoutMs": 60000
}
```

The current lowering rejects empty `whereFields` and non-scalar values before
calling durable-tools. On match, the tool returns the matched row as
`{ "matched": true, "event": ... }`; on timeout, it returns
`{ "matched": false, "timedOut": true }`.

## Live Observation

Because the fact is just a DurableTable row, live observers can watch the same
table collection used by `wait_for`. A UI, operator, or runtime diagnostic
surface should subscribe to or query `VerifiedWebhookFactTable` directly rather
than asking the ingest route or durable-tools router for separate state.

This keeps one durable authority:

```txt
product HTTP route / Worker
  -> ingestVerifiedWebhook(...)
  -> VerifiedWebhookFactTable.verifiedWebhookFacts.insertOrGet(...)
  -> DurableTable row
       -> SourceCollections / wait_for
       -> live DurableTable subscription or query
```

## Do Not Reimplement

- Do not add a Firegrid provider POST endpoint. The product owns routes,
  callback URLs, provider registration, secrets, and response policy.
- Do not add a Linear-specific registry or event taxonomy in Firegrid runtime.
  `source` is a configured product source id, not a provider catalog.
- Do not hide callback behavior in comments or side channels. Durable facts are
  explicit rows, and callers observe them through `wait_for`.
- Do not add a separate queue, projection, or source abstraction when
  DurableTable rows already provide the durable store, subscription surface,
  and `SourceCollections` handle.
- Do not raw-append provider JSON to Durable Streams and expect a table row.
  The ingest adapter translates verified provider payloads into schema-owned
  DurableTable facts.
