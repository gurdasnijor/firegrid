# Durable Webhook Facts And `wait_for`

Audience: product and runtime engineers wiring provider webhooks (Linear,
GitHub, Slack, custom) into Firegrid durable fact flows that agents can
observe with `wait_for`.

**TL;DR — one call to `makeVerifiedWebhookSource(config)` per adapter.** No
new tier, no per-provider primitive. The helper composes the existing
`VerifiedWebhookFactTable` + `IngressChannel` + caller-fact-streams stack
so the agent's `wait_for({ channel: "firegrid.verifiedWebhooks", whereFields:
{ source, eventType, … } })` resolves cleanly.

## Status

- This pattern is **live and tested**. End-to-end proof:
  - `packages/runtime/test/channels/verified-webhook/source-live.test.ts` —
    Linear + GitHub through the helper with merged channel projection.
  - `packages/tiny-firegrid/src/simulations/linear-webhook-cookbook-composition/`
    — full agent loop (`pnpm simulate:run linear-webhook-cookbook-composition`).
- Public surface: `@firegrid/runtime/channels/verified-webhook/source-live`
  (`makeVerifiedWebhookSource`, `mergeWebhookSourceChannels`).

## The Pattern, In One Diagram

```txt
external provider                               Firegrid
                                                ─────────
POST /webhooks/linear ──► makeVerifiedWebhookSource({linear config})
                            │  (mounts HTTP listener)
                            ▼
                          ingestVerifiedWebhook
                            │ HMAC verify on raw bytes
                            │ JSON decode (post-verify)
                            │ derive [source, externalEventKey]
                            ▼
                          VerifiedWebhookFactTable.insertOrGet
                            │
                            ▼
                          IngressChannel projection
                            │ filter-decode against your factSchema
                            ▼
                          CallerOwnedFactStreams
                            │ keyed by channel target name
                            ▼
                          wait_for({ channel, whereFields }) ◄── agent / workflow
```

Everything below the helper boundary is existing runtime infrastructure. The
helper does the wiring; the boundary stays at the typed channel target name.

## Add A Provider In ~30 Lines

```ts
import {
  makeVerifiedWebhookSource,
  mergeWebhookSourceChannels,
} from "@firegrid/runtime/channels/verified-webhook/source-live"
import {
  VerifiedWebhookFactTable,
  verifiedWebhookFactTableLayerOptions,
} from "@firegrid/runtime/verified-webhook-ingest"
import { VerifiedWebhookFactSchema } from "@firegrid/protocol/verified-webhook"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Layer } from "effect"

const linear = makeVerifiedWebhookSource({
  source: "linear-prod",
  factSchema: VerifiedWebhookFactSchema,
  ingest: {
    secret: env.LINEAR_WEBHOOK_SECRET,
    signatureHeaderName: "x-linear-signature",
    selectedHeaderNames: ["x-linear-signature", "linear-delivery"],
  },
  route: { host: "0.0.0.0", port: 8081, path: "/webhooks/linear" },
})

const github = makeVerifiedWebhookSource({
  source: "github-prod",
  factSchema: VerifiedWebhookFactSchema,
  ingest: {
    secret: env.GITHUB_WEBHOOK_SECRET,
    signatureHeaderName: "x-hub-signature-256",
    externalEventKeyPath: ["pull_request", "node_id"],
    eventTypePath: ["action"],
    externalEntityKeyPath: ["repository", "full_name"],
    selectedHeaderNames: ["x-github-event", "x-github-delivery"],
  },
  route: { host: "0.0.0.0", port: 8082, path: "/webhooks/github" },
})

const factTable = VerifiedWebhookFactTable.layer(
  verifiedWebhookFactTableLayerOptions({
    streamUrl: durableStreamUrl(env.durableStreamsBaseUrl, "firegrid.verifiedWebhookFacts"),
  }),
)

// Merge both sources into one IngressChannel keyed at
// "firegrid.verifiedWebhooks" so agents wait on one target name.
const mergedChannelFromTable = mergeWebhookSourceChannels(
  [linear, github],
  { mergedSchema: VerifiedWebhookFactSchema },
)

