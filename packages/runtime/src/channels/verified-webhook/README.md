# channels/verified-webhook/

The verified-webhook channel — Live binding of the existing
`VerifiedWebhookFactChannel` Tag (declared in
`packages/protocol/src/channels/verified-webhook.ts`) plus the
`makeVerifiedWebhookSource` helper that productizes per-provider wiring.

## Files

- **`source-live.ts`** — `makeVerifiedWebhookSource(config)` factory. One
  call per webhook provider (Linear, GitHub, Slack, …) mounts an HTTP
  listener, runs HMAC verification + payload decode through the existing
  `ingestVerifiedWebhook` adapter, journals to
  `VerifiedWebhookFactTable`, and projects an `IngressChannel<Fact>` so
  agents can `wait_for` on a typed channel target. Also exports
  `mergeWebhookSourceChannels` for hosts that want multiple providers to
  share one channel target.
- **`live.ts`** — pre-existing channel-Live + `CallerOwnedFactStreams`
  binding. The Tag is `VerifiedWebhookFactChannel` from protocol; the
  observation stream is the channel's `binding.stream`. Helper output in
  `source-live.ts` is the natural producer of the projection this file
  registers.

## Public docs

- **`docs/recipes/durable-webhook-facts-and-wait-for.md`** — the
  audience-facing recipe. Use it to onboard.
- `firelab/src/simulations/linear-webhook-cookbook-composition/` —
  full agent-loop worked example. Runs end-to-end with
  `pnpm simulate:run linear-webhook-cookbook-composition`.

## Don't

- Don't add a new `connectors/` / `adapters/` tier for per-provider
  webhook adapters. The channel primitive already covers them — SDD #761
  Second Revision documents why a parallel primitive (`ConnectorAdapter`)
  was rejected.
- Don't add per-provider tables. All providers share
  `VerifiedWebhookFactTable` and `VerifiedWebhookFactSchema`; Linear adds
  typed extra fields via `LinearWebhookFactSchema` but uses the same row.
- Don't reach into `verified-webhook-ingest/` from host code. Compose
  through `makeVerifiedWebhookSource` instead.
