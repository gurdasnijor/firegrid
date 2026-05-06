# @firegrid/client

`@firegrid/client` is the app-facing Firegrid SDK. It lets browser and
application code send typed operation messages, observe operation handles, emit
caller-owned EventStream rows, and observe caller-owned EventStreams.

The client does not install handlers, claim work, resolve completions, author
terminal run state, run subscribers, start runtime processes, or launch Durable
Streams servers. Runtime handlers and subscribers live in `@firegrid/runtime`;
durable authority stays in substrate internals.

## Configure

Application shell code passes transport configuration explicitly:

```ts
import { FiregridClientLive } from "@firegrid/client"

const ClientLive = FiregridClientLive({
  streamUrl: appConfig.firegridStreamUrl,
  contentType: "application/json",
})
```

Browser-facing client modules should receive this layer or a configured service
from app setup code. They should not read process environment directly.

## Define Contracts

Operation and EventStream descriptors are schema-only contract values:

```ts
import { EventStream, Operation } from "@firegrid/client"
import { Schema } from "effect"

const ApproveTool = Operation.define({
  name: "app.approveTool",
  input: Schema.Struct({
    requestId: Schema.String,
  }),
  output: Schema.Struct({
    approved: Schema.Boolean,
  }),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
})

const UiEvents = EventStream.define({
  name: "app.ui.events",
  event: Schema.Struct({
    type: Schema.String,
    requestId: Schema.String,
  }),
})
```

Descriptors do not contain runtime handlers or registration side effects.

## Send And Observe Operations

Use `send` when the UI needs a durable handle, `observe` for live state, and
`result` when waiting on an existing handle:

```ts
import { FiregridClient } from "@firegrid/client"
import { Effect, Fiber, Stream } from "effect"

const program = Effect.gen(function* () {
  const client = yield* FiregridClient

  const handle = yield* client.send(ApproveTool, {
    requestId: "req-123",
  })

  const stateFiber = yield* client.observe(ApproveTool, handle).pipe(
    Stream.runForEach((state) => Effect.log(state)),
    Effect.fork,
  )

  const output = yield* client.result(ApproveTool, handle)
  yield* Fiber.interrupt(stateFiber)
  return output
})
```

`result` resolves only after a runtime participant has handled the operation and
substrate has materialized a terminal run state. The client does not execute the
handler or author that terminal state.

## Request-Response Convenience

`call` is request-response sugar over `send` plus `result`:

```ts
const output = yield* client.call(ApproveTool, {
  requestId: "req-123",
})
```

Use `send` plus `observe` when the application needs progress UI or a durable
handle to store outside the current Effect.

## EventStream Rows

Use EventStream for lightweight caller-owned append-only events:

```ts
yield* client.emit(UiEvents, {
  type: "permission.clicked",
  requestId: "req-123",
})

yield* client.events(UiEvents).pipe(
  Stream.runForEach((event) => Effect.log(event)),
)
```

Use EventPlane from `@firegrid/substrate/event-plane` inside runtime layers
when the domain needs primary-keyed state, materialized projections, or
projection-match evaluation. EventPlane is not the browser client surface.

## Focused Smoke Checks

The focused package checks are:

```sh
pnpm --filter @firegrid/client run typecheck
pnpm --filter @firegrid/client run test -- firegrid-operations
pnpm --filter @firegrid/client run test -- firegrid-event-streams
```

`firegrid-operations` covers operation `send`, `result`, `observe`, descriptor
decode, and authority-boundary guards. `firegrid-event-streams` covers
EventStream `emit` and `events`. CI remains the authority for the complete repo
matrix.

The examples above are intentionally client-only. They demonstrate the
production `FiregridClient` root and EventStream surface, while handler
installation, waiting primitives, durable authority, raw stream diagnostics, and
runtime startup stay in their own packages and runbooks.

## Do Not Import

Client application code should not import:

- `@firegrid/runtime`;
- `@firegrid/substrate/kernel`;
- runtime handler registration APIs;
- RunWait or choreography services;
- claim, completion, or terminal-authority helpers;
- raw Durable Streams writers as the normal app API;
- lab-only paths or dev-server launchers.
