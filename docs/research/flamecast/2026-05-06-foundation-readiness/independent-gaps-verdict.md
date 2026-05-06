# Independent Gaps Verdict

Source: OCA `FC-FOUNDATION-READINESS/INDEPENDENT-GAPS` read-only verdict.

## Verdict

Partial. Firegrid public surfaces are sufficient today for a minimal
Flamecast-shaped session smoke that proves:

- durable `Operation` as session turn,
- caller-owned `EventStream` as normalized event log,
- caller-owned `EventPlane` for permission/tool/steering rows,
- `RunWait` plus `projectionMatch` plus public `Pending` observation,
- typed terminalization through handler return or `Effect.fail`.

They are not sufficient for full PRD coverage until Flamecast ratifies
`AgentSpec`, `CapabilitySpec`, provider manifests, compatibility checks,
callback contracts, auth/options, and provider semantics. Firegrid should also
ratify product-neutral multi-turn session mechanics and reconnect/replay
posture.

## Confirmed Boundaries

Flamecast-owned:

- `AgentSpec`, `AgentProviderRef`, `CapabilitySpec`, `ContributorSpec`,
  `ProviderManifest`, `ProviderAuth`, provider options, provider registry,
  compatibility checks, SDK ergonomics, BYOK, Standard Webhooks, sequence
  assignment, provider lifecycle, sandboxing, benchmarks, UI, and provider
  runtime semantics.

Firegrid-owned:

- Durable operation lifecycle.
- Typed terminalization.
- Event streams.
- Event planes.
- Durable waits and wakeups.
- Runtime composition through public package surfaces.

## Nuances

- Cancellation is not a critical blocker for a minimum smoke. It can be modeled
  now as a caller-owned EventPlane control row plus handler `Effect.fail` with a
  typed cancellation error. A future `client.cancel` would be ergonomic but
  additive.
- Runtime locality must be explicit: `@firegrid/runtime` is Node-oriented and
  depends on `@effect/platform-node`. Flamecast edge/Cloudflare surfaces should
  use the client side; Firegrid runtime belongs in a Node tier.

## Independent Gap Taxonomy

- Multi-turn long-lived session shape.
- Public wait-state semantics under reconnect/replay.
- Runtime locality split.
- Cancellation pattern and optional future API.
- Sequence and ordering normalization across providers.
- Provider auth/options redaction, storage, and injection.
- AgentSpec, capability, provider manifest, compatibility check, and check
  endpoint semantics.

## Recommended First Lane

`NW-FC-FOUNDATION-SDD`

Firegrid-side, spec-only, additive. It should ratify:

- Multi-turn handler reentry with `RunWait` and `projectionMatch`.
- Reconnect/replay expectations for `client.observe` and `client.events`.
- Cancellation as a product-owned EventPlane control-row pattern.
- Runtime locality: client can be browser/edge-safe, runtime is Node-tier.
- No Flamecast vocabulary in Firegrid packages or feature specs.

