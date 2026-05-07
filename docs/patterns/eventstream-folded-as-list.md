# Pattern: Browser Reads A Live List

Use this pattern when a browser UI needs a live list such as sessions, messages,
events, or audit rows. The default browser API is the projection-query facade,
not manual EventStream folding inside components.

Authorizing ACIDs:

- `firegrid-client-projection-api.BROWSER_SAFE_FACADE.1`
- `firegrid-client-projection-api.BROWSER_SAFE_FACADE.2`
- `firegrid-projection-query.QUERY_HANDLES.*`
- `firegrid-projection-query.AUTHORITY_BOUNDARY.*`
- `firegrid-event-streams.*`

## Shared Read Model

Define the app-owned projection descriptor in shared schema code. Runtime or
backend code writes the underlying rows; browser code reads through
`@firegrid/client/projection-query`.

```ts
import { EventPlane } from "@firegrid/substrate/event-plane"
import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"

export const MessageRow = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  role: Schema.Literal("user", "assistant", "system"),
  text: Schema.String,
  createdAt: Schema.String,
})
export type MessageRow = Schema.Schema.Type<typeof MessageRow>

export const MessagesPlane = EventPlane.define({
  name: "app.messages",
  state: createStateSchema({
    messages: {
      type: "app.message.row",
      primaryKey: "id",
      schema: Schema.standardSchemaV1(MessageRow),
    },
  }),
})
```

## Browser Live List

Use `liveQuery(...)` for the UI list. It gives the browser one declarative
read-model expression instead of hand-maintaining an event array.

```ts
import { liveQuery } from "@firegrid/client/projection-query"
import { Effect, Stream } from "effect"
import { MessagesPlane, type MessageRow } from "../shared/messages-plane.ts"

const messages = liveQuery(
  MessagesPlane,
  (q) =>
    q
      .from({ m: q.collection<"messages", MessageRow>("messages") })
      .where(({ m }) => m.sessionId === activeSessionId)
      .orderBy(({ m }) => m.createdAt, "asc")
      .select(({ m }) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        createdAt: m.createdAt,
      })),
  { streamUrl: appConfig.firegridStreamUrl },
)

await Effect.runPromise(
  messages.pipe(
    Stream.runForEach((rows) => Effect.sync(() => renderMessages(rows))),
  ),
)
```

Count and filtered-list cases use the same surface:

```ts
const messageCount = liveQuery(
  MessagesPlane,
  (q) =>
    q
      .from({ m: q.collection<"messages", MessageRow>("messages") })
      .where(({ m }) => m.sessionId === activeSessionId)
      .count(),
  { streamUrl: appConfig.firegridStreamUrl },
)
```

## Where EventStream Fits

EventStream remains the right write/history primitive for ordered facts. Runtime
and backend code may append normalized timeline facts with `FiregridClient.emit`,
and materializers can project those facts into the read model above.

Use raw `client.events(stream)` in browser code only when the UI truly wants an
append-only log and is prepared to own the fold itself. Most product UI lists
should use `liveQuery(...)`.

## Anti-Patterns

- Browser components manually folding EventStream rows into canonical session
  lists when a projection read model exists.
- Browser components importing `@firegrid/substrate/kernel` or raw StreamDB.
- Storing the list in process-local runtime memory and exposing it through a
  private socket. UIs reconstruct from durable rows per
  `firegrid-agent-runtime-substrate.RECONNECT_REPLAY.5`.
- Synthesizing terminal states or session completion from the browser; operation
  terminalization remains the runtime handler authority path.
