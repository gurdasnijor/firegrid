# Pattern: Session List Read Model

Use this when the UI needs the current state of a collection: session list,
active sessions, unread counts, permission-required rows, or any other
queryable read model. If you are building a sidebar/list/table, start here.

Do not use this as the first choice for a session transcript timeline. Timelines
are ordered facts; see [Session timeline events](./eventstream-folded-as-list.md).

Authorizing ACIDs:

- `firegrid-client-projection-api.BROWSER_SAFE_FACADE.1`
- `firegrid-client-projection-api.BROWSER_SAFE_FACADE.2`
- `firegrid-projection-query.QUERY_HANDLES.1`
- `firegrid-projection-query.QUERY_HANDLES.2`
- `firegrid-projection-query.AUTHORITY_BOUNDARY.1`
- `firegrid-projection-query.AUTHORITY_BOUNDARY.2`
- `client-event-plane-registration.EVENT_PLANE_DEFINITION.1`
- `client-event-plane-registration.EVENT_PLANE_DEFINITION.5`
- `client-event-plane-registration.PRODUCER_API.1`
- `client-event-plane-registration.PRODUCER_API.5`

## Use Case

A Flamecast-style UI needs a sidebar showing sessions ordered by recent activity:

```ts
type SessionListRow = {
  readonly sessionId: string
  readonly title: string
  readonly status: "running" | "complete" | "failed"
  readonly updatedAt: string
  readonly eventCount: number
}
```

Runtime/backend code writes one row per session. Browser code asks for the live
list.

## Shared Descriptor

```ts
import { EventPlane } from "@firegrid/substrate/event-plane"
import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"

export const SessionListRow = Schema.Struct({
  sessionId: Schema.String,
  title: Schema.String,
  status: Schema.Literal("running", "complete", "failed"),
  updatedAt: Schema.String,
  eventCount: Schema.Number,
})
export type SessionListRow = Schema.Schema.Type<typeof SessionListRow>

export const SessionsPlane = EventPlane.define({
  name: "flamecast.sessions",
  state: createStateSchema({
    sessions: {
      type: "flamecast.session.row",
      primaryKey: "sessionId",
      schema: Schema.standardSchemaV1(SessionListRow),
    },
  }),
})
```

The descriptor module is shared. It contains schema only.

## Runtime/Backend Writer

When the runtime starts or updates a session, it writes a typed state change.

```ts
import { EventPlane } from "@firegrid/substrate/event-plane"
import { Firegrid } from "@firegrid/runtime"
import { Effect } from "effect"
import { SessionsPlane } from "../shared/sessions-plane.ts"
import { SessionTurn } from "../shared/session-turn.ts"

const handleTurn = Firegrid.handler(SessionTurn, (input) =>
  Effect.gen(function* () {
    const producer = yield* SessionsPlane.Producer

    yield* producer.emit(
      SessionsPlane.state.sessions.insert({
        value: {
          sessionId: input.sessionId,
          title: input.message.slice(0, 80),
          status: "running",
          updatedAt: new Date().toISOString(),
          eventCount: input.ordinal,
        },
      }),
    )

    return yield* runAdapterTurn(input)
  }),
)

const runtime = Firegrid.composeRuntime({
  handlers: [handleTurn],
  provide: [EventPlane.layer(SessionsPlane, { streamUrl })],
})
```

The writer emits a `ChangeEvent` produced by
`SessionsPlane.state.sessions.insert(...)`. It does not pass collection names and
plain objects to `producer.emit`.

## Browser Reader

Use `liveQuery(...)` from `@firegrid/client/projection-query`.

```ts
import { liveQuery } from "@firegrid/client/projection-query"
import { Effect, Stream } from "effect"
import { SessionsPlane, type SessionListRow } from "../shared/sessions-plane.ts"

const sessionList = liveQuery(
  SessionsPlane,
  (q) =>
    q
      .from({ s: q.collection<"sessions", SessionListRow>("sessions") })
      .orderBy(({ s }) => s.updatedAt, "desc")
      .select(({ s }) => s),
  { streamUrl: appConfig.firegridStreamUrl },
)

await Effect.runPromise(
  sessionList.pipe(
    Stream.runForEach((rows) => Effect.sync(() => renderSessionList(rows))),
  ),
)
```

## When To Use This

Use this pattern for:

- session sidebars
- searchable or sorted lists
- counts and badges
- current status rows
- keyed state that must survive refresh/reconnect

Use EventStream instead when:

- the UI is a chronological transcript
- every event matters in accepted order
- there is no need for keyed update/replace semantics
