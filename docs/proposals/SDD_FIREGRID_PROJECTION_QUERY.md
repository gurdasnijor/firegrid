# SDD: Firegrid Projection Query

Date: 2026-05-06

Status: Proposal, companion design note

Spec source of truth:
`features/firegrid/firegrid-projection-query.feature.yaml`

Related merge: Firegrid PR #107, merge commit
`63ce70f2f6e3751cd30bd88dc5b5466c1679d840`

## Purpose

Firegrid already has durable operations, EventStreams, EventPlane descriptors,
projection-match waits, and runtime subscribers. What is missing is a clean
application-facing read surface for projected durable state.

Without that surface, downstream products repeat the same work:

- fetch an initial state snapshot;
- hold an opaque cursor or sequence boundary;
- reconnect after transport loss;
- replay retained events;
- switch from replay to live tail without gaps;
- decode product-owned rows;
- distinguish retention gaps from decode errors, missing streams, timeouts, and
  transport failures;
- avoid leaking raw Durable Streams or kernel authority into browser code.

`firegrid-projection-query` defines the product-neutral read/query contract for
that missing layer.

This SDD explains the design intent behind the Acai spec. The feature file is
the authoritative acceptance criteria.

Current pattern docs:

- [Browser EventPlane projection reads](../patterns/browser-eventplane-projection.md)
  documents the approved `@firegrid/substrate/event-plane` read path available
  before the projection-query facade exists.
- [EventStream folded as list](../patterns/eventstream-folded-as-list.md)
  documents when `EventStream` plus `client.events(...)` is enough and when
  product code should use EventPlane-backed current state.

## Problem Statement

Product UIs and runtime adapters need to observe durable state, not just
operation terminal results. Flamecast is the immediate forcing function:

- session timelines need replay plus live updates;
- sidebars need active session/agent indexes;
- provider callback waits need deterministic request visibility before an
  external decision/result row is written;
- runtime presence needs queryable freshness/readiness;
- resource materialization needs status views;
- prompt/intent transport needs client-observable state.

The same need exists outside Flamecast. Firepixel, Fireline-style systems, and
future app runtimes need a public way to read app-owned projections without
importing substrate internals or reimplementing cursor and replay behavior.

## Design Principle

Projection query is a **read facade**, not a new source of truth.

```txt
EventPlane/EventStream descriptors define what state exists.
Durable Streams and Firegrid projection mechanics define how state is retained.
Projection query defines how applications safely read that state.
```

This feature must not grant write, claim, completion, terminal, or runtime
authority.

## Ownership Boundary

Firegrid owns:

- query handle shape;
- snapshot/preload behavior;
- opaque cursor values;
- replay-then-live-tail behavior;
- no-gap follow from a snapshot cursor;
- typed expected read errors;
- browser-safe package boundaries;
- public read API authority limits.

Products own:

- row payload schemas;
- projection family names;
- compatibility policy;
- authorization policy;
- provider/session/tool/model semantics;
- which projections are useful to expose to their UIs and runtimes.

Existing Firegrid specs continue to own adjacent behavior:

- `client-event-plane-registration` owns EventPlane declaration, producer, and
  projection definition semantics.
- `durable-records-and-projections` owns durable records, projection rebuild,
  and source-of-truth invariants.
- `firegrid-event-streams` owns EventStream definition and append/read
  semantics.
- `firegrid-client-api` owns the broader browser/client authority boundary.

## Proposed Public Shape

The Acai spec intentionally names behavior rather than concrete TypeScript API
types. A future implementation should converge on a small descriptor-scoped
handle shape:

```ts
interface ProjectionQueryHandle<Snapshot, Change, Event> {
  snapshot(
    options?: ProjectionSnapshotOptions,
  ): Effect.Effect<SnapshotResult<Snapshot>, ProjectionQueryError>
  stream(cursor: ProjectionCursor): Stream.Stream<Change, ProjectionQueryError>
  until<A>(
    predicate: ProjectionPredicate<Snapshot | Change, Option.Option<A>>,
    options: UntilOptions,
  ): Effect.Effect<A, ProjectionQueryError>
  events(cursor: ProjectionCursor): Stream.Stream<Event, ProjectionQueryError>
}
```

