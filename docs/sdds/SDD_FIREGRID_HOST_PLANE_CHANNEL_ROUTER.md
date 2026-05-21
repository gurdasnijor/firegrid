# SDD: Firegrid Host-Plane Channel Router

Status: draft architecture
Created: 2026-05-21
Owner: Firegrid Architecture
Extends:
- `SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md`
- `SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md`
- `docs/architecture/host-sdk-runtime-boundary.md`

## Problem

Firegrid has channel contracts, per-channel `Context.Tag`s, channel factory
functions, and Live Layers. What it still lacks is the convention that binds
those pieces into a host surface.

Today that missing convention shows up as architectural ambiguity:

- channel contracts live in `@firegrid/protocol`;
- several channel Live Layers still bind directly to DurableTable/control-plane
  state from `@firegrid/host-sdk`;
- edge surfaces such as MCP, ACP, CLI, HTTP, or future REST/gRPC need a
  string-addressed dispatch surface;
- `ChannelInventory` filled part of that gap, but as a broad registry it is the
  wrong long-term abstraction.

The smell is the same one a web framework would have without a router: handlers
exist, schemas exist, and transports exist, but there is no canonical object
that says "this host exposes these routes, these schemas, and these handlers."

Firegrid needs that convention for channels.

## Decision

Introduce a **host-plane channel router** as the canonical binding object
between channel contracts and channel implementations.

The router is the Firegrid analogue of a typed RPC router, but for durable
channels instead of request/response-only procedures.

```ts
export const FiregridHostChannelRouter = channelRouter({
  "host.contexts.create": callableRoute({
    contract: HostContextsCreateChannel,
    live: RuntimeHostContextsCreateChannelLive,
  }),
  "host.prompt": egressRoute({
    contract: HostPromptChannel,
    live: RuntimeHostPromptChannelLive,
  }),
  "session.agent_output": ingressRoute({
    contract: SessionAgentOutputChannel,
    live: RuntimeSessionAgentOutputChannelLive,
  }),
  "host.permissions.respond": callableRoute({
    contract: HostPermissionRespondChannel,
    live: RuntimeHostPermissionRespondChannelLive,
  }),
})
```

A host topology composes the router with runtime/kernel providers and edge
adapters:

```ts
Layer.mergeAll(
  FiregridRuntimeKernelLive(options),
  FiregridHostChannelRouterLive,
  FiregridAcpStdioEdgeLive(acpOptions),
  FiregridMcpEdgeLive(mcpOptions),
)
```

Edges dispatch through the router. Application code and agent code do not.

```text
ACP / MCP / HTTP / CLI edge
  -> host-plane channel router
  -> channel route implementation
  -> runtime/kernel service or DurableTable-backed channel binding
  -> DurableTable substrate / workflow state
```

## Non-Goals

The router is **not**:

- the old `ChannelInventory`;
- a public app-level service for arbitrary channel lookup;
- a way for agents to receive workflow handles, table handles, execution ids,
  stream URLs, or kernel services;
- an orchestration graph, planner, workflow manager, or DAG runner;
- a second substrate beside DurableTable.

The router is host-edge infrastructure. It exists because wire protocols carry
opaque target names and payloads, so edge adapters need a single checked place
to resolve `target + verb + payload` into a typed channel operation.

## Package Placement

### `@firegrid/protocol`

Owns channel contracts:

- `ChannelTarget`;
- channel direction schemas;
- channel payload schemas;
- per-channel `Context.Tag`s;
- pure route descriptor types if they are needed for cross-package typing;
- metadata needed by edge projections, such as target, direction, schema, and
  human-facing description.

Protocol does not own route implementations.

### `@firegrid/runtime`

Owns runtime/kernel route implementations:

- channel Live Layers that lower into runtime control-plane tables;
- channel Live Layers that lower into runtime output/observation tables;
- channel Live Layers that signal or start workflows;
- durable request/response workers when a callable route uses mailbox
  semantics;
- any workflow, DurableTable, or adapter machinery below the channel boundary.

This is where `HostPrompt`, `SessionPrompt`, `HostSessionsStart`,
`HostContextsCreate`, and similar request-row/control-plane channel
implementations should converge.

### `@firegrid/host-sdk`

Owns host topology and edge composition:

- selecting which channel router a host exposes;
- composing router Layers with runtime/kernel Layers;
- installing MCP/ACP/HTTP/CLI edge adapters;
- host-author convenience options that lower to Layer composition.

Host SDK should not implement DurableTable-backed route bodies as stable
architecture. It may temporarily compose existing route Live Layers while the
runtime/kernel migration is underway.

### Edge Packages

Each edge adapter owns only wire translation:

- decode wire request;
- resolve `verb + target` through the router;
- encode the router result back to the wire protocol;
- expose router metadata as tool lists, REST schemas, ACP capabilities, CLI
  help, or similar projection-specific shape.

An edge adapter must not invent session, prompt, permission, output, or tool
semantics independently.

## Router Shape

A router entry has three pieces:

1. **Contract**: protocol-owned target, direction, schemas, and tag.
2. **Route implementation**: runtime/kernel-owned Live Layer that provides the
   contract.
