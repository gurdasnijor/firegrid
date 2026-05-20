# Projection Contracts

## Single Interaction Pattern

All public and semi-public surfaces should be projections of protocol-owned
contracts:

```text
protocol operation / observation / channel contract
  -> environment projection package
  -> transport or runtime-owned capability tag
  -> runtime authority / workflow / adapter
  -> durable streams substrate
```

Projection packages include:

- `@firegrid/client-sdk` for browser/app-safe TypeScript clients;
- agent/MCP/Effect-AI tool binding;
- CLI;
- future REST, gRPC, and JSON-RPC bindings;
- host-sdk public composition entrypoints.

Projection packages must not define independent operation catalogs,
observation catalogs, workflow handles as public API, table handles as public
API, or copied schema definitions.

## Channels Vs Session/Control Projections

Channels are for agent/application choreography:

- `wait_for(channel, match, timeout)`
- `send(channel, payload)`
- `call(channel, request)`

They hide low-level transports such as durable table CDC, durable stream
subscriptions, webhook facts, human approval events, and future engine-native
wait primitives.

Channels are **not** the API for all control-plane operations. These remain
session/control projections:

- launch;
- start;
- prompt / append ingress;
- close / terminate;
- permission response;
- session snapshot / attach / open.

Implementation may lower both channels and session/control operations through
runtime workflows, durable streams, tables, clocks, or engine primitives. The
agent-visible shape stays different.

## Protocol Ownership

Protocol should own:

- operation input/output schemas and operation metadata;
- shared channel target schemas and metadata schemas;
- normalized observation schemas;
- shared fact schemas such as verified-webhook facts before the first public
  binding ships;
- domain error schemas that cross bindings;
- durable row schemas only when multiple packages must agree on them.

Protocol should not teach durable table handles as the application API. Table
definitions may exist as shared mechanics, but docs should frame them as lower
substrate, not as how a user drives Firegrid.

## Schema Evolution Rule

Private beta needs a minimal schema-versioning policy before public users build
against the protocol catalog.

Recommended policy:

- beta protocol minor versions are additive by default;
- breaking schema changes require a major or an explicit migration note;
- projection packages accept at least the immediately prior compatible protocol
  minor when practical;
- durable row schemas that participate in replay include version fields or have
  a migration story;
- docs identify whether a schema is stable public contract, beta contract, or
  internal implementation detail.

This should be folded into
`docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`.

## Error Placement Rule

Use the same package-boundary rule for errors as for schemas:

- shared domain/projection errors live in protocol;
- runtime-internal failure types live in runtime;
- binding-edge errors live in the owning projection package.

Examples:

- `UnknownChannelTarget` can live with the channel/projection layer if it is only
  a binding lookup failure.
- runtime ingress, context execution, workflow, provider, and adapter failures
  belong in runtime unless they are promoted to public protocol outcomes.

## External Trigger Sequencing

For the first Linear verified-webhook channel, use schema-first sequencing:

1. protocol: land `LinearWebhookFactSchema` or equivalent;
2. runtime: verified webhook ingest writes durable facts of that schema;
3. host/app binding: `LinearWebhookChannel` wraps the fact source as an ingress
   channel;
4. app/cookbook: compose the HTTP route, runtime ingest, and channel Layer.

Do not define the schema first in host-sdk and move it to protocol later. That
is the duplicate-catalog drift pattern the projection contract is supposed to
prevent.

## Package Split Decisions

Recommended decisions for now:

- no `@firegrid/host-runtime` package before private beta; `@firegrid/runtime`
  remains the lower execution home;
- keep agent/MCP tool binding in host-sdk through private beta, but mark a
  post-beta extraction to `@firegrid/agent-tools` as the preferred target;
- keep `FiregridRuntimeHostLive` stable for private beta; rename only post-beta
  with deprecation alias if the name continues to confuse consumers;
- keep `session_new_all` P2 optional until measured or user evidence proves
  repeated `session_new` is insufficient.