The important parts are:

- the handle is constructed from public descriptors and explicit stream
  connection configuration;
- descriptors are backed by Effect Schema so `Snapshot`, `Change`, and `Event`
  are decoded at the boundary rather than trusted as raw payloads;
- the cursor is opaque and typed;
- `snapshot` returns both decoded state and a durable follow boundary;
- `stream` starts after that boundary without requiring a second snapshot;
- `until` checks the snapshot before subscribing live;
- `events` uses the same replay/live-tail posture for EventStream entries.

Exact package placement is intentionally not decided by the spec. The
implementation may use existing curated roots or an approved new subpath, but
browser code must never need `@firegrid/substrate/kernel`, raw StreamDB
collections, or runtime packages.

## Construction Boundary

The public examples use `ProjectionQuery.for(...)` for readability, but the
implementation should prefer an Effect service/Layers boundary.

Reasoning:

- browser, server, and runtime contexts should share the same capability
  interface while using different transport/auth/config Layers;
- tests should be able to provide a deterministic query client without opening
  a real stream;
- stream subscriptions are scoped resources and should be acquired/released
  through Effect `Scope` semantics;
- handles should be fully configured once returned, so ordinary callers do not
  carry a residual transport requirement in the `R` channel. In other words,
  the service Layer requires transport/config/auth; the returned handle should
  usually be `R = never`.

Illustrative service shape:

```ts
export interface ProjectionQueryClient {
  readonly for: <Snapshot, Change, Event>(
    descriptor: ProjectionDescriptor<Snapshot, Change, Event>,
  ) => ProjectionQueryHandle<Snapshot, Change, Event>
}

export class ProjectionQueryClientLive
  extends Effect.Service<ProjectionQueryClientLive>()(
    "@firegrid/client/ProjectionQueryClient",
    {
      effect: Effect.gen(function*() {
        const config = yield* ProjectionQueryConfig
        const reader = yield* EventStreamReader

        return {
          for: (descriptor) =>
            makeProjectionQueryHandle(descriptor, {
              config,
              reader,
            }),
        } satisfies ProjectionQueryClient
      }),
    },
  ) {}
```

If the repo's pinned Effect version or local conventions prefer
`Context.Tag` plus `Layer.effect`, use that equivalent shape. The design point
is service construction, not global factories. Browser/server/runtime variants
should differ by Layer, not by changing application call sites.

## User Contexts and Use Cases

Projection query has different jobs depending on where it is used. The public
API should make those differences explicit instead of forcing every caller to
learn low-level stream mechanics.

### Browser and Worker UI Code

Browser and edge-safe callers need read-only, descriptor-scoped state. They
should not import runtime packages, kernel modules, raw Durable Streams writer
handles, or StreamDB collections.

Use cases:

- render a session timeline with replay then live tail;
- render active sessions, agents, runtime presence, or resource status;
- reconnect after a tab sleeps or a Worker request is retried;
- wait until a provider callback request row is visible before allowing a user
  or external system to post the result;
- distinguish "still catching up" from "retention gap" and "decode failure".

Illustrative shape:

```ts
import { Effect, Stream } from "effect"
import { ProjectionQueryClientLive } from "@firegrid/client"

const client = yield* ProjectionQueryClientLive
const query = client.for(ApplicationPlane.projections.sessionTimeline)

const initial = yield* query.snapshot({
  scope: { sessionId },
})

yield* query.stream(initial.cursor).pipe(Stream.runForEach(renderChange))
```

The browser gets decoded product rows and opaque cursors. It does not get raw
state envelopes, writer APIs, claim APIs, or terminalization authority.

