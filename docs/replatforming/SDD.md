# SDD: Flamecast Replatforming on Firegrid

Status: draft

## Principle

```text
Flamecast owns what a session/provider/capability/prompt means.
Firegrid owns how durable facts, waits, projections, claims, subscribers,
runtime execution, and replay/recovery are recorded, observed, and moved.
```

Firegrid should become the durable substrate underneath Flamecast, not a home
for Flamecast product semantics.

## Durable Platform Shape

Firegrid should provide product-neutral mechanics for:

- typed durable operations;
- app-owned EventStreams and EventPlanes;
- durable waits and projection-match wakeups;
- projection/query and replay/live-tail facades;
- runtime composition through Node-tier `@firegrid/runtime`;
- durable subscribers for delivery/callback style channels;
- runtime presence for public ingress discovery;
- resource/materialization facts for local-to-remote handoff;
- ownership transfer with lease/fence/rebuild proof;
- neutral scheduling and claimed-intent mechanics;
- Effect tracing and durable correlation metadata.

Flamecast should provide:

- AgentSpec, ProviderManifest, CapabilitySpec, providerAuth/providerOptions;
- product HTTP/API/SDK shape;
- provider adapters and reattach profiles;
- normalized session/event schema;
- provider callback payloads and signing;
- WorkOS/org/API-key/BYOK policy;
- UI, React/web ergonomics, billing, and product route behavior.

## Acai First

This SDD is not implementation authority. Before code changes, every new
behavior must land as Acai requirements in `features/<product>/*.feature.yaml`.

Recommended first specs:

1. `features/firegrid/firegrid-platform-invariants.feature.yaml`
2. `features/flamecast/flamecast-product-contract.feature.yaml`
3. `features/firegrid/firegrid-agent-runtime-substrate.feature.yaml`
4. `features/firegrid/firegrid-projection-query.feature.yaml`
5. `features/firegrid/firegrid-observability.feature.yaml`
6. `features/firegrid/firegrid-durable-subscriber-webhooks.feature.yaml`

Subsequent specs add client projection APIs, durable identity, execution-plane
resources, runtime presence, ownership transfer, scheduling tool bindings, and
claimed intent transport.

## Runtime Topology

The initial topology is split:

- browser/edge/Worker code uses `@firegrid/client`;
- runtime handlers/subscribers use `@firegrid/runtime` in a Node tier;
- app/runtime code uses public `@firegrid/substrate` and
  `@firegrid/substrate/event-plane` descriptors where appropriate;
- app code never imports `@firegrid/substrate/kernel`.

This is an architectural constraint, not an implementation detail.

## Build Path

The build path is intentionally staged:

1. Ratify platform invariants.
2. Ratify Flamecast product contract and lowering boundaries.
3. Ratify Firegrid projection/query and agent-runtime substrate profiles.
4. Prove a minimal replatform smoke with packed Firegrid packages.
5. Add durable subscriber/webhook, observability, presence, and resource lanes.
6. Prove local-to-remote shift with a deterministic test agent.
7. Incrementally replace Flamecast infrastructure only after each replacement
   has a passing smoke and a clear owner.

## Non-Goals

Firegrid must not absorb:

- provider catalogs;
- AgentSpec semantics;
- providerAuth/providerOptions;
- capability resolution;
- sandbox lifecycle;
- Standard Webhooks signing;
- WorkOS/BYOK/tenant policy;
- prompt/session/tool/permission schemas;
- reusable Flamecast adapter packages under `@firegrid/*`.
