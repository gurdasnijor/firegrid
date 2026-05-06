# Pattern: Browser reads app-owned EventPlane projection

Use this pattern when a browser or edge UI needs typed, primary-keyed durable
state — for example, a session index, a permission-required list, a tool-result
table, or any keyed read model. EventPlane projections give the browser a typed
snapshot plus live tail with retention-gap and decode errors as typed expected
failures.

Authorizing ACIDs:

- `firegrid-platform-invariants.LOCALITY.5` — `@firegrid/substrate` exposes
  `./descriptors`, `./event-plane`, and `./id-gen` as approved
  application-facing subpaths; `./kernel` is not application-facing.
- `firegrid-platform-invariants.LOCALITY.7` — `@firegrid/substrate/event-plane`
  is browser- and edge-safe; browser code may import `EventPlane.define`,
  `EventPlane.layer`, the `PlaneProducer` Tag, the `PlaneProjection` Tag, and
  related types directly without violating `LOCALITY.1`, `LOCALITY.2`, or
  `LOCALITY.3`.
- `firegrid-projection-query.QUERY_HANDLES.*` —
  `snapshot`/`stream`/`until`/`events` semantics over descriptor-owned state.
- `firegrid-projection-query.AUTHORITY_BOUNDARY.*` — projection handles are
  read-only.
- `client-event-plane-registration.*` — EventPlane definition, producer, and
  projection mechanics.

## Shared plane descriptor

Define the EventPlane in a module shared by browser and runtime:

```ts
// src/shared/session-plane.ts
import { EventPlane } from "@firegrid/substrate/event-plane"
import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"

const SessionRow = Schema.Struct({
  sessionId: Schema.String,
  status: Schema.Literal("active", "completed", "failed"),
  title: Schema.String,
  updatedAt: Schema.String,
})

export const SessionPlane = EventPlane.define({
  name: "example.session.plane",
  state: createStateSchema({
    sessions: {
      type: "example.session.row",
      primaryKey: "sessionId",
      schema: Schema.standardSchemaV1(SessionRow),
    },
  }),
})
```

This module is browser-safe. `@firegrid/substrate/event-plane` and
`@durable-streams/state` are both browser-compatible; `@firegrid/substrate` is
already a transitive dependency of `@firegrid/client`.

## Browser-side reader

The browser composes `EventPlane.layer({ streamUrl })` and yields the
`PlaneProjection` Tag. Snapshot, follow, and `until` calls flow through the
same projection-query mechanics specified by
`firegrid-projection-query.QUERY_HANDLES.*`.

```ts
import { Effect, Layer, Stream } from "effect"
import { EventPlane } from "@firegrid/substrate/event-plane"
import { SessionPlane } from "../shared/session-plane.ts"

const ApplicationPlaneLive = EventPlane.layer(SessionPlane, {
  streamUrl: appConfig.firegridStreamUrl,
})

const program = Effect.gen(function*() {
  const projection = yield* SessionPlane.Projection

  // Snapshot the current sessions table.
  const snapshot = yield* projection.snapshot({
    collection: "sessions",
  })

  for (const session of snapshot.rows) {
    renderSessionRow(session)
  }

  // Follow live changes from the snapshot cursor.
  yield* projection.stream({
    collection: "sessions",
    cursor: snapshot.cursor,
  }).pipe(
    Stream.runForEach((change) => Effect.sync(() => applyChange(change))),
  )
})

await Effect.runPromise(program.pipe(Effect.provide(ApplicationPlaneLive)))
```

Key points:

- `EventPlane.layer` returns a Layer that exposes both the producer and
  projection Tags. Browser code typically only consumes the projection. The
  producer Tag remains available for runtime code that imports the same plane.
- `snapshot` returns decoded rows plus an opaque cursor token; `stream(cursor)`
  follows from that cursor without gaps per
  `firegrid-projection-query.CURSOR_AND_REPLAY.2`.
- Reconnect after transport loss resumes from the last delivered cursor; if
  retention has dropped data, you receive a typed
  `firegrid-projection-query.EXPECTED_ERRORS.3` retention-gap error rather than
  silent partial state.
- The projection handle is read-only per
  `firegrid-projection-query.AUTHORITY_BOUNDARY.1`; it has no append, claim,
  complete, fail, or cancel APIs.

## Runtime-side writer

The runtime side writes plane rows through the producer Tag from the same
descriptor:

```ts
// src/runtime/main.ts
import { Effect } from "effect"
import { Firegrid } from "@firegrid/runtime"
import { EventPlane } from "@firegrid/substrate/event-plane"
import { SessionPlane } from "../shared/session-plane.ts"
import { CreateSession } from "../shared/operations.ts"

const createSessionHandler = Firegrid.handler(CreateSession, (input) =>
  Effect.gen(function*() {
    const producer = yield* SessionPlane.Producer
    yield* producer.emit("sessions", {
      sessionId: input.sessionId,
      status: "active",
      title: input.title,
      updatedAt: new Date().toISOString(),
    })
    return { sessionId: input.sessionId }
  }),
)

const ApplicationPlaneLive = EventPlane.layer(SessionPlane, {
  streamUrl: process.env.FIREGRID_STREAM_URL!,
})

const runtime = Firegrid.composeRuntime({
  handlers: [createSessionHandler],
  subscribers: [],
  provide: [ApplicationPlaneLive],
})
```

The runtime authors plane rows; the browser reads them. There is one shared
descriptor and one shared schema; neither side imports the other's tier.

## Future ergonomic facade

`firegrid-client-projection-api` proposes a thinner browser-side facade over
the same mechanics, exposing the projection through `@firegrid/client` so a
browser entrypoint can use a single import. That facade is a usability
improvement; this pattern works without it today per
`firegrid-platform-invariants.LOCALITY.7-note`.

## Anti-patterns

- Reaching into `@firegrid/substrate/kernel` for "raw" plane reads. Kernel is
  not application-facing per `firegrid-platform-invariants.LOCALITY.5`.
- Importing `@firegrid/runtime` from browser code to call a runtime-side
  helper. Runtime is Node-tier per `firegrid-platform-invariants.LOCALITY.1`.
- Using a process-local cache as the source of truth for browser UI. UIs
  reconstruct from durable rows and replayed events per
  `firegrid-agent-runtime-substrate.RECONNECT_REPLAY.5`.