### Server and API Route Code

Server-side application code can use the same read facade to serve HTTP API
responses, run preflight checks, or build materialized read models without
becoming a Firegrid runtime operator.

Use cases:

- return `GET /sessions/:id/events` from a decoded durable stream;
- serve paginated or cursor-backed transcript reads;
- answer "is this request row visible yet?" before redirecting to an external
  callback flow;
- rebuild a product-owned read model after deploy or cache loss;
- perform admin/debug reads with product authorization applied outside
  Firegrid.

Illustrative shape:

```ts
const client = yield* ProjectionQueryClientLive
const timeline = client.for(ApplicationPlane.projections.timeline)

export const getSessionEvents = (sessionId: string) =>
  timeline.snapshot({ scope: { sessionId } }).pipe(
    Effect.map(({ value, cursor }) => ({
      events: value.events,
      cursor,
    })),
  )
```

Server code may have stronger product authorization than browser code, but the
Firegrid handle remains read-only.

### Runtime Handler and Subscriber Code

Runtime code already has access to `@firegrid/runtime` and substrate-side
composition. It may use projection query as a convenience read facade, but it
must not use it as a substitute for RunWait authoring or completion authority.

Use cases:

- read app-owned state before deciding whether to emit a new row;
- perform snapshot-first `until` logic in a helper shared with tests;
- inspect durable presence or resource materialization before app-owned side
  effects;
- expose product-runtime diagnostics without importing raw StreamDB in app
  code.

Illustrative shape:

```ts
const client = yield* ProjectionQueryClientLive
const providerResults = client.for(ApplicationPlane.projections.providerResults)

const result = yield* providerResults.until(
  (state) => Option.fromNullable(state.byRequestId.get(requestId)),
  { label: "provider-result-visible", timeout: "30 seconds" },
)
```

If a handler must suspend durably, the canonical primitive is still
`RunWait.for` plus `Firegrid.subscribers.projectionMatch`. Projection query
`until` is the read-side ergonomics for visibility gates and tests, not a new
completion path.

## Relationship To StreamDB

Durable Streams `StreamDB` is useful prior art and may be an internal building
block, but it is not the Firegrid public client query contract.

At the referenced revision, `StreamDB` is a TanStack DB-oriented materializer:
callers define typed collections with schemas, event types, and primary keys;
`createStreamDB` creates collection instances; `preload()` consumes the stream
until up-to-date; helpers create insert/update/delete/upsert change events; and
utilities such as `awaitTxId` let callers wait for a transaction to sync.

That is a good fit for local reactive state, but raw `StreamDB` is too broad as
the Firegrid application API:

| Concern | Raw StreamDB posture | Firegrid projection query posture |
| --- | --- | --- |
| Primary abstraction | Collections and change events | Firegrid descriptors and projections |
| Framework bias | TanStack DB collections | Effect-native first; framework adapters later |
| Authority | Includes event helper shapes near collection state | Read-only handles in browser/app code |
| Cursor contract | Stream/materializer implementation detail | Opaque Firegrid cursor with typed errors |
| Error model | General stream/materialization failures | Descriptor-scoped expected Effect errors |
| Runtime boundary | General durable stream client | Firegrid package boundary rules enforced |
| Product semantics | Caller-defined collections | Caller-defined schemas, but no product families in Firegrid |

Firegrid can use StreamDB-like mechanics internally for materialization, and
products may build TanStack/React adapters on top of Firegrid later. The first
Firegrid surface should stay smaller:

```ts
// Firegrid public shape: descriptor-scoped read facade.
const client = yield* ProjectionQueryClientLive
const query = client.for(SessionTimelineProjection)
const { value, cursor } = yield* query.snapshot({ scope: { sessionId } })

// Product adapter shape: optional downstream wrapper.
const db = flamecastSessionDbFromFiregrid(query, { sessionId })
await db.preload()
```

