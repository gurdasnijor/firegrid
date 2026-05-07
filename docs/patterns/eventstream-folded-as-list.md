# Pattern: Browser folds app-owned EventStream into a list

Use this pattern when a browser or edge UI needs ordered history of events —
for example, a session timeline, an audit feed, or any append-only log — and
the read shape is a chronological list rather than a primary-keyed table.
EventStream is the right primitive when ordering matters more than per-key
state lookup.

When the read shape is keyed state with snapshot-and-follow semantics, prefer
[browser-eventplane-projection](./browser-eventplane-projection.md).

Authorizing ACIDs:

- `firegrid-event-streams.*` — caller-owned EventStream append and read
  semantics.
- `firegrid-client-api.*` — public `FiregridClient.events` browser API.
- `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.2` —
  `FiregridClient.emit` is the canonical EventStream append primitive from any
  tier.
- `firegrid-projection-query.CURSOR_AND_REPLAY.*` — replay-then-live-tail
  follows accepted stream order without dropping or duplicating entries.

## Shared descriptor

```ts
// src/shared/timeline.ts
import { EventStream } from "@firegrid/client"
import { Schema } from "effect"

export const TimelineEvents = EventStream.define({
  name: "example.timeline.events",
  event: Schema.Union(
    Schema.Struct({
      _tag: Schema.Literal("UserMessage"),
      sessionId: Schema.String,
      text: Schema.String,
    }),
    Schema.Struct({
      _tag: Schema.Literal("AssistantMessage"),
      sessionId: Schema.String,
      text: Schema.String,
    }),
    Schema.Struct({
      _tag: Schema.Literal("TurnComplete"),
      sessionId: Schema.String,
      finalMessage: Schema.String,
    }),
  ),
})
```

## Producer side

Either the browser (`client.send` -> server -> emit) or the runtime
(`FiregridClient.emit` from inside a handler) appends to the same EventStream.
Producer identity is supplied through caller-owned envelope metadata.

Runtime side, inside a handler:

```ts
yield* client.emit(TimelineEvents, {
  _tag: "AssistantMessage",
  sessionId: input.sessionId,
  text: assistantReply,
})
```

Browser side, when the user submits a message through the UI:

```ts
yield* client.emit(TimelineEvents, {
  _tag: "UserMessage",
  sessionId,
  text: userInputBox.value,
})
```

Both calls produce the same durable row shape; downstream readers cannot
distinguish them except through producer-identity metadata.

## Browser-side reader

Use `FiregridClient.events(stream)` to read replay-then-live-tail. Fold into
local state for rendering:

```ts
import { Effect, Stream } from "effect"
import { EventStream, FiregridClient } from "@firegrid/client"
import { TimelineEvents } from "../shared/timeline.ts"

type TimelineEvent = EventStream.Event<typeof TimelineEvents>

const program = Effect.gen(function*() {
  const client = yield* FiregridClient

  const events: TimelineEvent[] = []

  yield* client.events(TimelineEvents).pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        events.push(event)
        renderTimeline(events)
      }),
    ),
  )
})
```

Key points:

- `client.events(TimelineEvents)` returns a stream that replays retained
  history and then follows live tail. The replay-to-live boundary is shared so
  no event is dropped or duplicated per
  `firegrid-projection-query.CURSOR_AND_REPLAY.3`.
- A reconnect resumes from the last delivered cursor without re-reading
  history.
- A retention gap surfaces as a typed
  `firegrid-projection-query.EXPECTED_ERRORS.3` error rather than silent
  partial state.

## Reconnect / replay UI

For UIs that need to render a long history before live, render after the first
batch of events resolves. The pattern is identical for runtime-authored and
client-authored events because the durable row shape is identical.

```ts
const initialBatch: TimelineEvent[] = []
const recentBatch: TimelineEvent[] = []
let livePhase = false

yield* client.events(TimelineEvents).pipe(
  Stream.runForEach((event) =>
    Effect.sync(() => {
      if (livePhase) {
        recentBatch.push(event)
        renderRecent(recentBatch)
      } else {
        initialBatch.push(event)
      }
    }),
  ),
)
```

If a UI needs to render the replay batch before going live, group events into
batches at the application layer; Firegrid does not split replay and live tail
into different APIs by design.

## Choosing EventStream vs EventPlane

| Concern | EventStream | EventPlane |
| --- | --- | --- |
| Ordered chronological history | First choice | Possible but unergonomic |
| Primary-keyed state lookup | Browser-side fold required | First choice |
| `until(predicate)` for snapshot then live | Possible | First choice |
| Producer can be browser, server, or runtime | Yes | Yes |
| Read API in browser | `client.events(stream)` | `@firegrid/client/projection-query` |

EventStream is the simpler primitive when "what happened, in order" is the
question. EventPlane is the better fit when the question is "what is the
current state of X?" — see
[browser-eventplane-projection](./browser-eventplane-projection.md).

## Anti-patterns

- Storing the timeline in process-local memory in the runtime and exposing it
  through a private socket. UIs reconstruct from durable rows per
  `firegrid-agent-runtime-substrate.RECONNECT_REPLAY.5`.
- Treating `Firegrid.eventStream(...)` as a browser-callable read API.
  `Firegrid.eventStream` is a runtime-side materializer/subscriber per
  `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.2`; the browser-side
  read is `FiregridClient.events`.
- Synthesizing `_tag: "TurnComplete"` from the browser as a way to mark a
  session done. Terminalization is the runtime handler authority path per
  `firegrid-platform-invariants.AUTHORITY.1`.