3. **Projection metadata**: enough information for edge adapters to list and
   invoke the route without importing substrate internals.

The route direction controls which verbs are legal:

| Direction | Agent/client verb | Route lowering |
|---|---|---|
| `ingress` | `wait_for` / subscribe-style projections | typed stream from durable rows |
| `egress` | `send` | durable append or request sentinel write |
| `call` | `call` | durable request/response handshake |
| `bidirectional` | `send` + `wait_for` | same target supports append and observe |

Routers should reject invalid verb/direction pairs before they reach a route
implementation.

## Dispatch Contract

The router exposes a narrow dispatch API for edge adapters:

```ts
type ChannelRouterDispatch = {
  readonly waitFor: (
    target: ChannelTarget,
    input: WaitForInput,
  ) => Effect.Effect<WaitForOutput, ChannelRouteError>

  readonly send: (
    target: ChannelTarget,
    payload: unknown,
  ) => Effect.Effect<unknown, ChannelRouteError>

  readonly call: (
    target: ChannelTarget,
    request: unknown,
  ) => Effect.Effect<unknown, ChannelRouteError>
}
```

The dispatch API is intentionally `unknown` at the edge because edge payloads
arrive from JSON, ACP, MCP, CLI args, or HTTP bodies. The router decodes with
the route's protocol schema before invoking the route implementation.

Typed in-process code should prefer typed channel tags and ergonomic client
methods. String dispatch is an edge concern.

## Why This Is Not The Old Registry

The old registry shape made arbitrary channel lookup feel like an application
capability. That leaks topology into code that should only know its semantic
surface.

The router has a narrower job:

- it is configured once by host topology;
- it is consumed by edge adapters;
- it validates wire payloads against protocol-owned schemas;
- it emits edge metadata;
- it provides the Layers needed by its route implementations.

Application code should see `firegrid.sessions.createOrLoad`, `send`,
`wait_for`, `call`, or typed channel tags. It should not walk a registry.

## Worked Boundary: `host.prompt`

Target state:

```text
@firegrid/protocol
  HostPromptChannelTarget = "host.prompt"
  HostPromptChannel
  PublicPromptRequestSchema

@firegrid/runtime
  RuntimeHostPromptChannelLive
    lowers PublicPromptRequestSchema
    to RuntimeControlPlaneTable.inputIntents.insertOrGet(...)
    or to the future kernel workflow/signal service

@firegrid/host-sdk
  FiregridHostChannelRouter includes host.prompt route
  FiregridHostLive composes router + runtime/kernel + edge adapters

edge adapter
  receives prompt over ACP/MCP/HTTP/CLI
  calls router.send("host.prompt", payload)
```

The host SDK never needs to know how prompt becomes a DurableTable row or a
workflow signal. It only composes the router that contains the route.

## Relationship To Workflow Signaling

Channels do not bypass workflows. They hide the signaling mechanics behind a
route implementation.

A callable or egress route may lower to:

- a durable request row observed by a kernel worker;
- a workflow signal/mailbox entry;
- an engine-native stream wait primitive;
- a direct in-process runtime service in single-host tests.

Those are implementation choices below the router. The route contract above the
router remains stable.

This is the missing seam for future work such as `HostKernelWorkflow` owning
context workflows. The router does not decide whether a prompt writes a request
row or signals a long-running workflow. It gives all host edges the same
contract while the runtime/kernel chooses the backing mechanism.

## Migration Plan

1. Add pure router descriptor types and helpers.
2. Move table-bound host-control channel Live Layers from `@firegrid/host-sdk`
   into `@firegrid/runtime` or the runtime/kernel channel area.
3. Replace `HostControlChannelsLive` with a host channel router declaration.
4. Update ACP/MCP/CLI edges to consume router metadata and router dispatch.
5. Delete broad `ChannelInventory` consumers. Keep only a thin edge-local
   string-target resolver if an edge still needs it.
6. Update docs/examples so new host surfaces are expressed as
   `router + edge adapters + kernel`, not `registry + ad hoc Layers`.

## Acceptance Criteria

- A reviewer can find one router manifest and know which channel targets a host
  exposes.
- Every route points at a protocol-owned contract.
- Every route implementation lives at or below the runtime/kernel boundary
  unless it is explicitly app-owned.
- Edge adapters use the router instead of hand-wiring channel lookup.
- `@firegrid/host-sdk` composes routers and edges; it does not own durable
  state wiring as stable architecture.
- Typed client methods and agent verbs are projections over router-backed
  channels, not parallel operation catalogs.

## Open Questions

1. Should the pure router helper live in `@firegrid/protocol/channels/router`
   or in a small runtime-neutral package? Default: protocol, because it is
   contract metadata plus typing, not implementation.
2. Should route implementations be expressed as `Layer` values directly, or as
   `{ tag, layer }` descriptors? Default: descriptors, because edge metadata
   and Layer composition need to stay tied together.
3. Should host-specific app channels be registered by extending the same router
   or by merging routers? Default: router merging, so app packages can publish
   their own channel bundles.
4. How much metadata should be required for REST/gRPC generation? Default:
   target, direction, schemas, and optional description first; avoid committing
   to transport-specific metadata until the first edge needs it.