The product adapter can expose collections, optimistic actions, hooks, or
TanStack DB integration. Firegrid should expose the durable read boundary and
typed replay/live semantics underneath that adapter.

## Cursor Model

The cursor is not a product sequence number and not a public Durable Streams
offset string. It is an opaque Firegrid value that represents a descriptor and
topology-specific read boundary.

Required behavior:

- a snapshot cursor is sufficient for no-gap follow;
- replay preserves accepted stream order;
- replay/live transition does not duplicate or drop entries;
- up-to-date state is not an error;
- retention gaps are typed expected errors;
- malformed cursor, missing stream, closed stream, timeout, and decode failure
  are distinct expected errors.

Future implementation can wrap Durable Streams protocol offsets internally, but
that transport detail must not become the public application contract.

Implementation should make opacity concrete with Effect primitives:

- use a branded cursor token so arbitrary strings are not accepted as cursors at
  the type level;
- use Effect Schema for cursor encode/decode at transport boundaries;
- surface schema parse failures as `MalformedCursor`, not as thrown defects.

Illustrative shape:

```ts
import { Brand, Schema } from "effect"

export type ProjectionCursorToken =
  string & Brand.Brand<"ProjectionCursorToken">

export const ProjectionCursor = Schema.Struct({
  _tag: Schema.Literal("ProjectionCursor"),
  token: Schema.String.pipe(
    Schema.fromBrand(Brand.nominal<ProjectionCursorToken>()),
  ),
})

export type ProjectionCursor = Schema.Schema.Type<typeof ProjectionCursor>
```

Final syntax should be checked against the repo's pinned Effect version. The
contract is stable: cursors are branded, schema-decoded, and only meaningful to
Firegrid query APIs.

## Error Model

Projection query errors should be expected Effect errors, not defects, when the
reader can reasonably recover or display a product UI state.

Expected errors include:

- decode failure;
- malformed cursor;
- retention gap;
- missing stream;
- closed stream;
- transport read failure;
- timeout.

Decode errors should identify the descriptor, row family or event type, key
when available, and cursor boundary when available. They should not expose raw
Durable Streams State envelopes as the public payload.

Domain errors are not projection query errors. Provider unavailable, capability
unsupported, permission denied, prompt unsupported, sandbox unavailable, and
similar product states belong in product-owned rows or operation error schemas.

Implementation should prefer `Data.TaggedError` classes for expected errors.
That keeps errors compatible with `Effect.catchTag` / `Effect.catchTags`, makes
variants yieldable from `Effect.gen`, and prevents accidental structural
unification between unrelated error shapes.

Illustrative shape:

```ts
import { Data } from "effect"

export class DecodeError extends Data.TaggedError("DecodeError")<{
  readonly descriptor: string
  readonly key?: string
  readonly cursor?: ProjectionCursor
  readonly parseIssue?: unknown
}> {}

export class MalformedCursor extends Data.TaggedError("MalformedCursor")<{
  readonly reason: string
}> {}

export class RetentionGap extends Data.TaggedError("RetentionGap")<{
  readonly cursor: ProjectionCursor
}> {}

export class MissingStream extends Data.TaggedError("MissingStream")<{
  readonly descriptor: string
}> {}

export class ClosedStream extends Data.TaggedError("ClosedStream")<{
  readonly descriptor: string
}> {}

export class TransportReadFailure extends Data.TaggedError(
  "TransportReadFailure",
)<{
  readonly cause: unknown
}> {}

export class UntilTimeout extends Data.TaggedError("UntilTimeout")<{
  readonly label: string
}> {}

export type ProjectionQueryError =
  | DecodeError
  | MalformedCursor
  | RetentionGap
  | MissingStream
  | ClosedStream
  | TransportReadFailure
  | UntilTimeout
```

Descriptors should be backed by Effect Schema. Decode failures should preserve
parse issue detail inside `DecodeError` while still avoiding raw durable
envelopes in the public error payload.

## Authority Model

Projection query handles are read-only.

