# Pattern: Node runtime emits app-owned EventStream rows from handlers

Use this pattern when a runtime handler needs to append app-owned EventStream
entries during its execution — for example, normalized session events, audit
log entries, or progress updates that browser code will fold into UI state.

Authorizing ACIDs:

- `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.1` — runtime handler
  may call `FiregridClient` methods when the application provides
  `FiregridClientLive` in `Firegrid.composeRuntime.provide`.
- `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.2` —
  `FiregridClient.emit` is the canonical EventStream append primitive;
  `Firegrid.eventStream` is a subscriber, not an emitter.
- `firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.3` — the application's
  Node entrypoint may import both packages.
- `firegrid-platform-invariants.LOCALITY.3-note` — package-edge prohibitions
  are manifest-level, not application-import-level.
- `firegrid-agent-runtime-substrate.MULTI_WAIT_RESUME.2` — between waits, a
  handler may emit caller-owned EventPlane rows and append to caller-owned
  EventStream entries.

## Application package manifest

Both packages are application dependencies. There is no manifest edge between
them.

```json
{
  "dependencies": {
    "@firegrid/client": "...",
    "@firegrid/runtime": "...",
    "@firegrid/substrate": "...",
    "effect": "..."
  }
}
```

## Shared descriptors

Place app-owned `Operation` and `EventStream` descriptors in a module that both
the Node entrypoint and the browser bundle import. Descriptors are pure
schemas; they have no Node-only or browser-only code paths.

```ts
import { EventStream, Operation } from "@firegrid/client"
import { Schema } from "effect"

export const ProcessTurn = Operation.define({
  name: "example.turn.process",
  input: Schema.Struct({ turnId: Schema.String, text: Schema.String }),
  output: Schema.Struct({ turnId: Schema.String, finalText: Schema.String }),
  error: Schema.Struct({
    _tag: Schema.Literal("TurnFailed"),
    turnId: Schema.String,
    reason: Schema.String,
  }),
})

export const TurnEvents = EventStream.define({
  name: "example.turn.events",
  event: Schema.Union(
    Schema.Struct({
      _tag: Schema.Literal("Started"),
      turnId: Schema.String,
    }),
    Schema.Struct({
      _tag: Schema.Literal("Completed"),
      turnId: Schema.String,
      finalText: Schema.String,
    }),
  ),
})
```

## Node-tier runtime entrypoint

The runtime entrypoint imports both `@firegrid/runtime` and `@firegrid/client`.
The handler obtains the `FiregridClient` service through normal Effect service
yield and calls `client.emit(TurnEvents, event)`.

```ts
// src/runtime/main.ts
import { Effect } from "effect"
import { FiregridClient, FiregridClientLive } from "@firegrid/client"
import { Firegrid, run } from "@firegrid/runtime"
import { ProcessTurn, TurnEvents } from "../shared/descriptors.ts"

const processTurnHandler = Firegrid.handler(ProcessTurn, (input) =>
  Effect.gen(function*() {
    const client = yield* FiregridClient

    yield* client.emit(TurnEvents, {
      _tag: "Started",
      turnId: input.turnId,
    })

    const finalText = `processed: ${input.text}`

    yield* client.emit(TurnEvents, {
      _tag: "Completed",
      turnId: input.turnId,
      finalText,
    })

    return { turnId: input.turnId, finalText }
  }),
)

const streamUrl = process.env.FIREGRID_STREAM_URL!

const runtime = Firegrid.composeRuntime({
  handlers: [processTurnHandler],
  subscribers: [],
  provide: [
    FiregridClientLive({ streamUrl }),
  ],
})

await Effect.runPromise(
  run({
    connection: { streamUrl },
    runtime,
  }),
)
```

Key points:

- `FiregridClientLive({ streamUrl })` is added to `provide`; the handler then
  yields `FiregridClient` like any other Effect service.
- `client.emit(TurnEvents, ...)` produces the same durable EventStream row a
  browser-side `client.emit` would; subscribers and replay observers cannot
  distinguish runtime-authored emits from client-authored emits except through
  producer-identity metadata
  (`firegrid-agent-runtime-substrate.HANDLER_CLIENT_USAGE.4`).
- Terminalization remains the handler return path
  (`firegrid-platform-invariants.AUTHORITY.1`); `client.emit` writes a row but
  does not author a terminal run state.

## Browser side

Browser code reads the same EventStream through the public client surface:

```ts
import { Effect, Stream } from "effect"
import { FiregridClient } from "@firegrid/client"
import { TurnEvents } from "../shared/descriptors.ts"

const program = Effect.gen(function*() {
  const client = yield* FiregridClient
  yield* client.events(TurnEvents).pipe(
    Stream.runForEach((event) => Effect.log(event)),
  )
})
```

The browser does not know — and does not need to know — that the runtime
process authored those rows.

## Anti-patterns

- Calling `Firegrid.eventStream(TurnEvents, ...)` and expecting it to emit. It
  materializes incoming events; the emitter is `FiregridClient.emit`.
- Adding `@firegrid/runtime` as a dependency of `@firegrid/client` (or vice
  versa). The boundary is manifest-level. Do the import at application level.
- Importing `@firegrid/substrate/kernel` from the runtime entrypoint to
  "shortcut" the EventStream append. Substrate kernel is not application-facing
  per `firegrid-platform-invariants.LOCALITY.5`.
