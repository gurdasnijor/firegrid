# connectors/linear/

Linear webhook connector. Implements `ConnectorAdapter<LinearEvent, LinearFact>`
against the primitive defined in `events/connector-adapter.ts`.

Status: **PR-M3.5 spike** — stress-testing the `ConnectorAdapter` shape
against a concrete adapter before PR-M4 commits to it.

## Layout

- `index.ts` — exports `LinearConnector(config)` factory returning the
  `ConnectorAdapter` value.
- `schema.ts` — `LinearWebhookPayloadSchema`, `LinearEventSchema`,
  `LinearFactSchema`.
- `signature.ts` — HMAC-SHA256 verification (mirrors the existing
  `verified-webhook-ingest/adapter.ts` implementation; will collapse
  into the shared `connectors/webhook/` base in PR-M4).

## Configuration

The connector is constructed with a per-instance config:

```ts
import { LinearConnector } from "@firegrid/runtime/connectors/linear"

const linear = LinearConnector({
  secret: process.env.LINEAR_WEBHOOK_SECRET!,
  path: "/webhooks/linear",
})
```

The factory returns a `ConnectorAdapter<LinearEvent, LinearFact>` that
the host installs via `composeConnector(linear)` in `composition/`.