They must not expose:

- append/update/delete APIs;
- terminal run authority;
- claim authority;
- completion resolution authority;
- pending-completion creation;
- subscriber registration;
- runtime handler registration;
- RunWait authoring;
- raw StreamDB collections;
- raw Durable Streams State envelopes;
- kernel imports;
- Durable Streams writer handles.

This is the main safety value of the feature. It gives browser and app code
durable state visibility without making that code a substrate operator.

## Stream Semantics

The query surface should name the stream lifecycle explicitly.

Replay-then-live is a scoped stream composition:

```txt
1. validate cursor
2. acquire live follow boundary or subscription under Scope
3. replay retained entries after the cursor boundary
4. switch to live entries without drop or duplicate
5. release transport resources when the stream is interrupted or ends
```

Implementation details may vary, but the public contract should be clear:

- live subscription setup must not leave a race window after replay;
- stream consumers manage interruption through Effect fiber/scope lifecycle;
- slow consumers must have an explicit buffering policy;
- retention gaps are typed errors, not silent truncation;
- clean stream end before an `until` predicate matches is a `ClosedStream` or
  transport error, not a synthetic product state.

For browser adapters, a React or framework hook can own fiber interruption and
backpressure policy later. The Effect-native core should expose interruptible
streams and document the buffering default first.

## Implementation Sketch

A likely implementation path:

### 1. Public Types

Define small public types first. Avoid leaking raw Durable Streams envelopes or
StreamDB collection instances.

```ts
export interface SnapshotResult<A> {
  readonly value: A
  readonly cursor: ProjectionCursor
}
```

Cursor and error types should follow the branded Schema and `Data.TaggedError`
shapes above.

### 2. Service-Scoped Factory

Expose construction through a browser-safe service. The exact class/tag name can
change, but the service should require a public descriptor and configured
transport Layer.

```ts
const query = yield* ProjectionQueryClient.use((client) =>
  Effect.succeed(client.for(ApplicationPlane.projections.timeline)),
)
```

The service should not accept raw collection names, stream URLs without
descriptor context, kernel handles, or raw StreamDB collections.

### 3. Snapshot Then Follow

Implement `snapshot()` as a preload/materialization read that returns decoded
state and the durable boundary needed to follow without gaps.

```ts
const snapshot = <A>(
  descriptor: ProjectionDescriptor<A, unknown, unknown>,
): Effect.Effect<SnapshotResult<A>, ProjectionQueryError> =>
  readProjectionSnapshot(descriptor).pipe(
    Effect.map(({ decoded, boundary }) => ({
      value: decoded,
      cursor: encodeProjectionCursor(descriptor, boundary),
    })),
  )
```

`stream(cursor)` should validate the cursor, replay retained changes after the
cursor boundary, then switch to live tail. The replay/live switch must be one
shared primitive used by browser, server, and runtime call sites.

### 4. Snapshot-First `until`

`until` should check existing decoded state before subscribing. This avoids the
common bug where a row is already present but a live-only wait misses it.

```ts
const until = <Snapshot, Change, A>(
  handle: ProjectionQueryHandle<Snapshot, Change, unknown>,
  predicate: (stateOrChange: Snapshot | Change) => Option.Option<A>,
  options: UntilOptions,
): Effect.Effect<A, ProjectionQueryError> =>
  Effect.gen(function*() {
    const first = yield* handle.snapshot()
    const fromSnapshot = predicate(first.value)
    if (Option.isSome(fromSnapshot)) {
      return fromSnapshot.value
    }

    return yield* handle.stream(first.cursor).pipe(
      Stream.filterMap(predicate),
      Stream.runHead,
      Effect.flatMap(Option.match({
        onNone: () =>
          Effect.fail(new ClosedStream({ descriptor: "projection-query" })),
        onSome: Effect.succeed,
      })),
      Effect.timeoutFail({
        duration: options.timeout,
        onTimeout: () => new UntilTimeout({ label: options.label }),
      }),
    )
  })
```

