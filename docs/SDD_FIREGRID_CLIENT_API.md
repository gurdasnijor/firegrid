# SDD: Firegrid Client API

Status: Draft
Product: Firegrid
Related:
- `firegrid-client-api`
- `firegrid-event-streams`
- `client-event-plane-registration`
- `firegrid-operation-messaging`
- `firegrid-runtime-process`
- `launchable-substrate-host`

## Summary

`@firegrid/client` is the app-facing SDK for browser and application code. Its
role is intentionally narrower than the runtime and substrate packages:

```txt
client code
  -> sends typed operation messages
  -> observes operation handles and curated durable state
  -> emits and observes caller-owned EventStream events

runtime code
  -> installs handlers, subscribers, EventPlane producers/projections, RunWait

substrate
  -> owns durable rows, folds, claims, completions, ready work, terminal state
```

The client package should be shippable as a production application dependency,
including browser bundles. It must not become a convenience wrapper around
kernel authority or runtime process management.

## Public Role

The client may expose:

- typed operation message send APIs;
- request-response helpers built from send plus handle/result observation;
- handle attachment and operation-state observation;
- typed EventStream emit APIs;
- typed EventStream observation APIs returning `Stream`;
- Effect-native error channels for expected encode, append, read, decode,
  not-found, cancellation, and result failures.

This corresponds to:

- `firegrid-client-api.CLIENT_SURFACE.1`
- `firegrid-client-api.CLIENT_SURFACE.2`
- `firegrid-client-api.CLIENT_SURFACE.4`
- `firegrid-client-api.CLIENT_SURFACE.5`

Operation and EventStream descriptors are shared contract values. They contain
stable names and Effect Schema contracts, not runtime handlers or registration
side effects:

```ts
const ApproveTool = Operation.define({
  name: "ApproveTool",
  input: ApproveToolInput,
  output: ApproveToolOutput,
})

const UiEvents = EventStream.define({
  name: "ui.events",
  event: UiEvent,
})
```

This keeps descriptor imports safe for browser code and runtime code:

- `firegrid-client-api.CLIENT_SURFACE.3`
- `firegrid-event-streams.EVENT_STREAM_DEFINITION.2`
- `firegrid-event-streams.EVENT_STREAM_DEFINITION.3`

## Connection Configuration

Client construction receives stream connection configuration from application
or lab environment:

```ts
const ClientLive = FiregridClientLive({
  streamUrl,
  contentType: "application/json",
})
```

Browser-facing client modules do not read `process.env` directly. Build tools,
framework loaders, tests, or app shell code translate environment into explicit
configuration objects.

Client configuration is transport configuration only. It does not include:

- runtime process id;
- claim owner id;
- handler graph;
- subscriber graph;
- RunWait configuration;
- Durable Streams dev-server launch commands.

Anchor requirements:

- `firegrid-client-api.STREAM_CONFIGURATION.1`
- `firegrid-client-api.STREAM_CONFIGURATION.2`
- `firegrid-client-api.STREAM_CONFIGURATION.3`

## EventStream Responsibilities

Use EventStream from client code for lightweight caller-owned events that do not
need a caller-owned materialized state schema:

```ts
yield* client.emit(UiEvents, {
  type: "permission.button.clicked",
  permissionId,
})

yield* client.events(UiEvents).pipe(Stream.runForEach(renderEvent))
```

The client validates events through the descriptor schema and appends Firegrid
EventStream rows. It does not expose raw Durable Streams append calls as the
normal app API.

EventStream rows are caller-owned domain events. They may be consumed by
runtime materializers or inspected by app/lab views, but they do not become
Firegrid-native row families.

Anchor requirements:

- `firegrid-client-api.EVENT_INTEROP.1`
- `firegrid-client-api.EVENT_INTEROP.3`
- `firegrid-client-api.EVENT_INTEROP.5`
- `firegrid-event-streams.CLIENT_API.1`
- `firegrid-event-streams.CLIENT_API.2`
- `firegrid-event-streams.CLIENT_API.3`
- `firegrid-event-streams.CLIENT_API.5`
- `firegrid-event-streams.SCHEMA_OWNERSHIP.1`

## EventPlane Responsibilities

EventPlane is the stateful row-family surface. It is appropriate when higher
layers need:

- primary-keyed domain rows;
- materialized projection state;
- projection queries;
- projection-match evaluation;
- runtime-side producer sequencing before or after `RunWait`.

EventPlane is not the browser client surface. Firepixel-style prompt chunks,
permission requests, tool invocations, runtime observations, and provider
state are written inside app-owned runtime Layers through
`@firegrid/substrate/event-plane`, not through `@firegrid/client`.

```txt
runtime handler or adapter
  -> EventPlane producer
  -> caller-owned state row
  -> EventPlane projection
  -> optional projection-match wait resolution
```

This preserves the authority split:

- browser/app clients may emit EventStream events;
- runtime handlers and adapters may emit EventPlane domain rows;
- substrate owns completions, claims, ready work, and terminal run state.

Anchor requirements:

- `firegrid-client-api.EVENT_INTEROP.2`
- `firegrid-client-api.EVENT_INTEROP.4`
- `client-event-plane-registration.EVENT_PLANE_DEFINITION.5`
- `client-event-plane-registration.PRODUCER_API.5`
- `client-event-plane-registration.PRODUCER_API.6`
- `client-event-plane-registration.PROJECTION_API.5`
- `client-event-plane-registration.PROJECTION_API.7`

