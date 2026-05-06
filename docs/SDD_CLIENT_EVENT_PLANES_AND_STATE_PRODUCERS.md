# SDD: Client Event Planes And State Producers

Status: proposal-era background; current API decisions are superseded by
`features/firegrid/client-event-plane-registration.feature.yaml`,
`docs/SDD_FIREGRID_FIREPIXEL_FOUNDATION.md`, and
`docs/REVIEW_FIREGRID_FOUNDATION_READINESS_2026-05-06.md`.
Created: 2026-05-04
Owner: Durable Agent Substrate

## Superseded Decision Note

The open questions at the end of this proposal have current-wave answers on
`main`:

- EventPlane is exposed through `@firegrid/substrate/event-plane` for app-owned
  runtime entrypoints (`client-event-plane-registration.EVENT_PLANE_DEFINITION.5`,
  `client-event-plane-registration.BOUNDARY.6`).
- `EventPlane.define({ name, state })` owns caller-defined Durable Streams
  State collections and Effect Schema validation for the plane
  (`client-event-plane-registration.EVENT_PLANE_DEFINITION.1-.3`).
- `EventPlane.layer(plane, { streamUrl })` is the current v1 physical binding;
  multiple streams can be considered later without blocking the foundation.
- `PlaneProducer.emit(...)` preserves caller-supplied idempotency,
  correlation, and causation metadata and is a durable sequencing boundary
  before `RunWait` suspension (`client-event-plane-registration.PRODUCER_API.2`,
  `client-event-plane-registration.PRODUCER_API.6`).
- Projection helpers are currently explicit app/scenario code over typed
  `PlaneProjection` services. Generated helpers remain future ergonomics, not
  foundation readiness work (`client-event-plane-registration.PROJECTION_API.1`,
  `client-event-plane-registration.PROJECTION_API.6`).
- EventPlane row changes can wake runtime projection-match evaluation
  (`client-event-plane-registration.PROJECTION_API.7`,
  `firegrid-runtime-process.RUNTIME_HOT_PATH.4`).

Keep this document as design background, not as the source of truth for new
client API or Firepixel foundation tasks.

## Problem

Fireline/Firepixel-style runtimes need to persist and observe domain-specific
event streams:

- ACP session updates and permission requests;
- Claude Code or Codex adapter observations;
- Fireline prompt, permission, launch, chunk, and terminal rows;
- Firepixel tool invocation requests/results;
- provider, resource, sandbox, and runtime lifecycle observations.

The substrate already proves durable completions, state rebuild, ready work,
claims, subscribers, and first-valid authority. It does not yet provide a clean
way for higher layers to define their own durable event planes and projection
models that participate in the same observation machinery.

Without this layer, higher runtimes either:

- reach into raw Durable Streams or StreamDB APIs everywhere;
- turn ACP/tool/session concepts into substrate-native rows;
- duplicate projection/reducer scaffolding in every adapter;
- confuse observational state with substrate ownership authority.

## Design Goal

Expose a small schema-first event-plane definition pattern:

```ts
const AcpPlane = EventPlane.define({
  name: "firepixel.acp",
  events: AcpEvent,
  state: acpState,
  reducers: acpReducers,
})
```

Then provide typed producers and projection queries from that plane:

```ts
const AcpLive = EventPlane.layer(AcpPlane, { streamUrl })

const program = Effect.gen(function* () {
  const acp = yield* AcpPlane

  yield* acp.producer.emit(AcpEvents.permissionRequested({
    sessionId,
    toolCallId,
    permissionKey,
  }))

  const row = yield* Projection.until(
    acp.projections.permissions.byKey(permissionKey),
    (permission) => permission.state !== "pending",
  )

  return row
}).pipe(Effect.provide(AcpLive))
```

The exact names can change. The important boundary is:

```text
higher layer defines events and projections
substrate validates, persists, rebuilds, streams, and waits over them
substrate does not make ACP/session/tool/prompt native concepts
```

## Core Concepts

### Event Plane

An event plane is a typed module value. It contains:

- a stable plane name;
- Effect Schema definitions for accepted events;
- Durable Streams State collection definitions for projection rows;
- reducer/materializer rules;
- typed producer helpers;
- typed projection query helpers.

It is not a global registry. A runtime can import and provide the plane it
needs through an Effect Layer.

### Producer

A producer emits domain events through the event plane. It should:

- validate event payloads with Effect Schema;
- preserve idempotency, causation, and correlation metadata;
- hide raw append/envelope mechanics from normal callers;
- expose typed Effect errors for validation or stream failures.

### Projection Query

A projection query is the bridge into the substrate Projection facade. It
contains enough information for:

- snapshot;
- stream;
- until;
- no-gap snapshot/follow semantics;
- typed row validation.

Projection rows remain domain state. They are not automatically substrate
completion rows or claim authority.

## ACP Permission Example

ACP permission flow should look like explicit adapter code:

```text
ACP wire event
  -> Firepixel ACP event plane producer emits acp.permission.requested
  -> Firepixel ACP projection materializes permission/tool-call observation
  -> Firepixel policy maps observation into domain permission state
  -> UI/policy resolves domain permission
  -> adapter responds to ACP request from domain decision
```

The substrate should support the event/projection mechanics, but should not
interpret ACP permission semantics itself.

## Authority Rules

Observation is not authority.

A materialized ACP tool-call row can say "a permission was requested." It does
not by itself:

- resolve a durable completion;
- claim work ownership;
- authorize tool execution;
- terminally complete a run.

Those transitions must go through the existing substrate primitives:

- Projection until for observation waits;
- Awaitable only for explicit durable-promise waits;
- Work pipeline for claim-before-side-effect execution;
- domain policy for permission decisions.

## First Implementation Slice

The first slice should prove a fake non-Fireline event plane:

```text
example.adapter.event
  -> example.adapter.state row
  -> typed producer emit
  -> Projection.snapshot / stream / until consume projection query
```

It should not implement ACP. ACP comes later as a profile that uses the same
mechanism.

## Open Questions

1. Should event plane definitions own their Durable Streams State schema, or
   compose an externally supplied state schema?
2. Should producer metadata be a fixed envelope or a typed metadata extension?
3. Should projection query helpers be generated from collection definitions or
   handwritten by the plane author?
4. Should event planes support multiple physical streams, or should v1 assume a
   single stream URL per plane layer?
