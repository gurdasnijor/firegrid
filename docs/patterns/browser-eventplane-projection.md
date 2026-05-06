# Browser EventPlane Projection Reads

Status: current pattern and API-ergonomics handoff

Use this pattern when browser, worker, or server code needs a decoded read model
over primary-keyed application state and Firegrid does not yet expose a
projection-query helper from `@firegrid/client`.

## Current Approved Surface

EventPlane projection reads are available today through the public non-kernel
subpath:

```ts
import { EventPlane } from "@firegrid/substrate/event-plane"
```

That subpath is the approved boundary for app-owned row families that need
materialized projection state. It avoids `@firegrid/substrate/kernel` and raw
Durable Streams APIs, while still keeping EventPlane producer/projection
authority outside the browser-facing `@firegrid/client` root.

The shape is:

```ts
const Plane = EventPlane.define({
  name: "app.sessions",
  state: AppSessionState,
})

const PlaneLive = EventPlane.layer(Plane, {
  streamUrl,
  contentType: "application/json",
})
```

`EventPlane.layer(...)` provides both:

- `Plane.Producer`, for validated app-owned row emission.
- `Plane.Projection`, for read-only `snapshot`, `stream`, and `until` queries.

Browser code should receive the configured Layer or service from application
setup code. It should not construct raw Durable Streams clients, import
`@firegrid/substrate/kernel`, or mutate StreamDB collections directly.

## Reading A Projection

Projection queries are application-owned functions over decoded state maps. Each
query declares row authority so call sites are explicit about whether the read is
observational, eligibility-producing, or terminal-domain state.

```ts
import { Effect } from "effect"

const sessionListQuery = {
  label: "session-list",
  authority: "observational" as const,
  evaluate: (snapshot) =>
    Effect.succeed(
      Array.from(snapshot.sessions.values())
        .filter((row) => row.archived !== true)
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs),
    ),
}

const program = Effect.gen(function* () {
  const projection = yield* Plane.Projection
  return yield* projection.snapshot(sessionListQuery)
})
```

Use `projection.stream(query)` when the UI needs live updates. Use
`projection.until(query, predicate, { timeout })` for visibility gates, such as
"do not write the external result row until the request row is visible."

## Flamecast LT-02 Patterns

Flamecast LT-02 needs list, detail, and timeline reads. Those should be modeled
as product-owned rows and projections over an EventPlane plus EventStream
history, not as Firegrid-native row families.

### Session List

Use EventPlane when the sidebar needs current indexed state:

- one row per logical item;
- primary key is the product-owned id;
- projection query filters by tenant/user scope supplied by product code;
- result is sorted by product-owned timestamps or durable cursor-derived
  materialized fields.

EventPlane is the right fit because a list wants the latest row per item, not
every historical event.

### Session Detail

Use EventPlane for current detail state:

- status;
- title or display fields;
- provider/runtime metadata chosen by the product;
- last activity summary;
- pointers to EventStream history.

The detail page can combine one EventPlane snapshot for current state with an
EventStream reader for chronological timeline entries.

### Timeline

Use EventStream when the UI needs append-only chronological history:

- normalized product events;
- provider callback events already accepted by product code;
- user-visible progress entries;
- transcript-like history.

If the timeline also needs fast current aggregates, materialize those aggregates
into EventPlane rows and keep the raw timeline in EventStream.

## EventPlane Versus EventStream

Use EventStream plus `client.events(...)` when:

- the data is append-only history;
- consumers want chronological replay/live tail;
- there is no primary-keyed latest-state fold;
- the browser only needs `@firegrid/client`.

Use EventPlane plus `Plane.Projection` when:

- the data is current state or indexed state;
- readers need lookup by key, filters, or derived lists;
- `RunWait`/projection-match needs to observe product-owned state;
- runtime/server code will also emit validated rows through `Plane.Producer`.

Do not model current lists by replaying an EventStream in every UI component
unless the list is tiny and explicitly disposable. Folded state belongs in
EventPlane.

## Relationship To Raw StreamDB

Raw Durable Streams StreamDB remains an implementation building block. Firegrid
hides it from normal app-facing authority because raw StreamDB exposes too much
mechanical detail:

- raw collection instances;
- raw change-event shapes;
- stream preload lifecycle;
- materializer ownership;
- transport details and lower-level errors;
- mutation helpers that can blur read authority and write authority.

Firegrid exposes:

- app-owned schemas through EventPlane definitions;
- validated producer and projection services;
- typed `snapshot`, `stream`, and `until` reads;
- typed read errors;
- row authority labels;
- package-boundary guardrails.

The projection remains a derived cache over durable records. If projection state
and the durable log disagree, the durable log is authoritative.

## Current Gaps

The current approved EventPlane projection path is usable but not yet as
ergonomic as the target `firegrid-projection-query` API:

- browser docs must explain Layer/service wiring;
- cursors are not yet a first-class public projection-query token;
- EventPlane projection reads are not re-exported from `@firegrid/client`;
- `client.events(...)` and `Plane.Projection.stream(...)` have different public
  ergonomics.

These are API ergonomics gaps, not a reason to import raw StreamDB or kernel
modules in product code.

## Future API Candidates

Ranked by value/risk:

1. `@firegrid/client` re-export of read-only EventPlane projection types.
   - Value: gives browser/docs one package to import for reads.
   - Risk: medium; must avoid importing server/runtime or producer authority
     into the browser-safe client root.
2. `projectionFor(plane).snapshot/stream/until` helper.
   - Value: makes descriptor-scoped reads obvious and aligns with the SDD
     `ProjectionQueryHandle` shape.
   - Risk: medium; needs cursor/error model design before promising no-gap
     replay semantics.
3. `EventPlane.observe(...)` convenience.
   - Value: shortest call site for live UI reads.
   - Risk: high; easy to blur snapshot-first, cursor, `until`, and authority
     boundaries into a single live-only helper.

Recommendation: implement the read-only client re-export only after package
boundary tests prove it stays browser-safe, then add a `projectionFor`-style
helper once cursor/error semantics are implemented. Defer direct
`EventPlane.observe(...)` until there are two real call sites and clear
snapshot/replay semantics.
