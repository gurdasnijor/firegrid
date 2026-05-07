# @firegrid/substrate

`@firegrid/substrate` provides Firegrid's shared descriptor and coordination
surface. It is the package that both clients and runtimes use for typed
contracts such as operations and EventStreams, plus server-side primitives such
as projection reads, work claims, and durable waits.

In the broader Firegrid architecture, substrate is the durable foundation below
the app-facing client and runtime packages:

```txt
@firegrid/client
  -> public descriptors and projection observation

@firegrid/runtime
  -> public descriptors, coordination primitives, EventPlane layers

@firegrid/substrate
  -> durable state contracts and server-side coordination APIs
```

The package intentionally separates app-facing public surfaces from internal
kernel/control-plane code. Application and downstream package examples should
use the root export plus documented subpaths only.

## Public Surface

The package root exports browser-safe descriptors and server-side coordination
services:

```ts
import {
  EventStream,
  Operation,
  OperationHandle,
  Projection,
  ProjectionLive,
  RunWait,
  triggerMatchersLayer,
} from "@firegrid/substrate"
```

The root export provides:

- `Operation`, `EventStream`, and `OperationHandle` descriptor values and
  helper types.
- `RunWait`, `RunWait.layer(...)`, `ProjectionMatchTrigger`, and
  `triggerMatchersLayer(...)` for runtime-side durable waits.
- `Projection` and `ProjectionLive` for read-model queries and observation.
- `Work`, `WorkClaim`, and related server-side coordination types for
  runtime-owned execution code.

Descriptor-only imports are also available from:

```ts
import { EventStream, Operation } from "@firegrid/substrate/descriptors"
```

Use `@firegrid/substrate/id-gen` when code needs the public ID generator
service, `@firegrid/substrate/event-plane` for app-owned stateful row families,
and `@firegrid/substrate/durable-clock` for installing the durable Clock layer.

## Operation And EventStream Descriptors

Descriptors are shared contract values. They contain stable names and Effect
Schema contracts; they do not contain client instances, runtime handlers,
stream URLs, or registration side effects.

```ts
import { EventStream, Operation } from "@firegrid/substrate"
import { Schema } from "effect"

const ProcessDocument = Operation.define({
  name: "example.document.process",
  input: Schema.Struct({
    documentId: Schema.String,
  }),
  output: Schema.Struct({
    status: Schema.Literal("processed"),
  }),
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
  }),
})

const DocumentEvents = EventStream.define({
  name: "example.document.events",
  event: Schema.Struct({
    documentId: Schema.String,
    message: Schema.String,
  }),
})
```

Clients use these descriptors to encode, send, observe, and decode typed
messages. Runtimes use the same descriptors to install handlers and
materializers.

## EventPlane

Use `@firegrid/substrate/event-plane` for app-owned stateful row families,
producer services, and projection services:

```ts
import { EventPlane } from "@firegrid/substrate/event-plane"
import { createStateSchema } from "@durable-streams/state"
import { Schema } from "effect"

const DocumentRow = Schema.Struct({
  documentId: Schema.String,
  status: Schema.String,
})

const ApplicationPlane = EventPlane.define({
  name: "example.application",
  state: createStateSchema({
    documents: {
      type: "example.application.document",
      primaryKey: "documentId",
      schema: Schema.standardSchemaV1(DocumentRow),
    },
  }),
})

const ApplicationPlaneLive = EventPlane.layer(ApplicationPlane, {
  streamUrl,
})
```

EventPlane is appropriate when runtime code needs primary-keyed domain rows,
materialized projection state, or projection-match evaluation. The row families
belong to the application or downstream package, not to Firegrid itself.

## Durable Clock

Use `@firegrid/substrate/durable-clock` when runtime code needs Effect's normal
time APIs to record durable wake-up intent before parking fibers:

```ts
import {
  makeDurableClockDispatcher,
  makeDurableStreamClockWakeupStore,
} from "@firegrid/substrate/durable-clock"
import { Duration, Effect } from "effect"

const store = makeDurableStreamClockWakeupStore({ streamUrl })
const dispatcher = makeDurableClockDispatcher({
  store,
  initialDurableTimeMs: Date.now(),
  scope: "runtime",
})

const program = Effect.sleep(Duration.seconds(5)).pipe(
  Effect.provide(dispatcher.layer),
)
```

The durable Clock subpath does not add Firegrid-specific `sleep`, `wait`,
`timeout`, retry, or schedule verbs. It installs a custom Effect `Clock` via
`Layer.setClock`, so ordinary `Effect.sleep`, timeout APIs, `Schedule`, and
Clock-backed `Stream` operators use the supplied wake-up store.

This first slice proves the Clock boundary and exposes an in-memory wake-up
store for deterministic tests plus a Durable Streams-backed store for
production-shaped restart validation. A recreated dispatcher pointed at the
same stream URL can discover and dispatch pending wake-up records, but the
Clock layer does not preserve in-memory Effect fibers across process death.
Cross-process continuation requires a runtime-owned re-dispatch or checkpoint
primitive above the Clock layer.

## RunWait And Projection Matching

`RunWait` lets runtime handlers suspend on durable wait primitives while
keeping terminalization inside the runtime authority path. Projection-match
waits are paired with explicit trigger matchers and an explicit runtime
subscriber:

```ts
import {
  ProjectionMatchTrigger,
  RunWait,
  triggerMatchersLayer,
} from "@firegrid/substrate"
import { Firegrid } from "@firegrid/runtime"

const trigger: ProjectionMatchTrigger = {
  _tag: "ProjectionMatch" as const,
  label: "document ready",
  projectionKey: "doc-123",
  matcherId: "example.document.ready",
}

const matchers = {
  "example.document.ready": matchApplicationProjection,
}

const runtime = Firegrid.composeRuntime({
  handlers: [documentHandler],
  subscribers: [
    Firegrid.subscribers.projectionMatch({
      evaluate: evaluateApplicationProjection,
    }),
  ],
  provide: [
    RunWait.layer({ streamUrl }),
    triggerMatchersLayer(matchers),
    ApplicationPlaneLive,
  ],
})
```

The application owns the trigger semantics and the EventPlane schema. Firegrid
provides the coordination mechanism.

## Boundaries

Application and downstream package code should use only the curated root and
documented public subpaths:

- `@firegrid/substrate`
- `@firegrid/substrate/descriptors`
- `@firegrid/substrate/event-plane`
- `@firegrid/substrate/durable-clock`
- `@firegrid/substrate/id-gen`

Do not treat substrate internals, raw durable row builders, claim/terminal
helpers, launcher behavior, or product-specific adapter vocabulary as public
API. If a scenario cannot be expressed through the public root, descriptors,
EventPlane, and runtime composition surfaces, that is a spec/API gap to report
before implementation.

## Focused Smoke Checks

Useful targeted checks for substrate package changes are:

```sh
pnpm --filter @firegrid/substrate run typecheck
pnpm --filter @firegrid/substrate run test
pnpm run test:pack:client
pnpm run test:pack:runtime
```

The pack smokes validate that external consumers can use substrate through the
published package artifacts alongside the client and runtime packages. CI
remains the authority for the complete repository matrix.
