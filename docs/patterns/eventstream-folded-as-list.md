# Pattern: Session Timeline Events

Use this when the UI needs a chronological transcript: user messages, assistant
messages, step events, warnings, errors, and turn-complete rows. If you are
building the main session timeline/detail view, start here.

If you are building a sidebar/list/table of current session state, use
[Session list read model](./browser-eventplane-projection.md).

Authorizing ACIDs:

- `firegrid-event-streams.*`
- `firegrid-client-api.*`
- `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.1`
- `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.2`
- `firegrid-agent-runtime-substrate.MULTI_WAIT_RESUME.2`
- `flamecast-product-contract.EVENTS.*`

## Use Case

A Flamecast-style session detail view needs all timeline events in order:

```ts
type SessionTimelineEvent =
  | { type: "user_message"; sessionId: string; sequence: number; text: string }
  | { type: "assistant_message"; sessionId: string; sequence: number; text: string }
  | { type: "turn_complete"; sessionId: string; sequence: number }
  | { type: "error"; sessionId: string; sequence: number; message: string }
```

Runtime/backend code appends normalized events. Browser code reads the retained
stream and follows live updates.

## Shared Descriptor

```ts
import { EventStream } from "@firegrid/client"
import { Schema } from "effect"

export const SessionEvents = EventStream.define({
  name: "flamecast.session.events",
  event: Schema.Union(
    Schema.Struct({
      type: Schema.Literal("user_message"),
      sessionId: Schema.String,
      sequence: Schema.Number,
      text: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("assistant_message"),
      sessionId: Schema.String,
      sequence: Schema.Number,
      text: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("turn_complete"),
      sessionId: Schema.String,
      sequence: Schema.Number,
    }),
    Schema.Struct({
      type: Schema.Literal("error"),
      sessionId: Schema.String,
      sequence: Schema.Number,
      message: Schema.String,
    }),
  ),
})

export type SessionTimelineEvent = EventStream.Event<typeof SessionEvents>
```

## Runtime/Backend Appender

Inside a runtime handler, provide `FiregridClientLive` once at runtime
composition, then yield `FiregridClient` and emit timeline events.

```ts
import { FiregridClient } from "@firegrid/client"
import { Firegrid } from "@firegrid/runtime"
import { Effect } from "effect"
import { SessionEvents } from "../shared/session-events.ts"
import { SessionTurn } from "../shared/session-turn.ts"

const handleTurn = Firegrid.handler(SessionTurn, (input) =>
  Effect.gen(function* () {
    const client = yield* FiregridClient

    yield* client.emit(SessionEvents, {
      type: "user_message",
      sessionId: input.sessionId,
      sequence: input.ordinal * 10 + 1,
      text: input.message,
    })

    const output = yield* runAdapterTurn(input)

    yield* client.emit(SessionEvents, {
      type: "assistant_message",
      sessionId: input.sessionId,
      sequence: input.ordinal * 10 + 2,
      text: output.text,
    })

    yield* client.emit(SessionEvents, {
      type: "turn_complete",
      sessionId: input.sessionId,
      sequence: input.ordinal * 10 + 3,
    })

    return { sessionId: input.sessionId, turnId: input.turnId }
  }),
)
```

`FiregridClient.emit` appends timeline facts. The operation still terminalizes
through the handler return value or `Effect.fail`.

## Browser Reader

For a transcript, `client.events(SessionEvents)` is appropriate because the UI
wants the ordered log itself.

```ts
import { FiregridClient } from "@firegrid/client"
import { Effect, Stream } from "effect"
import { SessionEvents, type SessionTimelineEvent } from "../shared/session-events.ts"

const program = Effect.gen(function* () {
  const client = yield* FiregridClient
  const events: SessionTimelineEvent[] = []

  yield* client.events(SessionEvents).pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event.sessionId !== activeSessionId) return
        events.push(event)
        events.sort((left, right) => left.sequence - right.sequence)
        renderTimeline(events)
      }),
    ),
  )
})
```

For derived views such as “all sessions ordered by last update,” do not fold this
timeline manually in every component. Materialize a session-list read model and
query it with `liveQuery(...)`.

## When To Use This

Use this pattern for:

- session transcript/detail timeline
- append-only audit feed
- ordered provider/adapter lifecycle events
- raw event inspection views

Use a projection read model instead when:

- the UI needs sorting/filtering/counts over current state
- the UI needs one row per session/resource/key
- multiple components need the same derived view
