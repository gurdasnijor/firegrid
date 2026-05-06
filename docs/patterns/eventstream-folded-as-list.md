# EventStream Folded As List

Status: current pattern and decision guide

EventStream is the Firegrid surface for caller-owned append-only events. It is
the right tool for timelines and audit history. It can be folded into a list,
but that fold should usually happen in a product-owned projection layer rather
than inside every browser component.

## Use EventStream Directly

Use `EventStream` plus `client.events(...)` when the UI wants chronological
history:

```ts
import { EventStream, FiregridClient } from "@firegrid/client"
import { Effect, Schema, Stream } from "effect"

export const TimelineEvents = EventStream.define({
  name: "app.timeline",
  event: Schema.Struct({
    itemId: Schema.String,
    type: Schema.String,
    text: Schema.optional(Schema.String),
  }),
})

const program = Effect.gen(function* () {
  const client = yield* FiregridClient
  return yield* client.events(TimelineEvents).pipe(
    Stream.runForEach(renderTimelineEvent),
  )
})
```

This keeps the browser on `@firegrid/client` and avoids EventPlane wiring when
the product only needs replay/live event history.

## Avoid Per-Component Folding For Durable Lists

A sidebar list is not just a timeline. It usually needs:

- latest state by id;
- sort order;
- filtering;
- archive/delete visibility;
- durable reconnect behavior;
- consistent detail links.

If every UI component folds `client.events(...)` locally, those components
become competing projection implementations. They must all solve replay,
dedupe, ordering, retention, and decode errors in the same way.

Use local folding only for disposable views such as:

- a small debug panel;
- a local demo with bounded history;
- a short-lived in-memory preview;
- an intentionally best-effort activity feed.

For durable product lists, materialize the fold into EventPlane rows and read it
through `Plane.Projection`.

## Flamecast LT-02 Guidance

For Flamecast LT-02-style screens:

- Session timeline: `EventStream` plus `client.events(...)`.
- Session list/sidebar: EventPlane projection keyed by product session id.
- Session detail/header: EventPlane projection for current detail state.
- Timeline aggregates: EventPlane rows materialized from the EventStream or
  written alongside the EventStream by product runtime code.

This split keeps the timeline replayable while making list/detail reads cheap
and deterministic.

## Firegrid Authority Boundary

`client.events(...)` is read-side event observation. It does not grant:

- EventPlane producer authority;
- raw StreamDB access;
- claim authority;
- completion resolution;
- terminal operation authority;
- runtime handler registration.

If a caller needs primary-keyed state, move up to EventPlane. If a caller needs
durable wait/resume behavior, use app-owned EventPlane rows plus Firegrid
`RunWait`/projection-match mechanics in runtime code. Do not make the browser a
projection-match subscriber or a terminal row writer.

## Migration Path

Start with EventStream when the product only needs event history. When a list or
detail view appears, add a product-owned EventPlane projection and keep the
EventStream as the source history.

Do not switch to raw Durable Streams StreamDB to get list ergonomics. The
Firegrid path is:

```txt
EventStream for history
EventPlane for folded/current state
Projection query facade for future browser/server read ergonomics
```
