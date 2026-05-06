# SDD: Flamecast Replatforming on Firegrid

Status: build-facing draft

## Principle

```text
Flamecast owns what a session/provider/capability/prompt means.
Firegrid owns how durable facts, waits, projections, claims, subscribers,
runtime execution, and replay/recovery are recorded, observed, and moved.
```

Firegrid should become the durable substrate underneath Flamecast, not a home
for Flamecast product semantics.

## Product Need

Flamecast already has the product shape for programmable cloud agents, but its
durable mechanics are spread across product-specific infrastructure: Durable
Objects, Postgres, R2, ClickHouse, runtime adapters, callback routes, WebSocket
replay, and local tracing helpers.

The replatforming goal is to shift durable mechanics onto Firegrid while
preserving Flamecast's product API, UI, provider contracts, auth policy,
credential handling, and normalized event semantics.

## Durable Platform Shape

Firegrid provides product-neutral mechanics for:

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

Flamecast provides:

- AgentSpec, ProviderManifest, CapabilitySpec, providerAuth/providerOptions;
- product HTTP/API/SDK shape;
- provider adapters and reattach profiles;
- normalized session/event schema;
- provider callback payloads and signing;
- WorkOS/org/API-key/BYOK policy;
- UI, React/web ergonomics, billing, and product route behavior.

## Acai Authority

This SDD is rationale and dispatch guidance. Implementation authority is the
Acai spec graph:

- `firegrid-platform-invariants.*`
- `flamecast-product-contract.*`
- `firegrid-agent-runtime-substrate.*`
- `firegrid-projection-query.*`
- `firegrid-client-projection-api.*`
- `firegrid-observability.*`
- `firegrid-durable-subscriber-webhooks.*`
- `firegrid-runtime-presence.*`
- `firegrid-execution-plane-resources.*`
- `firegrid-runtime-ownership-transfer.*`
- `firegrid-scheduling-tool-bindings.*`
- `firegrid-claimed-intent-transport.*`

Implementation work should cite full ACIDs only. For example:

```text
firegrid-platform-invariants.BOUNDARY.1
flamecast-product-contract.LOWERING.1
firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1
firegrid-client-projection-api.BROWSER_SAFE_FACADE.1
```

## Runtime Topology

The initial topology is split:

- browser/edge/Worker code uses `@firegrid/client`;
- runtime handlers/subscribers use `@firegrid/runtime` in a Node tier;
- app/runtime code uses public `@firegrid/substrate` and
  `@firegrid/substrate/event-plane` descriptors where appropriate;
- app code never imports `@firegrid/substrate/kernel`.

This is an architectural constraint, not an implementation detail. The first
Flamecast chassis should keep the UI/browser path and Node runtime path
separate even if both are launched locally in development.

## Build Path

1. Land platform invariants and product contract specs.
2. Land substrate/runtime, projection/query, client query, observability,
   delivery, presence, resource, ownership, scheduling, and claimed-intent
   specs.
3. Build LT-02 as a real `apps/flamecast` chassis, not a throwaway smoke:
   Flamecast UI starts a local-runtime-backed session and stays the control
   surface while a local Node runtime executes through Firegrid.
4. Replace Flamecast infrastructure incrementally only after each replacement
   has a passing product-shaped proof or a clearly reported Firegrid platform
   gap.
5. Build LT-01 local-to-remote shift after the local session loop is stable.

## First Product-Shaped Proof

LT-02 is the first useful proof:

```text
Flamecast web UI
  -> Flamecast API and auth shell
  -> app-owned Operation / EventStream / EventPlane descriptors
  -> Firegrid durable substrate
  -> local Flamecast runtime process using @firegrid/runtime
  -> normalized Flamecast events and typed terminalization
  -> Flamecast web UI query/replay/live-tail
```

The local runtime can use a deterministic provider first. That provider is a
real Flamecast runtime adapter inside the chassis, not a standalone smoke
script and not a Firegrid package.

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
