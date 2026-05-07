# Pattern: Browser Reads App-Owned Projection State

Use this when browser or edge code needs live, read-only access to app-owned
keyed state: session indexes, prompt queues, permission-required rows, or other
read models.

Authorizing ACIDs:

- `firegrid-client-projection-api.BROWSER_SAFE_FACADE.1`
- `firegrid-client-projection-api.BROWSER_SAFE_FACADE.2`
- `firegrid-projection-query.QUERY_HANDLES.*`
- `firegrid-projection-query.AUTHORITY_BOUNDARY.*`
- `client-event-plane-registration.*`

## Shared Plane Descriptor

The app defines an EventPlane descriptor for the row family. Keep the module
schema-only so browser and runtime can import it safely.

```ts
import { EventPlane } from "@firegrid/substrate/event-plane"
import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"

export const SessionRow = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.String,
  status: Schema.Literal("active", "complete", "failed"),
  updatedAt: Schema.String,
})
export type SessionRow = Schema.Schema.Type<typeof SessionRow>

export const SessionsPlane = EventPlane.define({
  name: "app.sessions",
  state: createStateSchema({
    sessions: {
      type: "app.session.row",
      primaryKey: "sessionId",
      schema: Schema.standardSchemaV1(SessionRow),
    },
  }),
})
```

## Browser Live Query

Use the client projection-query facade. Do not compose raw EventPlane Layers in
browser components.

```ts
import { liveQuery } from "@firegrid/client/projection-query"
import { Effect, Stream } from "effect"
import { SessionsPlane, type SessionRow } from "../shared/sessions-plane.ts"

const sessions = liveQuery(
  SessionsPlane,
  (q) =>
    q
      .from({ s: q.collection<"sessions", SessionRow>("sessions") })
      .orderBy(({ s }) => s.updatedAt, "desc")
      .select(({ s }) => s),
  { streamUrl: appConfig.firegridStreamUrl },
)

await Effect.runPromise(
  sessions.pipe(
    Stream.runForEach((rows) => Effect.sync(() => renderSessions(rows))),
  ),
)
```

For simple ordered history, prefer EventStream plus `client.events(...)`; use a
projection when the UI needs keyed state, derived state, filtering, ordering, or
counts.

## Runtime Writer

Runtime code writes the plane through the app-owned EventPlane producer, provided
as a runtime Layer.

```ts
import { EventPlane } from "@firegrid/substrate/event-plane"
import { Firegrid } from "@firegrid/runtime"
import { Effect } from "effect"
import { SessionsPlane } from "../shared/sessions-plane.ts"
import { CreateSession } from "../shared/operations.ts"

const createSession = Firegrid.handler(CreateSession, (input) =>
  Effect.gen(function* () {
    const producer = yield* SessionsPlane.Producer
    yield* producer.emit(
      SessionsPlane.state.sessions.insert({
        value: {
          sessionId: input.sessionId,
          title: input.title,
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      }),
    )
    return { sessionId: input.sessionId }
  }),
)

const runtime = Firegrid.composeRuntime({
  handlers: [createSession],
  provide: [EventPlane.layer(SessionsPlane, { streamUrl })],
})
```

## Anti-Patterns

- Browser components importing `@firegrid/substrate/kernel`.
- Browser components importing `@firegrid/runtime`.
- Browser components reading raw StreamDB or Durable Streams State envelopes.
- Process-local session lists used as the source of truth after refresh.
