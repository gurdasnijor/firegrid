# SDD: Firegrid Host-Plane Channel Router

Status: draft architecture
Created: 2026-05-21
Last amended: 2026-05-21 (Effect-native router review: router is a typed
value with `routes` and edge-only `dispatch`; decode failures surface as
`ParseError`; route descriptors own Layer composition; router owns dispatch
spans.)
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

The router value has two views:

1. `routes`: the typed in-process declaration, keyed by target literal.
2. `dispatch`: the derived string-keyed edge view for ACP/MCP/HTTP/CLI and
   other wire protocols.

This mirrors the shape used by typed RPC/API systems: one typed declaration
drives both compile-time usage and runtime edge interpretation.

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
- pure route descriptor types, including the direction-to-verb matrix and the
  `ChannelRouter<Routes>` type;
- metadata needed by edge projections, such as target, direction, schema, and
  human-facing description.

Protocol does not own route implementations or dispatch execution.

### `@firegrid/runtime`

Owns runtime/kernel route implementations:

- channel Live Layers that lower into runtime control-plane tables;
- channel Live Layers that lower into runtime output/observation tables;
- channel Live Layers that signal or start workflows;
- the runtime dispatch interpreter that decodes edge payloads and invokes route
  implementations;
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

Route implementations are descriptors, not raw `Layer` values. The descriptor
keeps the protocol contract, metadata, and Live Layer tied together so the
router can derive its own `Layer.mergeAll(...)` composition. If routes were
only raw Layers, every host topology would have to remember to merge them by
hand and the router would not actually own the route surface.

The route direction controls which verbs are legal:

| Direction | Agent/client verb | Route lowering |
|---|---|---|
| `ingress` | `wait_for` / subscribe-style projections | typed stream from durable rows |
| `egress` | `send` | durable append or request sentinel write |
| `call` | `call` | durable request/response handshake |
| `bidirectional` | `send` + `wait_for` | same target supports append and observe |

The direction-to-verb table is a type-level lookup for typed callers. Invalid
verb/direction pairs should be compile errors when code is generated from or
written against the router declaration. Runtime rejection remains only at the
wire boundary where a verb arrives as a string.

## Dispatch Contract

The router is a typed value. Its `routes` field is the in-process surface; its
`dispatch` field is the string-keyed edge surface derived from those routes.

```ts
type ChannelRouter<Routes extends Record<string, ChannelRoute>> = {
  readonly routes: Routes

  readonly dispatch: {
    readonly waitFor: (
      target: keyof Routes & string,
      input: unknown,
    ) => Effect.Effect<unknown, ChannelRouteError | ParseError>

    readonly send: (
      target: keyof Routes & string,
      payload: unknown,
    ) => Effect.Effect<unknown, ChannelRouteError | ParseError>

    readonly call: (
      target: keyof Routes & string,
      request: unknown,
    ) => Effect.Effect<unknown, ChannelRouteError | ParseError>
  }
}
```

The dispatch API is intentionally `unknown` only at the edge because edge
payloads arrive from JSON, ACP, MCP, CLI args, or HTTP bodies. Dispatch lifts
`Schema.decodeUnknown(route.input)` over the wire payload before invoking the
route implementation. Route implementations receive decoded domain values and
never see `unknown`.

Decode failures surface as `ParseError` in the dispatch error channel. They
should not be hidden inside a generic route error, because schema failure is a
normal edge-boundary outcome.

Typed in-process code should prefer typed channel tags and ergonomic client
methods. String dispatch is an edge concern.

## Dispatch Observability

The router is also the correct place for shared dispatch tracing. Every edge
crosses it, so every edge should get the same span names and attributes without
each adapter reinventing them.

Each dispatch should wrap route invocation in a span such as:

```ts
Effect.withSpan("firegrid.channel.dispatch", {
  attributes: {
    "firegrid.channel.target": target,
    "firegrid.channel.direction": route.direction,
    "firegrid.channel.verb": verb,
  },
})
```

Edges may add protocol-specific child spans, but target/direction/verb belongs
to the router.

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
  calls router.dispatch.send("host.prompt", payload)
    -> Effect<unknown, ChannelRouteError | ParseError>
```

The host SDK never needs to know how prompt becomes a DurableTable row or a
workflow signal. It only composes the router that contains the route.

## Relationship To Workflow Signaling

Channels do not bypass workflows. They hide the signaling mechanics behind a
route implementation.

A callable or egress route may lower to:

- a durable request row observed by a kernel worker;
- a workflow signal/mailbox entry;
- a runtime-owned durable stream wait primitive, such as the future
  `streamWaitAny` path named by the workflow-body plan;
- a direct in-process runtime service in single-host tests.

Those are implementation choices below the router. The route contract above the
router remains stable.

This is the missing seam for future work such as `HostKernelWorkflow` owning
context workflows. The router does not decide whether a prompt writes a request
row or signals a long-running workflow. It gives all host edges the same
contract while the runtime/kernel chooses the backing mechanism.

## Migration Plan

1. Add pure router descriptor types and helpers.
2. Add the runtime dispatch interpreter that derives `router.dispatch` from the
   typed route declaration.
3. Move table-bound host-control channel Live Layers from `@firegrid/host-sdk`
   into `@firegrid/runtime` or the runtime/kernel channel area.
4. Replace `HostControlChannelsLive` with a host channel router declaration.
5. Update ACP/MCP/CLI edges to consume router metadata and `router.dispatch`.
6. Delete broad `ChannelInventory` consumers. Edges consume `router.dispatch`;
   the broad app-visible inventory API is not carried forward.
7. Update docs/examples so new host surfaces are expressed as
   `router + edge adapters + kernel`, not `registry + ad hoc Layers`.

The post-move dependency direction is:

```text
host-sdk -> runtime -> protocol
```

`host-sdk` should lose direct DurableTable/control-plane imports for route
bodies. If a current host-control route constructs table clients inline, split
that into a runtime route Live Layer before moving the host topology to the
router declaration.

## Acceptance Criteria

- A reviewer can find one router manifest and know which channel targets a host
  exposes.
- Every route points at a protocol-owned contract.
- Every route implementation lives at or below the runtime/kernel boundary
  unless it is explicitly app-owned.
- Edge adapters use the router instead of hand-wiring channel lookup.
- Decode failures from edge payloads are represented as `ParseError`.
- Router dispatch emits consistent target/direction/verb spans.
- `@firegrid/host-sdk` composes routers and edges; it does not own durable
  state wiring as stable architecture.
- Typed client methods and agent verbs are projections over router-backed
  channels, not parallel operation catalogs.

## Resolved Placement Calls

1. Pure router helper types live in `@firegrid/protocol/channels/router`.
   Reason: the route descriptor type, direction-to-verb matrix, and
   `ChannelRouter<Routes>` shape are covariant with channel contracts. Splitting
   them into another package would force lockstep versioning with protocol.
2. Runtime owns the dispatch interpreter. Reason: dispatch performs schema
   decoding, route invocation, span creation, and Layer-backed execution.
3. Route implementations are descriptors, not raw Layers. Reason: descriptors
   let the router derive both route metadata and `Layer.mergeAll(...)`
   composition from the same declaration.

## Open Questions

1. Should host-specific app channels be registered by extending the same router
   or by merging routers? Default: router merging, so app packages can publish
   their own channel bundles.
2. How much metadata should be required for REST/gRPC generation? Default:
   target, direction, schemas, and optional description first; avoid committing
   to transport-specific metadata until the first edge needs it.