// Layer assembly. Provide to FiregridLocalHostLive alongside the channel
// router; see `linear-webhook-cookbook-composition/host.ts` for the full
// wiring template (the cookbook is the worked example; the helper just
// removes the per-source boilerplate from it).
const webhookSources = Layer.mergeAll(
  factTable,
  linear.routeLayer.pipe(Layer.provide(factTable)),
  github.routeLayer.pipe(Layer.provide(factTable)),
)
```

The agent then issues:

```json
{
  "tool": "wait_for",
  "input": {
    "eventQuery": {
      "stream": "firegrid.verifiedWebhooks",
      "whereFields": {
        "source": "github-prod",
        "eventType": "opened",
        "externalEntityKey": "example/repo"
      }
    },
    "timeoutMs": 60000
  }
}
```

The wait-router resolves `firegrid.verifiedWebhooks` through
`CallerOwnedFactStreams`, finds the merged channel stream, matches on the
scalar fact fields, and returns the matched row to the agent as the
`wait_for` tool result.

## Ground Truth

| Path | Role |
| --- | --- |
| `packages/runtime/src/channels/verified-webhook/source-live.ts` | The helper. |
| `packages/runtime/src/channels/verified-webhook/live.ts` | The `VerifiedWebhookFactChannel` Tag binding + `CallerOwnedFactStreams` projection. |
| `packages/runtime/src/verified-webhook-ingest/adapter.ts` | The HMAC-verify + decode + `insertOrGet` body the helper calls. Handles both generic JSON and Linear-shaped payloads. |
| `packages/protocol/src/channels/verified-webhook.ts` | `VerifiedWebhookFactChannelTarget` (`"firegrid.verifiedWebhooks"`) + `VerifiedWebhookFactChannel` Tag. |
| `packages/protocol/src/verified-webhook/schema.ts` | `VerifiedWebhookFactSchema`, `LinearWebhookFactSchema`, fact-key encoding. |
| `packages/tiny-firegrid/src/simulations/linear-webhook-cookbook-composition/` | Full worked example with agent loop. The helper distills its boilerplate. |

## What The Helper Does NOT Touch

- **Provider response policy.** The helper returns `202` on success, `400`
  on signature/decode failure, `500` on internal cause. If your provider
  expects different codes, mount the helper's `routeLayer` behind your
  product's HTTP framework and translate.
- **Secret rotation.** The `ingest.secret` field is a single secret resolved
  at Layer build time. Rotate by replacing the Layer.
- **Channel target naming.** Default target is `"firegrid.verifiedWebhooks"`
  (the shared one). Pass `channelTarget: "myproduct.foo"` to scope a
  source separately if agents need to wait on it independently.
- **Egress / outbound.** This recipe is for ingress. Outbound (push to a
  provider) is a separate channel pattern; see the channel core types
  (`EgressChannel`, `BidirectionalChannel`, `CallableChannel`) in
  `packages/protocol/src/channels/core.ts`.

## Programmer-Facing `WaitFor.match`

Inside a workflow handler, the same channel target is observable via
`WaitFor.match`:

```ts
const outcome = yield* WaitFor.match({
  name: "linear-issue-updated",
  source: "firegrid.verifiedWebhooks",
  trigger: [
    { path: ["source"], equals: "linear-prod" },
    { path: ["eventType"], equals: "Issue.updated" },
    { path: ["externalEntityKey"], equals: "issue:LIN-123" },
  ],
  resultSchema: VerifiedWebhookFactSchema,
  timeoutMs: 60_000,
})
```

The trigger DSL is AND of scalar field-equality predicates. Match on
top-level fact fields (`source`, `externalEventKey`, `externalEntityKey`,
`eventType`); the router does not understand provider-specific payloads.

## Do Not Reimplement

- **Do not** add a new `connectors/` or `adapters/` tier for webhook
  providers. The channel primitive (`IngressChannel<S>` in
  `packages/protocol/src/channels/core.ts`) already covers this and is what
  agents already participate in through the channel router. A spike that
  introduced a parallel `ConnectorAdapter` primitive was rejected in
  SDD #761; see its Second Revision section.
- **Do not** add a provider-specific table. Use `VerifiedWebhookFactTable`.
  All providers share the same fact-row shape via `VerifiedWebhookFactSchema`;
  Linear adds typed extra fields via `LinearWebhookFactSchema`.
- **Do not** raw-append provider JSON to Durable Streams. The ingest
  adapter translates verified payloads into schema-owned rows.
- **Do not** hide callback behavior in side channels. Facts are explicit
  rows; observers see them through `wait_for` or `WaitFor.match`.

## Related

- `docs/recipes/runtime-permission-resume.md` — same channel-as-observation
  pattern for permission resumption.
- `packages/runtime/src/channels/README.md` — channel direction taxonomy
  (ingress / egress / bidirectional / callable).
