# @firegrid/client

`@firegrid/client` is the app-facing Firegrid SDK for browser and application
code. It sends typed operation messages, observes operation handles, waits for
typed operation results, emits caller-owned EventStream rows, and observes
caller-owned EventStreams.

In the broader Firegrid architecture, the client sits at the edge:

```txt
application code
  -> @firegrid/client
  -> Firegrid operation and EventStream descriptors
  -> runtime handlers and substrate-backed durable state
```

The client does not install handlers, claim work, resolve waits, author
terminal run state, run subscribers, start runtime processes, or launch stream
servers. Runtime handlers and subscribers live in `@firegrid/runtime`; durable
coordination primitives live behind the curated `@firegrid/substrate` public
surface.

## Public Surface

Import the main SDK from the package root:

```ts
import {
  EventStream,
  FiregridClient,
  FiregridClientLive,
  Operation,
  type FiregridClientConfig,
  type OperationState,
} from "@firegrid/client"
```

The root export provides:

- `FiregridClient`, the Effect service tag for the app-facing client.
- `FiregridClientLive(config)`, a Layer that wires the client to a stream URL.
- `Operation` and `EventStream`, descriptor builders re-exported for app code.
- `OperationHandle` and typed operation state/error types.
- client service methods: `send`, `result`, `call`, `observe`, `emit`, and
  `events`.

The browser-safe EventStream-only subpath is available when an application only
needs EventStream APIs:

```ts
import {
  EventStream,
  EventStreamClient,
  EventStreamClientLive,
} from "@firegrid/client/event-streams"
```

## Configuration

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

const ReviewDocument = Operation.define({
  name: "app.document.review",
  input: Schema.Struct({
    documentId: Schema.String,
  }),
  output: Schema.Struct({
    reviewed: Schema.Boolean,
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
    documentId: Schema.String,
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

  const handle = yield* client.send(ReviewDocument, {
    documentId: "doc-123",
  })

  const stateFiber = yield* client.observe(ReviewDocument, handle).pipe(
    Stream.runForEach((state) => Effect.log(state)),
    Effect.fork,
  )

  const output = yield* client.result(ReviewDocument, handle)
  yield* Fiber.interrupt(stateFiber)
  return output
})
```

`observe` emits `Pending`, `Completed`, `Failed`, or `Cancelled` states. The
public `Pending` state intentionally covers non-terminal work from the client
point of view. `result` resolves only after a runtime participant has handled
the operation and Firegrid has materialized a terminal run state. The client
does not execute the handler or author that terminal state.

## Request-Response Convenience

`call` is request-response sugar over `send` plus `result`:

```ts
const output = yield* client.call(ReviewDocument, {
  documentId: "doc-123",
})
```

Use `send` plus `observe` when the application needs progress UI or a durable
handle to store outside the current Effect.

## EventStream Rows

Use EventStream for lightweight caller-owned append-only events:

```ts
yield* client.emit(UiEvents, {
  type: "document.opened",
  documentId: "doc-123",
})

yield* client.events(UiEvents).pipe(
  Stream.runForEach((event) => Effect.log(event)),
)
```

Use EventPlane from `@firegrid/substrate/event-plane` inside runtime layers when
the domain needs primary-keyed state, materialized projections, or
projection-match evaluation. EventPlane is not the browser client surface.

## Projection Query Reads

Use the `@firegrid/client/projection-query` subpath when browser or edge code
needs read-only access to app-owned EventPlane projections through the client
package:

```ts
import {
  createProjectionQueryClient,
} from "@firegrid/client/projection-query"

const projections = createProjectionQueryClient({
  streamUrl: appConfig.firegridStreamUrl,
})

const widgets = projections.projectionFor(WidgetsPlane)

const liveList = widgets.observe(widgetListQuery)

const readyWidget = widgets.until(
  readyWidgetQuery,
  (row) => row !== undefined,
  { timeout: "10 seconds" },
)
```

Projection query handles are descriptor-scoped and read-only. They expose
cursorless `observe` and `until` for normal UI reads. Advanced callers can use
`snapshot` plus `stream(query, cursor)`, or `untilFrom(...)`, when they need to
control an explicit cursor. The surface does not expose raw StreamDB
collections, substrate kernel imports, runtime handlers, claims, completions, or
terminal run authority.

Current limitation: this MVP keeps cursors opaque and validates descriptor
ownership, but the underlying EventPlane projection service does not yet expose a
durable snapshot sequence boundary. Full no-gap retained replay semantics need a
lower-level EventPlane/StreamDB cursor boundary before `stream` can fully satisfy
`firegrid-projection-query.CURSOR_AND_REPLAY.*`.

## Focused Smoke Checks

The focused package checks are:

```sh
pnpm --filter @firegrid/client run typecheck
pnpm --filter @firegrid/client run test -- firegrid-operations
pnpm --filter @firegrid/client run test -- firegrid-event-streams
pnpm run test:pack:client
```

`firegrid-operations` covers operation `send`, `result`, `observe`, descriptor
decode, and authority-boundary guards. `firegrid-event-streams` covers
EventStream `emit` and `events`. `test:pack:client` packs `@firegrid/substrate`
and `@firegrid/client`, installs those local tarballs into a temporary external
consumer project, and type-checks the public root plus browser-safe
`event-streams` subpath. CI remains the authority for the complete repo matrix.

The examples above are intentionally client-only. They demonstrate the
production `FiregridClient` root and EventStream surface, while handler
installation, waiting primitives, durable authority, raw stream diagnostics, and
runtime startup stay in their own packages and runbooks.

## Boundaries

Client application code should stay on the public client surface. It should not
import or depend on:

- `@firegrid/runtime`;
- substrate kernel or control-plane internals;
- runtime handler registration APIs;
- RunWait or choreography services;
- claim, completion, or terminal-authority helpers;
- raw Durable Streams writers as the normal app API;
- lab-only paths or dev-server launchers.

If a client feature appears to need one of those surfaces, treat that as a
missing public API or spec gap rather than reaching through the package
boundary.