Final code should use existing repo conventions for `Stream`, `Option`, and
timeout helpers. The key contract is snapshot-first, then replay/live follow.
The predicate returns `Option` so absence is explicit and `Stream.filterMap`
can fuse map/filter behavior.

The implementation must decide whether the replay boundary guarantees no
duplicate logical observation between snapshot and live changes. If duplicates
can occur, predicates and consumers must be documented as idempotent over the
same logical row.

### 5. Shared EventStream Reader

`events(cursor)` should share the same decoding and replay/live-tail machinery
as existing `client.events(EventStream)` where possible. Divergent event readers
would create two subtly different public notions of durable replay.

The preferred implementation shape is an internal `EventStreamReader` service
used by both public APIs. That keeps the `R` channel, error channel, cursor
handling, and replay/live behavior aligned.

### 6. Package and Boundary Tests

Add tests proving:

- browser-safe imports do not pull `@firegrid/runtime`,
  `@firegrid/substrate/kernel`, lab paths, or raw writer authority;
- query handles do not expose append/update/delete/claim/complete/fail/cancel
  functions;
- `snapshot` plus `stream(cursor)` has no gap or duplicate at the boundary;
- malformed cursor, retention gap, decode failure, missing stream, closed
  stream, timeout, and transport failure are distinct typed expected errors;
- `until` observes already-present rows before subscribing live.

The implementation should avoid duplicating lower-level projection and
EventStream readers. If `events` and existing `client.events(EventStream)`
diverge, the public API will become harder to reason about.

## Flamecast Fit

Projection query is one of the first Firegrid capabilities Flamecast needs, but
it should remain product-neutral.

Possible Flamecast consumers after implementation:

- session timeline replay/live-tail;
- active session and agent indexes;
- runtime presence freshness;
- resource materialization state;
- provider callback request visibility;
- prompt/claimed-intent state;
- transcript views derived from normalized events.

Flamecast still owns all payload schemas and product semantics. Firegrid only
provides the read/query mechanics.

## Non-Goals

This proposal does not define:

- EventPlane producer APIs;
- EventStream append APIs;
- runtime subscriber APIs;
- RunWait authoring APIs;
- claim APIs;
- completion APIs;
- durable record schemas;
- browser EventPlane write authority;
- product projection families;
- Flamecast sessions, Firepixel prompts, Fireline tasks, providers, sandboxes,
  tools, models, ACP, MCP, or provider taxonomies.

## Review Checklist

Implementation PRs for this feature should prove:

- every new behavior cites `firegrid-projection-query.*` ACIDs;
- public browser surfaces are free of runtime and kernel imports;
- query handles are read-only;
- snapshot/follow is no-gap;
- replay/live transition has no drop or duplicate;
- expected errors are typed and distinct;
- raw Durable Streams/StreamDB envelopes are not public payloads;
- product row families stay downstream;
- package-consumption checks prove public imports only;
- implementation code uses `Effect.gen` for multi-step orchestration and keeps
  `pipe` chains for straightforward linear transforms.

## Open Decisions

1. Package placement:
   Use an existing curated root or a new approved subpath. The spec permits
   either, but implementation should choose one and add export/package tests.

2. Cursor representation:
   The public cursor must be opaque. Implementation should decide whether it is
   a branded string, structured value, or encoded token.

3. Framework adapters:
   React or other framework helpers should wait until this Effect-native read
   surface is implemented and a second real product call site proves the
   wrapper shape.

4. EventStream sharing:
   Decide how `events` in projection query shares code and semantics with the
   existing EventStream client read path.

5. Service shape:
   Decide whether the implementation uses `Effect.Service` or the repo's
   established `Context.Tag` plus `Layer` pattern. The public design should be
   service-backed either way.

6. Stream buffering:
   Decide the default buffering/backpressure policy for live projection streams
   before browser adapters are added.
