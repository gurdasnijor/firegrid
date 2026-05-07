# Pattern: Runtime Handler Emits App-Owned EventStream Rows

Use this when a runtime handler needs to append app-owned EventStream rows during
execution: session timeline entries, progress updates, audit rows, or adapter
lifecycle events that the browser will replay with `client.events(...)`.

Authorizing ACIDs:

- `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.1`
- `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.2`
- `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.3`
- `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.4`
- `firegrid-agent-runtime-substrate.MULTI_WAIT_RESUME.2`
- `firegrid-platform-invariants.AUTHORITY.1`

## Shared Descriptors

Descriptors are schema-only values shared by browser and runtime code.

```ts
import { EventStream, Operation } from "@firegrid/client"
import { Schema } from "effect"

export const SessionTurn = Operation.define({
  name: "app.session.turn",
  input: Schema.Struct({
    sessionId: Schema.String,
    turnId: Schema.String,
    message: Schema.String,
  }),
  output: Schema.Struct({
    sessionId: Schema.String,
    turnId: Schema.String,
  }),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
})

export const SessionEvents = EventStream.define({
  name: "app.session.events",
  event: Schema.Union(
    Schema.Struct({
      type: Schema.Literal("user_message"),
      sessionId: Schema.String,
      turnId: Schema.String,
      text: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("assistant_message"),
      sessionId: Schema.String,
      turnId: Schema.String,
      text: Schema.String,
    }),
    Schema.Struct({
      type: Schema.Literal("error"),
      sessionId: Schema.String,
      turnId: Schema.String,
      message: Schema.String,
    }),
  ),
})
```

## Runtime Composition

Provide `FiregridClientLive` once in `Firegrid.composeRuntime({ provide })`.
Handler helpers then yield `FiregridClient`; they do not build a client Layer per
emit.

```ts
import { FiregridClient, FiregridClientLive } from "@firegrid/client"
import { Firegrid, run } from "@firegrid/runtime"
import { Effect } from "effect"
import {
  SessionEvents,
  SessionTurn,
  type SessionEvent,
} from "../shared/protocol.ts"

const emitTimeline = (events: readonly SessionEvent[]) =>
  Effect.gen(function* () {
    const client = yield* FiregridClient
    yield* Effect.forEach(
      events,
      (event) => client.emit(SessionEvents, event),
      { discard: true },
    )
  })

const runtime = Firegrid.composeRuntime({
  handlers: [
    Firegrid.handler(SessionTurn, (input) =>
      Effect.gen(function* () {
        yield* emitTimeline(startEvents(input))

        const output = yield* runConfiguredAdapter(input).pipe(
          Effect.tapError((failure) =>
            emitTimeline([failureEvent(input, failure)]),
          ),
        )

        yield* emitTimeline(successEvents(input, output))
        return { sessionId: input.sessionId, turnId: input.turnId }
      }),
    ),
  ],
  provide: [
    FiregridClientLive({
      streamUrl,
      clientId: runtimeId,
    }),
  ],
})

await Effect.runPromise(run({ connection: { streamUrl }, runtime }))
```

Key points:

- `FiregridClient.emit` writes caller-owned EventStream rows. It does not
  terminalize the operation.
- Terminalization remains the handler return value or `Effect.fail`.
- `Firegrid.eventStream(...)` is for materializing EventStream entries; it is
  not an emitter.
- App Node entrypoints may import both `@firegrid/runtime` and
  `@firegrid/client` when both are application dependencies.

## Browser Reader

```ts
import { FiregridClient } from "@firegrid/client"
import { Effect, Stream } from "effect"
import { SessionEvents } from "../shared/protocol.ts"

const program = Effect.gen(function* () {
  const client = yield* FiregridClient
  yield* client.events(SessionEvents).pipe(
    Stream.runForEach((event) => Effect.sync(() => appendTimeline(event))),
  )
})
```

The browser cannot tell whether an event was authored by a user action or by a
runtime handler except through caller-supplied metadata.