## Authority Boundaries

`@firegrid/client` must not expose or encourage:

- `@firegrid/substrate/kernel` imports as app-facing client APIs;
- substrate durable row builders;
- `WorkProducer`;
- claim APIs;
- terminalization APIs;
- completion resolution APIs;
- `RunWait`;
- `Choreography` or `DurableWaitsLive`;
- runtime handler registration;
- subscriber/operator loops;
- Firegrid runtime process startup;
- Durable Streams dev-server launchers.

Clients append intent and observe durable outcomes. They do not execute
handlers, claim work, resolve completions, or author terminal state:

```txt
client send
  -> durable operation intent
  -> runtime handler claims and executes
  -> substrate validates completion/terminal authority
  -> client observes handle/result
```

Anchor requirements:

- `firegrid-client-api.AUTHORITY_BOUNDARY.1`
- `firegrid-client-api.AUTHORITY_BOUNDARY.2`
- `firegrid-client-api.AUTHORITY_BOUNDARY.3`
- `firegrid-client-api.AUTHORITY_BOUNDARY.4`
- `firegrid-client-api.AUTHORITY_BOUNDARY.5`

## Lab Compatibility

The lab is a consumer of public Firegrid surfaces, not a special control
plane. For typed app-like workflows, lab code should use `@firegrid/client`
production APIs for:

- operation sends/calls;
- handle/result observation;
- EventStream emission;
- EventStream observation.

The lab may keep raw Durable Streams diagnostic panels when they are visually
and structurally separated from scenario controls. Those panels are inspection
tools, not client write APIs and not examples for app code.

Lab UI components route typed controls through an app-local client seam. That
seam may adapt to the current production client subpaths while C2 lands, but
runtime, substrate, kernel, raw writer, work, claim, and terminal authority do
not leak into React components.

Anchor requirements:

- `firegrid-client-api.LAB_COMPATIBILITY.1`
- `firegrid-client-api.LAB_COMPATIBILITY.2`
- `firegrid-client-api.LAB_COMPATIBILITY.3`
- `firegrid-client-api.LAB_COMPATIBILITY.4`
- `launchable-substrate-host.LAB_INSPECTOR.7`
- `launchable-substrate-host.NO_CONTROL_PLANE.4`
- `launchable-substrate-host.NO_CONTROL_PLANE.5`

## Package Surface Direction

The target package split is:

```txt
@firegrid/client
  app-facing operation, handle, and EventStream APIs

@firegrid/client/event-streams
  browser-safe EventStream-only subpath

@firegrid/runtime
  run(...), Firegrid.handler(...), runtime subscribers/materializers

@firegrid/substrate
  public descriptors and runtime composition primitives such as RunWait

@firegrid/substrate/event-plane
  app-owned runtime EventPlane producer/projection services

@firegrid/substrate/kernel
  low-level durable authority internals for runtime/substrate internals,
  tests, and diagnostics
```

Future client implementation work should make root exports match this SDD
rather than preserving transitional kernel-shaped conveniences. When the lab
needs a capability that is missing from `@firegrid/client`, that should become
a production client API or a read-only diagnostic path, not a lab-only writer
surface.

## Client Package Runbook

The package-level client runbook lives at `packages/client/README.md`. It is
the concise smoke path for app code that wants to:

- construct `FiregridClientLive` from an explicit stream URL;
- define browser-safe `Operation` and `EventStream` descriptors;
- call `send`, `result`, `call`, and `observe`;
- call `emit` and `events`;
- verify the package with focused client tests.

The runbook intentionally does not include runtime handler registration,
RunWait, claim or terminal APIs, raw Durable Streams writes, lab-only paths, or
Durable Streams dev-server launchers. It points readers back to this SDD for
the authority boundary and to runtime/scenario documentation for handler-side
execution.

Anchor requirements:

- `firegrid-client-api.CLIENT_SURFACE.1`
- `firegrid-client-api.CLIENT_SURFACE.2`
- `firegrid-client-api.CLIENT_SURFACE.4`
- `firegrid-client-api.EVENT_INTEROP.1`
- `firegrid-client-api.EVENT_INTEROP.3`
- `firegrid-client-api.AUTHORITY_BOUNDARY.1`
- `firegrid-client-api.AUTHORITY_BOUNDARY.2`
- `firegrid-client-api.AUTHORITY_BOUNDARY.3`
- `firegrid-client-api.AUTHORITY_BOUNDARY.4`
- `firegrid-client-api.AUTHORITY_BOUNDARY.5`
- `firegrid-client-api.DOCUMENTATION.1`
- `firegrid-client-api.DOCUMENTATION.2`

## Non-Goals

- No runtime graph loading through the client.
- No runtime handler registration in the client.
- No `RunWait` or Choreography client API.
- No client-side claim or terminal authority.
- No Firegrid-owned dev-server launcher.
- No raw Durable Streams writer as the normal client API.
- No Firepixel/Fireline product row families in the client package.

Anchor requirements:

- `firegrid-client-api.DOCUMENTATION.1`
- `firegrid-client-api.DOCUMENTATION.2`
