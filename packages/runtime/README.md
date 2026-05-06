# @firegrid/runtime

`@firegrid/runtime` is the server-side package for running Firegrid operation
handlers, EventStream materializers, and stock subscriber loops. Application
entrypoints use it to compose the runtime graph they want and pass that graph to
`run({ connection, runtime })`.

In the broader Firegrid architecture, runtime code is the execution boundary
between typed app contracts and substrate-backed durable state:

```txt
application entrypoint
  -> @firegrid/runtime
  -> operation handlers, EventStream materializers, subscribers
  -> @firegrid/substrate public coordination surfaces
```

The runtime package does not include the browser/client SDK and does not own
product-specific adapter semantics. Applications provide their own descriptors,
handlers, subscriber choices, EventPlane layers, wait layers, and adapter
Layers explicitly.

## Public Surface

Import the runtime from the package root:

```ts
import {
  Firegrid,
  FiregridRuntime,
  FiregridRuntimeBoot,
  RuntimeContext,
  run,
  type FiregridRunOptions,
} from "@firegrid/runtime"
```

The root export provides:

- `run({ connection, runtime })`, the app-owned runtime process Effect.
- `Firegrid.handler(operation, handler)`, a Layer that installs a typed
  operation handler.
- `Firegrid.eventStream(descriptor, materialize)`, a Layer that materializes
  caller-owned EventStream events.
- `Firegrid.subscribers.timer`, `Firegrid.subscribers.scheduledWork`, and
  `Firegrid.subscribers.projectionMatch(...)`, explicit stock subscriber
  Layers.
- `Firegrid.composeRuntime({ handlers, subscribers, provide })`, a small helper
  for composing ordinary Effect Layers without hiding what the app installed.
- `RuntimeContext`, `FiregridRuntime`, and `FiregridRuntimeBoot` for runtime
  process wiring.

The published package also exposes the built `firegrid` and `fg` binaries from
the package manifest. Application integration code should prefer the typed
`run(...)` entrypoint unless a lane is specifically about runtime process
packaging or CLI behavior.

## Define An Operation Handler

Operations are schema descriptors shared with clients. Runtime handlers are
installed separately:

```ts
import { Operation } from "@firegrid/substrate"
import { Firegrid } from "@firegrid/runtime"
import { Effect, Schema } from "effect"

const SummarizeDocument = Operation.define({
  name: "example.document.summarize",
  input: Schema.Struct({
    documentId: Schema.String,
  }),
  output: Schema.Struct({
    summary: Schema.String,
  }),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
})

const summarizeHandler = Firegrid.handler(SummarizeDocument, (input) =>
  Effect.succeed({
    summary: `summary for ${input.documentId}`,
  }),
)
```

Returning a value completes the operation through Firegrid's runtime authority.
Failing with a value that matches the operation error schema reports a typed
operation failure to the client.

## Compose And Run

`Firegrid.composeRuntime(...)` keeps handler, subscriber, and provider choices
explicit while reducing repetitive Layer wiring:

```ts
import { run, Firegrid } from "@firegrid/runtime"
import {
  RunWait,
  triggerMatchersLayer,
} from "@firegrid/substrate"
import { EventPlane } from "@firegrid/substrate/event-plane"

const runtime = Firegrid.composeRuntime({
  handlers: [summarizeHandler],
  subscribers: [
    Firegrid.subscribers.timer,
    Firegrid.subscribers.scheduledWork,
  ],
  provide: [
    RunWait.layer({ streamUrl }),
    triggerMatchersLayer(matchers),
    EventPlane.layer(ApplicationPlane, { streamUrl }),
  ],
})

yield* run({
  connection: { streamUrl },
  runtime,
})
```

The helper returns an ordinary Effect Layer accepted by `run(...)`. It never
installs subscribers or providers implicitly; omitted lists stay omitted.

## EventStream Materializers

Use `Firegrid.eventStream(...)` when runtime code needs to react to
caller-owned EventStream events:

```ts
import { EventStream } from "@firegrid/substrate"
import { Firegrid } from "@firegrid/runtime"
import { Effect, Schema } from "effect"

const AuditEvents = EventStream.define({
  name: "example.audit.events",
  event: Schema.Struct({
    message: Schema.String,
  }),
})

const auditMaterializer = Firegrid.eventStream(AuditEvents, (event) =>
  Effect.log(event.message),
)
```

Materializers process typed EventStream events. Caller-owned durable state, if
needed, should be modeled with app-owned EventPlane schemas and runtime-provided
EventPlane layers.

## Boundaries

Runtime application code should stay on the public runtime and substrate
surfaces. It should not:

- import substrate kernel or control-plane internals;
- write raw terminal rows or synthesize terminal state;
- create a package edge from `@firegrid/runtime` to `@firegrid/client`;
- rely on hidden default subscribers;
- add product-specific permission, provider, session, transport, registry, or
  tool semantics to Firegrid packages;
- use launcher or dynamic-module behavior as an app integration shortcut.

If an integration needs behavior beyond the public runtime, substrate, and
EventPlane surfaces, write a spec/API proposal before implementing it.

## Focused Smoke Checks

Useful targeted checks for runtime package changes are:

```sh
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm run test:pack:runtime
```

`test:pack:runtime` packs `@firegrid/runtime` and its Firegrid package
dependencies into a temporary external consumer, then type-checks public root
usage and package metadata from the built artifacts. CI remains the authority
for the complete repository matrix.
