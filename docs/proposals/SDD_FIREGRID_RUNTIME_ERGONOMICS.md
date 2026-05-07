# SDD: Firegrid Runtime Ergonomics

Date: 2026-05-07

Status: Proposal, pre-spec design draft

Future spec:
`features/firegrid/firegrid-runtime-ergonomics.feature.yaml`

Related specs:

- `features/firegrid/firegrid-platform-invariants.feature.yaml`
- `features/firegrid/firegrid-agent-runtime-substrate.feature.yaml`
- `features/firegrid/firegrid-client-api.feature.yaml`
- `features/firegrid/firegrid-client-projection-api.feature.yaml`
- `features/firegrid/firegrid-runtime-process.feature.yaml`
- `features/firegrid/client-event-plane-registration.feature.yaml`
- `features/firegrid/firegrid-event-streams.feature.yaml`
- `features/flamecast/flamecast-product-contract.feature.yaml`

## Purpose

Firegrid has enough durable mechanics to build a local Flamecast-shaped demo,
but the app-author path is too hard. The current integration docs need a
decision tree because the API asks basic app code to understand too many
substrate seams:

- runtime package locality;
- manual client Layer provisioning inside runtime composition;
- EventStream versus EventPlane selection;
- projection-query versus raw EventPlane projection reads;
- runtime materializers versus emitters;
- product dev topology;
- Durable Streams setup and stream URL propagation;
- which imports are allowed in browser, runtime, and shared descriptor files.

This is not just a documentation problem. The decision tree is a symptom that
Firegrid lacks an ergonomic application profile. This SDD proposes that
profile.

The goal is to make the basic demo boring:

```txt
define app contracts
declare stream graph
start runtime
call from UI
observe timeline and read models
refresh browser
continue
```

The product should not need topology files, direct Durable Streams calls,
runtime/client wiring tricks, fake provider output, or a cookbook full of
package-boundary caveats to prove that loop.

## Prior Art

### Restate

Restate's TypeScript service surface starts with one dominant authoring shape:

```ts
export const myService = restate.service({
  name: "MyService",
  handlers: {
    myHandler: async (ctx, input) => {
      return output
    },
  },
})

restate.serve({ services: [myService] })
```

Its client surface is similarly task-oriented:

```ts
const client = clients.connect({ url })
await client.serviceClient<MyService>({ name: "MyService" }).greet(input)
await client.serviceSendClient<MyService>({ name: "MyService" }).greet(input)
```

Design lessons for Firegrid:

- Handler code receives typed dependencies; it does not assemble low-level
  clients.
- Service definition, handler implementation, serving, and invocation are
  separate concepts but have obvious names.
- External clients are for code outside the runtime execution scope.
- If code is already running inside the runtime, typed runtime dependencies are
  provided by the runtime rather than manually constructed by app code.
- Idempotency, delayed sends, workflow attachment, and result retrieval are
  options on the invocation model, not separate app-authored substrates.

Restate's positional `ctx` parameter is idiomatic in non-Effect TypeScript.
Firegrid should take the service/client separation lesson without copying that
shape: Effect's requirements channel is the dependency vocabulary, and a
Stream-first Firegrid should prefer processors and typed services over
positional handler state.

References:

- https://docs.restate.dev/develop/ts/services
- https://docs.restate.dev/services/invocation/clients/typescript-sdk

### Electric Agents Runtime

Electric Agents Runtime, backed by Durable Streams State, exposes a single
entity authoring model:

```ts
defineEntity("assistant", {
  state: {
    status: {
      schema,
      type: "status",
      primaryKey: "key",
    },
  },

  async handler(ctx, wake) {
    ctx.db.actions.status_insert({
      row: { key: "current", value: "idle" },
    })

    ctx.useAgent({ systemPrompt, model, tools: [...ctx.electricTools] })
    await ctx.agent.run()
  },
})

const runtime = createRuntimeHandler({ baseUrl, serveEndpoint })
await runtime.registerTypes()
await runtime.onEnter(req, res)
```

Design lessons for Firegrid:

- The durable stream database is real, but app authors use `ctx.db` and
  generated actions instead of raw stream rows.
- One generated runtime environment carries state, spawn, observe, send, and
  agent helpers.
- Runtime hosting is one adapter call, not a bundler/plugin/topology decision.
- The public docs lead with the app experience, then explain the runtime.

Reference:

- https://github.com/electric-sql/electric/tree/main/packages/agents-runtime

### Durable Streams StreamDB

StreamDB has a clean path because it exposes one direct abstraction:

```ts
const schema = createStateSchema(...)
const db = createStreamDB({ streamOptions, state: schema })
await db.preload()
useLiveQuery((q) => q.from({ users: db.collections.users }))
```

Design lessons for Firegrid:

- The backbone can be durable streams without forcing the user to reason about
  every durable-stream-level concern in the first example.
- Schema definition, DB construction, queries, actions, and lifecycle are
  presented as a straight line.
- Footguns live in a "best practices" section, not in the primary path.

Reference:

- https://github.com/durable-streams/durable-streams/blob/main/docs/stream-db.md

### Durable Streams Protocol And State Protocol

Firegrid should align its substrate with upstream Durable Streams protocols
instead of continuing to invent parallel row envelopes, idempotency plumbing,
and projection materialization.

The Durable Streams base protocol owns the wire-level stream primitive:

- URL-addressable append-only byte streams;
- opaque, ordered offsets for catch-up and resume;
- HTTP create, append, close, delete, metadata, catch-up read, long-poll read,
  and SSE read operations;
- durable stream closure and fork semantics;
- idempotent producer behavior and HTTP caching/collapsing concerns.

The Durable Streams State Protocol owns the state-change vocabulary above that
stream primitive:

- JSON change messages with `type`, `key`, `headers.operation`, and `value`;
- `insert`, `update`, and `delete` operation semantics;
- control messages such as snapshot boundaries and reset;
- materialized state by applying change messages sequentially;
- Standard Schema validation while staying storage/query-engine agnostic.

Design lessons for Firegrid:

- Firegrid descriptors should define what messages mean, not invent a private
  wire format for how messages are stored.
- EventPlane-style row changes should be State Protocol messages where
  possible.
- Firegrid idempotency should use Durable Streams producer semantics where
  possible rather than maintaining parallel producer/key/fingerprint logic.
- Firegrid's substrate value should move to Effect Layers over the protocols:
  durable Clock, typed descriptors, processor scheduling, per-key state, and
  browser-safe query decoding.

Reference:

- https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md
- https://github.com/durable-streams/durable-streams/blob/main/packages/state/STATE-PROTOCOL.md
- https://electric-sql.com/blog/2025/12/23/durable-streams-0.1.0

### Effect Stream, Schedule, And Clock

Firegrid already uses Effect. Its app-facing observation APIs should therefore
lean into Effect's existing `Stream<A, E, R>` vocabulary instead of inventing a
parallel subscription and wait vocabulary.

Useful operations include:

- `Stream.tap(...)` for telemetry, logging, and audit hooks;
- `Stream.mapEffect(...)` with concurrency for processing streamed work through
  bounded side effects;
- `Stream.scan(...)` for folding timelines into UI state;
- `Stream.take`, `Stream.takeWhile`, and `Stream.takeUntil` for bounded
  observation;
- `Stream.fromSchedule(...)`, `Stream.tick(...)`, `Stream.schedule(...)`, and
  `Stream.timeout(...)` for time-driven and time-bounded observation;
- `Stream.toPull(...)`, `Stream.runForEach(...)`, and scoped consumption for
  host boundaries.

Effect also makes time an injectable service. `Clock.sleep(...)` is part of the
`Clock` service, and `TestClock` demonstrates that a runtime can replace
wall-clock time with logical time: sleeps semantically block fibers, time can
be advanced with `adjust` or `setTime`, and effects scheduled at or before the
new time are released in order. `Scheduler` is primarily about Effect runtime
task scheduling and fairness; the app-facing time integration point is `Clock`
plus Stream/Schedule composition.

The source-level substitution chain is the important part:

- `Clock` is a service tag with `currentTimeMillis`, `currentTimeNanos`,
  unsafe current-time accessors, and `sleep(duration)`.
- `Effect.sleep(...)` delegates to `Clock.sleep(...)`.
- Effect timeout operators race the user effect against `Effect.sleep(...)`.
- `ScheduleDriver.next(...)` reads `Clock.currentTimeMillis` and sleeps through
  `Effect.sleep(...)` between schedule intervals.
- `Stream.fromSchedule(...)` and `Stream.tick(...)` consume schedules, so their
  timing follows the active `Clock`.
- `Stream.debounce(...)`, `Stream.throttle(...)`, and Stream timeout operators
  call `Clock.sleep(...)`, `Clock.currentTimeMillis`, or Effect timeout
  operators internally.
- Effect's own `TestClock` tests assert that setting Clock time drives
  `DateTime.now` and that nanosecond accessors obey the Clock contract. A
  Firegrid Clock replacement must preserve those ordinary Effect expectations;
  it is not only a sleep queue.
- The documented `TestClock` testing pattern forks the sleeping effect, then
  advances time, then joins the fiber. A durable Firegrid Clock should preserve
  the same semantic blocking shape even though deadline storage is durable
  rather than in memory.

That means the ergonomic API does not need Firegrid-specific sleep, timeout,
retry, or schedule vocabulary. It needs Firegrid runtime Layers whose `Clock`
implementation has durable semantics.

Design lessons for Firegrid:

- Durable inputs should usually be exposed as `Stream`s.
- Firegrid should not define custom stream/operator vocabulary when standard
  Effect Stream operators already express the behavior.
- Stream is a public composition primitive, not an implementation detail.
- Firegrid-specific APIs should provide durable sources and runtime-owned
  persistence boundaries; Effect Stream should provide most observation and
  transformation vocabulary.
- Firegrid should provide durable `Clock` behavior for runtime processors where
  restart safety is required, not a parallel public wait API.
- Firegrid should not override Effect `Scheduler` for durable time. Scheduler
  controls fiber task ordering, priority, and yielding inside the executor;
  durable suspension belongs at the `Clock` and durable source boundary.

Reference:

- https://effect-ts.github.io/effect/effect/Stream.ts.html
- https://github.com/Effect-TS/effect/blob/54e61b3e08ab30a52fb20eba3104a83b99f443fa/packages/effect/src/Clock.ts#L69
- https://github.com/Effect-TS/effect/blob/54e61b3e08ab30a52fb20eba3104a83b99f443fa/packages/effect/src/TestClock.ts#L131
- https://github.com/Effect-TS/effect/blob/54e61b3e08ab30a52fb20eba3104a83b99f443fa/packages/effect/src/Effect.ts
- https://github.com/Effect-TS/effect/blob/54e61b3e08ab30a52fb20eba3104a83b99f443fa/packages/effect/src/Stream.ts
- https://github.com/Effect-TS/effect/blob/54e61b3e08ab30a52fb20eba3104a83b99f443fa/packages/effect/src/Schedule.ts
- https://github.com/Effect-TS/effect/blob/54e61b3e08ab30a52fb20eba3104a83b99f443fa/packages/effect/src/Scheduler.ts
- https://github.com/Effect-TS/effect/blob/54e61b3e08ab30a52fb20eba3104a83b99f443fa/packages/effect/test/TestClock.test.ts

## Problem Statement

The current Firegrid API is mechanically correct but ergonomically incomplete.
The following footguns made a basic Flamecast LT-02 demo hard:

1. **No ergonomic stream graph.** App code is forced into operation handlers
   and producer services instead of declaring durable streams, processors, and
   projections.
2. **Manual runtime client provisioning.** Handler-side `client.emit(...)`
   works only after the app manually provides `FiregridClientLive(...)` in
   `Firegrid.composeRuntime({ provide })`.
3. **Emitter and materializer naming collision.** `Firegrid.eventStream(...)`
   sounds like an EventStream API, but it is a runtime materializer, not an
   emitter.
4. **Read-model ceremony.** Browser list/detail state requires understanding
   app-owned EventPlane descriptors and `@firegrid/client/projection-query`.
5. **Custom substrate envelope gravity.** Firegrid has its own row envelopes,
   producer identity, idempotency, and projection materialization paths where
   Durable Streams and State Protocol already provide standard primitives.
6. **Topology leaks into the browser.** The failed chassis used generated
   `public/topology.json` as a browser/runtime contract.
7. **Direct Durable Streams temptation.** App code reached for
   `@durable-streams/client` to create/head streams because no app-level local
   dev host contract existed.
8. **Docs compensate with review rules.** Pattern docs explain what not to
   import instead of giving one default happy path.
9. **Fake success is too easy.** The demo could fabricate provider output and
   still look green because the API did not force an explicit configured
   adapter boundary or typed setup error.

These are API design issues. Better docs can reduce confusion, but the target
should be an API that does not require a decision matrix.

## Design Principles

### One Default Path

For a product app with a browser UI and a Node runtime, the default should be:

```txt
shared descriptors
  -> browser client
  -> runtime app
  -> durable stream graph
  -> durable events/read models
```

Alternative paths may exist, but the docs and types should make the default
path obvious.

### Stream-First Application Graph

Runtime app authoring should be a durable Stream graph, not handlers plus
imperative producer APIs. The app path should not require `ctx`, handler
facades, `RunWait`, `PlaneProducer`, or app-authored EventStream sink calls.

The public unit of authoring should be closer to:

```ts
const turnEvents = SessionTurn.stream.pipe(
  Stream.flatMap((input) =>
    Stream.make(userMessage(input)).pipe(
      Stream.concat(
        AgentAdapter.respond(input).pipe(
          Stream.map((token) => assistantToken(input, token)),
        ),
      ),
      Stream.concat(Stream.make(turnCompleted(input))),
      Stream.catchAll((error) => Stream.make(turnFailed(input, error))),
    ),
  ),
)

const sessions = turnEvents.pipe(
  Stream.scan(SessionView.empty, SessionView.reduce),
)

export const FlamecastRuntime = FlamecastApp.runtime({
  streams: [
    SessionTimeline.from(turnEvents),
  ],
  projections: [
    SessionsView.from(sessions),
  ],
})
```

Names are provisional. The point is the shape: the app declares durable input
streams, transformations, and projections. It does not imperatively append
timeline rows or upsert read-model rows from inside runtime app code. The runtime
owns durable draining, output persistence, lifecycle facts, cursor checkpoints,
Clock semantics, and restart behavior.

Before, a realistic LT-02-shaped flow has to compose low-level runtime pieces
and author every durable fact imperatively:

```ts
Firegrid.composeRuntime({
  subscribers: [Firegrid.subscribers.projectionMatch({ evaluate })],
  handlers: [
    Firegrid.handler(SessionTurn, (input) =>
      Effect.gen(function* () {
        const producer = yield* SessionPlane.Producer
        const wait = yield* RunWait
        yield* producer.emit(sessionRows.userMessage(input))
        yield* producer.emit(sessionRows.status(input.sessionId, "running"))
        const output = yield* AgentAdapter.run(input)
        yield* producer.emit(sessionRows.assistantMessage(input, output))
        yield* wait.for(input.visibleInSessionList)
        return { sessionId: input.sessionId, turnId: input.turnId }
      }),
    ),
  ],
  provide: [EventPlane.layer(SessionPlane, { streamUrl }), RunWait.layer({ streamUrl })],
})
```

After, the same app behavior is a stream processor and a derived projection:

```ts
const turnEvents = SessionTurn.stream.pipe(
  Stream.flatMap((input) =>
    Stream.make(userMessage(input)).pipe(
      Stream.concat(
        AgentAdapter.respond(input).pipe(
          Stream.map((token) => assistantToken(input, token)),
        ),
      ),
      Stream.concat(Stream.make(turnCompleted(input))),
      Stream.catchAll((error) => Stream.make(turnFailed(input, error))),
    )
  ),
)
```

No explicit `timeline.emit(...)`, no `sessions.upsert(...)`, and no
`RunWait.for(...)` appear in the app-authored path. Session list state is
derived:

```ts
const sessions = turnEvents.pipe(
  Stream.scan(SessionView.empty, SessionView.reduce),
)
```

The processor may still call adapters through Effect requirements, and those
adapter calls may stream output:

```ts
const assistantTokens = SessionTurn.stream.pipe(
  Stream.flatMap((input) =>
    AgentAdapter.respond(input).pipe(
      Stream.map((token) => assistantToken(input, token)),
    ),
  ),
)
```

The key distinction is that the app authors a stream transformation. The
runtime persists the stream output and derives lifecycle/read models from the
graph. App code does not imperatively decide which durable row to append next.

The runtime may lower this graph to existing substrate rows in the first
implementation, but that lowering is not the app API. This is the line that
prevents a "producer pattern with better names" from sneaking back in.

The app graph should provide:

- typed ingress streams for commands, external events, and schedules;
- typed stream processors for adapter calls and domain transformations;
- projections/read models derived from streams through folds such as
  `Stream.scan`;
- operation lifecycle as a runtime-owned projection of processor execution;
- a durable Clock Layer for time-driven streams and timeouts;
- configured adapter Layers as Effect requirements of processors.

`ctx` disappears in this model. "Handler" may remain as a compatibility
lowering term inside `@firegrid/runtime`, but it is not the canonical app
authoring primitive.

### Stream-First Surface

Firegrid's substrate is a durable log. The ergonomic API should expose that log
and its projections as typed Effect Streams wherever the caller is observing
durable inputs.

The default read/input surfaces should therefore be Stream-shaped:

```ts
SessionEvents.stream
// Stream<SessionEvent, EventReadError>

SessionsPlane.query(bySessionId(sessionId))
// Stream<SessionRow | undefined, ProjectionReadError>

Operation.lifecycle(handle)
// Stream<OperationState<typeof SessionTurn>, OperationReadError>

client.events(SessionEvents)
// Stream<SessionEvent, EventReadError>

client.query(SessionsPlane, listSessions)
// Stream<ReadonlyArray<SessionRow>, ProjectionReadError>
```

Consequences:

- telemetry and dev logging are `Stream.tap(...)`, not Firegrid-specific hooks;
- timeline folding is `Stream.scan(...)`, not a bespoke Firegrid list API;
- "wait until visible" in browser/server code is `Stream.takeUntil(...)` or
  `Stream.runHead(...)` over a durable source, not a new query primitive;
- periodic and deadline-driven work is `Stream.fromSchedule(...)`,
  `Stream.tick(...)`, `Stream.schedule(...)`, `Stream.timeout(...)`, or
  `Clock.sleep(...)` under an app runtime-provided `Clock`, not
  `ctx.wait.sleep(...)`;
- bounded processing is `Stream.mapEffect(..., { concurrency })`, not a custom
  subscriber DSL;
- host adapters can consume streams through `Stream.toPull(...)`,
  `Stream.runForEach(...)`, or ordinary scoped Effect programs.

Firegrid should not introduce a Firegrid-specific stream type, subscription
protocol, or operator vocabulary. Its job is to expose durable typed sources
and runtime-owned persistence boundaries; Effect Stream supplies the operator
vocabulary.

This should be enforceable in review:

- Public Firegrid APIs that observe durable inputs return
  `Stream<A, E, R>`. Returning `AsyncIterable`, callback registration,
  `Subject`, or a Firegrid-specific subscription type is a regression.
- Public Firegrid APIs do not export operators with the same shape as existing
  Stream operators such as `tap`, `map`, `scan`, `take`, `takeUntil`,
  `timeout`, `mapEffect`, or `filter`.
- Public Firegrid APIs do not export new wait, timeout, sleep, retry, or
  schedule verbs unless the proposal proves that no `Effect.*`, `Stream.*`,
  or `Schedule.*` composition over Firegrid's Clock Layer expresses the same
  behavior.

Stream-first is also a correctness boundary. A compound "wait until projection
contains X" API implemented as `snapshot()` followed by `stream(cursor)` needs
the substrate to expose a no-gap cursor boundary to avoid dropped or duplicated
events. The same behavior expressed as one durable Stream plus
`Stream.takeUntil(...)` has no snapshot-then-stream race because there is no
compound read.

There is one important boundary: restart safety is a property of the source and
runtime Layer, not of the terminal Stream operator. A `Stream` built over the
live wall clock is process-local. A `Stream` built over a Firegrid durable
source, or an Effect program running under a Firegrid durable Clock, can be
restart-safe because Firegrid owns the cursor, deadline, and ready-work
mechanics below the Effect API.

Put differently:

- **Observation waits** are terminal operations over durable Stream sources.
- **Time waits** are `Clock.sleep(...)` or Stream/Schedule composition under
  the runtime-provided Clock.
- **RunWait/substrate mechanics**, if still required, are implementation
  details used to implement durable sources or the runtime Clock.
- **Scheduler** is not the extension point for durable time. It should remain
  Effect's executor scheduling concern unless a separate performance spec
  proves otherwise.
- Firegrid should not add `wait.until(...)` or `wait.sleep(...)` as separate
  public verbs when Effect already has the vocabulary and the missing piece is
  the Layer implementation.

### Durable Clock Boundary

The likely Firegrid-specific primitive is a runtime-provided `Clock`
implementation, not a handler `wait` facade.

Default production semantics should be durable wall-clock time:

- `Clock.currentTimeMillis` and `DateTime.now` report wall-clock time from the
  runtime host's configured time source;
- `Clock.sleep`, `Effect.timeout`, `Schedule.spaced`,
  `Schedule.exponential`, `Stream.tick`, and `Stream.timeout` use real elapsed
  time;
- sleeping deadlines are persisted so processor suspension survives process
  death;
- event-time behavior, where time advances only with durable log or replay
  progress, is an explicit alternate Layer for tests or specialized replay
  workflows.

Durable wall-clock is the conservative default because it matches ordinary
Effect expectations for production code. It makes `Effect.timeout(work,
"5 minutes")` mean five real minutes while still allowing Firegrid to persist
the deadline and resume or interrupt work after restart. Event-time is useful,
but making it the default would surprise processors whose retries, adapter
timeouts, or user-facing deadlines are meant to track real elapsed time.

Candidate responsibilities:

- implement the base Effect `Clock` contract;
- define the runtime's durable current-time source;
- persist sleeping deadlines so they survive process death;
- semantically block sleeping fibers until durable time reaches their
  scheduled deadline;
- release all sleeps scheduled at or before the current time in order;
- arrange ready-work/resume mechanics when durable time reaches a deadline;
- preserve Effect cancellation/interruption semantics for abandoned sleeps;
- install through normal Effect Layer wiring, analogous to `TestClock.live`
  using scoped clock replacement;
- preserve DateTime/current-time and nanosecond accessor behavior expected by
  Effect's Clock contract;
- expose durable-specific inspection or administration only outside the app
  processor happy path.

Open design question: whether Firegrid needs a public `FiregridDurableClock`
service for tests/admin, or whether the runtime installs the Clock privately
and product code only sees ordinary `Clock`, `Effect.sleep`, `Effect.timeout`,
`Schedule`, and `Stream` APIs.

### Substrate Implication

Going all the way Stream-first likely means `packages/substrate` should be
re-centered around durable stream processing, not app-owned run handlers and
producer facades.

The current substrate has useful machinery: durable rows, retained folds,
ready-work, completions, claims, EventStream envelopes, EventPlane state, and
RunWait. The problem is that those mechanics are exposed in the app path as
authoring concepts. That is what made the basic demo hard.

The stronger substrate direction is:

- **DurableStreamSource**: typed retained input streams with cursor-aware replay.
- **DurableProcessor**: a named stream transformation with checkpointed input
  cursors, persisted output facts, configured Effect requirements, and durable
  Clock semantics.
- **DurableProjection**: a fold over one or more durable streams, exposed as
  `Stream<A, E, R>` for live reads and reconnect/replay.
- **DurableLifecycle**: runtime-owned facts derived from processor execution,
  not app-authored terminal rows.
- **DurableAdapterCall**: a policy for effectful adapter calls inside
  processors, including idempotency and output persistence at the input cursor
  boundary.

Existing Run/Completion/RunWait/EventPlane machinery can be an implementation
target for the first slice, but it should not remain the conceptual center of
the app API. If the lowering becomes more complex than the processor model, that
is evidence that `packages/substrate` should be refactored around these
first-class primitives.

Layer ownership should be explicit:

| Layer | Owner | Role |
|---|---|---|
| HTTP transport, offsets, idempotent producers, live reads, closure, caching | `@durable-streams/server`, `@durable-streams/client` | Durable byte-stream protocol |
| Insert/update/delete/control message format and materialization rules | `@durable-streams/state` | Standard state synchronization protocol |
| Typed operation, event, plane, lifecycle, and query descriptors | `@firegrid/descriptors` | Browser-safe meaning and schema layer |
| Durable Clock, per-key state, processor scheduling, checkpoints | `@firegrid/substrate` | Effect service implementations over Durable Streams + State Protocol |
| App graph composition and runtime hosting | `@firegrid/runtime` | `FiregridApp.define(...)`, graph installation, adapter Layers |
| Browser facade | `@firegrid/client` | Stream-shaped calls, lifecycle, events, and queries over descriptors |

The middle layer should shrink: custom envelopes, parallel idempotency, and
hand-rolled wait verbs either move down into upstream protocols or up into thin
typed descriptors and Effect Layers.

### Product Semantics Stay Downstream

The ergonomic layer must not add Flamecast, provider, prompt, tool, sandbox,
permission, WorkOS, Standard Webhooks, or model vocabulary to Firegrid packages.
It should make generic durable mechanics easy while product packages retain
their domain schemas.

### Footguns Become Unrepresentable Or Boring

The target API should make these difficult or unnecessary:

- browser imports of `@firegrid/runtime`;
- browser imports of `@firegrid/substrate/kernel`;
- runtime code using generated browser-public topology files;
- app code creating/head-ing streams with `@durable-streams/client`;
- producer helpers constructing `FiregridClientLive` per call;
- fake terminal rows outside runtime-owned lifecycle;
- fake provider success without a configured adapter.

## Proposed Shape

### Application Definition

Introduce a product-neutral app definition helper on an approved Firegrid
surface. Names are provisional.

```ts
import { FiregridApp, Operation, EventStream, EventPlane } from "@firegrid/descriptors"

export const FlamecastApp = FiregridApp.define({
  name: "flamecast.local",
  operations: {
    SessionTurn,
  },
  eventStreams: {
    SessionEvents,
  },
  planes: {
    SessionsPlane,
  },
})
```

This definition is product-neutral. It does not register handlers globally and
does not start a runtime. It gives the runtime and browser a shared contract
for descriptors.

### Runtime Definition

Runtime authoring should install one app stream graph, not manual Layer
plumbing or handler registration.

```ts
export const FlamecastRuntime = FlamecastApp.runtime({
  ingress: [SessionTurn],
  streams: [
    SessionTimeline.from(turnEvents),
  ],
  projections: [
    SessionsView.from(sessions),
  ],
  adapters: [
    LocalAgentAdapter.layer(config),
  ],
})
```

Under the hood, this may still lower to:

- `Firegrid.composeRuntime`;
- `Firegrid.handler`;
- `EventPlane.layer`;
- `FiregridClientLive`;
- `RunWait.layer` or a runtime-provided durable `Clock` implementation;
- explicit stock subscribers.

The important ergonomic point is that the app author sees one runtime profile.
That profile installs durable stream processors and projections through
ordinary Effect environment/layer composition. It does not require app authors
to register operation handlers, pass a monolithic context object, or author
durable rows imperatively.

### Runtime Entrypoint

The runtime entrypoint should start from app configuration, not browser-visible
generated files.

```ts
await FlamecastRuntime.run({
  streamUrl: config.firegrid.streamUrl,
  runtimeId: config.runtimeId,
})
```

This proposal does not require Firegrid to launch Durable Streams. It requires
the app/runtime API to make stream configuration a runtime-host concern rather
than a browser-discovered topology artifact.

### Browser Client

Browser code should get a configured product client once.

```ts
const client = FlamecastApp.client({
  streamUrl: config.firegrid.streamUrl,
})

await client.call(SessionTurn, input)

client.events(SessionEvents).pipe(...)

client.query(SessionsPlane, (q) =>
  q
    .from({ s: q.collection("sessions") })
    .orderBy(({ s }) => s.updatedAt, "desc")
    .select(({ s }) => s),
)
```

The implementation may delegate to existing `@firegrid/client` and
`@firegrid/client/projection-query` surfaces. The app-facing shape should
avoid forcing the browser author to know which lower-level package hosts each
mechanic.

### Processor Environment

The central ergonomic win is a typed processor environment with no `ctx`
parameter and no app-owned producer service. Processor metadata is available as
stream element metadata or through a narrow Effect service such as
`ProcessorExecution`; adding new metadata requires changing the spec and type
instead of casually growing a positional argument.

Candidate metadata service:

```ts
class ProcessorExecution extends Context.Tag("firegrid/ProcessorExecution")<
  ProcessorExecution,
  {
    readonly runtimeId: string
    readonly processorId: string
    readonly inputCursor: string
  }
>() {}
```

The exact type shape should follow local Effect conventions. The acceptance
criterion is simpler: a processor consumes durable Stream inputs, calls
configured adapters, produces typed Stream outputs, derives read models through
projections, and uses Effect time APIs under the runtime Clock without
constructing transport Layers or producer services in app code.

The environment should make the stream/sink distinction clear:

- app code authors Stream values and transformations;
- runtime code persists processor output as durable facts;
- projection queries and lifecycle observations are durable Stream sources;
- processor time is provided through the Effect `Clock` service, with Firegrid
  responsible for durable wall-clock semantics by default.

## Required API Outcomes

The ergonomics spec should eventually require:

1. A basic app can define an operation, event stream, read model, runtime
   stream graph, browser send, browser timeline, and browser list without importing
   `@firegrid/substrate/kernel`, `@durable-streams/client`, or
   `@firegrid/runtime` in browser code.
2. App-authored runtime code declares typed Stream processors, not
   `Firegrid.handler(...)` functions.
3. App-authored runtime code derives read models from streams, not manual
   `PlaneProducer` writes or read-model upserts.
4. The runtime materializer API is named so it cannot be confused with
   EventStream emit.
5. Browser list/read-model examples use `client.query(...)` returning the
   projection-query Stream shape, not a decision between raw EventPlane
   projection and client projection-query.
6. Runtime entrypoints accept app runtime config and do not write
   browser-public topology files.
7. Missing provider/adapter configuration becomes a typed product-owned
   operation failure or setup error, not fake successful output.
8. The default docs can be linear and short; ACID traceability lives below the
   primary path.
9. Scenarios exercise the same ergonomic client/runtime/substrate path that an
   app author uses; bare row emitters are reserved for low-level substrate
   protocol tests.
10. Durable event, projection, operation-lifecycle, and query observations are
    exposed as `Stream<A, E, R>` rather than Firegrid-specific subscription
    types.
11. Firegrid does not introduce public operators that duplicate obvious Effect
    Stream operators such as `tap`, `scan`, `takeUntil`, `timeout`, or
    `mapEffect`.
12. Processor time and deadline behavior uses Effect `Clock`/Stream/Schedule
    APIs, with restart safety supplied by Firegrid's runtime Layer rather than
    public `wait` helpers.
13. App-authored runtime code does not receive a public `ctx` parameter;
    runtime metadata is available through typed stream metadata or an Effect
    service such as `ProcessorExecution`.
14. Firegrid app-owned state changes use Durable Streams State Protocol
    insert/update/delete/control messages unless a feature spec proves a
    Firegrid-specific row family is required.
15. Firegrid idempotent writes use Durable Streams producer semantics where
    possible rather than a parallel Firegrid producer/key/fingerprint protocol.

## Scenario Quality Bar

The current `scenarios/firegrid` package is useful for validating low-level
durable row shapes, but it is too easy for scenarios to become contrived:

```txt
emit durable rows
inspect rebuilt projection
declare success
```

That style proves part of the substrate. It does not prove the product
integration path that made LT-02 hard:

```txt
client sends typed operation
runtime processes operation through public stream graph API
processor output becomes app-owned EventStream facts
projections derive read-model state from those facts
client observes lifecycle, timeline, and read model through public client APIs
```

The ergonomics spec should divide scenarios into two categories.

### Substrate Protocol Scenarios

These may remain row-emitter based when the target behavior is the durable row
protocol itself:

- row schema compatibility;
- projection rebuild from retained records;
- terminal first-valid-wins folds;
- kernel-level subscriber scans;
- migration or retention edge cases.

They should be clearly labeled as substrate protocol scenarios and should not
be used as evidence that the app-facing API is ergonomic.

### App-Path Scenarios

These should be the default for runtime/client ergonomics work. They must use
the same public surfaces a product demo would use:

- `@firegrid/client` for `send`, `observe`, `result`, `emit`, `events`, and
  projection-query reads;
- `@firegrid/runtime` for `run(...)`, stream graph registration, and runtime
  composition;
- approved descriptor surfaces for shared operation, EventStream, and
  EventPlane definitions;
- no `@firegrid/substrate/kernel` imports in app-authored scenario code;
- no direct `@durable-streams/client` stream creation or raw app writes in the
  product path, except in test harness setup that is clearly outside the app
  code under test.

An app-path scenario should fail if the ergonomic API regresses back to manual
Layer plumbing or raw row writes.

For the first Flamecast-shaped proof, the scenario should exercise:

1. browser/client sends a typed session-turn operation;
2. Node runtime processor receives typed Stream input and produces a user
   timeline event as stream output;
3. processor uses a configured adapter boundary or returns typed
   adapter-not-configured failure;
4. processor produces assistant/error timeline events and the session read
   model is derived from those events;
5. client observes operation lifecycle as a Stream;
6. client replays timeline through EventStream Stream APIs;
7. client reads session list through projection-query Stream APIs;
8. refresh/reconnect is modeled by constructing a new client and reading from
   durable state.

This is the same bar that Restate and Electric-style examples clear: their
examples prove the public programming model, not just the underlying log
format.

## Candidate Spec Components

The future `firegrid-runtime-ergonomics.feature.yaml` should likely include:

### APP_PROFILE

- app definition collects product-owned descriptors without global mutable
  registration;
- app definition is product-neutral and does not introduce product row families;
- app definition can produce runtime and browser/client helpers over existing
  public Firegrid surfaces.

### DESCRIPTORS

- operation, EventStream, EventPlane, lifecycle, and query descriptors live in
  a browser-safe descriptor package;
- descriptors define schema, message meaning, ownership, partitioning, and
  projection/query contracts;
- descriptors do not own HTTP transport, stream offsets, idempotent producer
  semantics, or State Protocol wire format.

### STATE_PROTOCOL_ALIGNMENT

- app-owned state changes use Durable Streams State Protocol
  insert/update/delete/control messages by default;
- Firegrid-specific durable row families require a feature-spec justification
  that State Protocol cannot express the needed behavior;
- custom Firegrid envelopes are descriptor-level payloads inside State Protocol
  values when domain meaning is needed, not a replacement for State Protocol
  message shape;
- Firegrid producer idempotency uses Durable Streams producer semantics where
  possible;
- browser and runtime state materialization delegates to `@durable-streams/state`
  where possible before adding Firegrid-owned projection code.

### STREAM_PROCESSORS

- app-authored runtime code declares typed Stream processors from durable input
  streams to typed output streams;
- capabilities are provided once at runtime composition;
- processors can require configured adapter services and the durable Clock
  through ordinary Effect environment/layer composition;
- processor output is persisted by the runtime; app code does not call
  `PlaneProducer`, EventStream sink services, `FiregridClientLive`, or raw
  transport Layers to emit app-owned rows;
- projections/read models are derived from Stream processors rather than
  manually upserted from runtime code;
- the processor environment does not expose claim, completion, terminal,
  RunWait, or kernel authority;
- runtime metadata is exposed through typed stream metadata or a narrow Effect
  service, not a positional `ctx` parameter.

### STREAM_FIRST_SURFACE

- durable event observation, projection observation, operation lifecycle, and
  query reads expose Effect Stream values;
- public durable observation APIs must not return `AsyncIterable`,
  callback-registration handles, `Subject`, or Firegrid-specific subscription
  types;
- Firegrid does not define a custom public stream type or duplicate standard
  Effect Stream operator vocabulary such as `tap`, `map`, `scan`, `take`,
  `takeUntil`, `timeout`, `mapEffect`, or `filter`;
- Firegrid-specific APIs provide durable typed sources and runtime-owned
  persistence boundaries;
- time/deadline behavior uses Effect `Clock`, `Schedule`, and Stream APIs;
- Firegrid does not add public wait, timeout, sleep, retry, or schedule verbs
  unless a future spec proves that ordinary Effect/Stream/Schedule composition
  over Firegrid's Clock Layer cannot express the behavior;
- any substrate-backed wait mechanics remain internal implementation details of
  durable sources or the runtime-provided Clock.

### DURABLE_CLOCK

- the default runtime Clock is durable wall-clock, not event-time;
- `Clock.currentTimeMillis`, `Clock.currentTimeNanos`, and `DateTime.now`
  remain coherent with the configured time source;
- sleeps semantically block until their durable deadline and all sleeps due at
  or before the current time are released in order;
- `Clock.sleep(...)` is implemented as a durable scheduled append plus
  long-poll/read resumption over Durable Streams, not a separate timer service
  or public Firegrid wait API;
- `Effect.sleep`, `Effect.timeout`, `Schedule`, and Stream timing operators
  inherit this Clock behavior without Firegrid-specific wrappers;
- event-time behavior, if provided, is an explicit alternate Layer rather than
  the default production runtime Clock.

### RUNTIME_ENTRYPOINT

- app runtime entrypoints run in Node-tier hosts;
- runtime entry receives stream URL and runtime identity at the host boundary;
- runtime entry does not generate browser-public topology files;
- Firegrid does not need to own Durable Streams dev-server lifecycle unless a
  separate spec reopens that decision.

### CLIENT_ERGONOMICS

- app browser client exposes send/call/observe/result/events/query over
  descriptors;
- `client.query(...)` is the default read-model path and returns the
  projection-query Stream shape without making raw EventPlane projection reads
  a parallel browser decision;
- `events`, `observe`, and `query` return Effect Stream observations;
- browser client does not import runtime, kernel, or Node-only modules.

### NAMING

- EventStream emitter and EventStream materializer names are distinct;
- old confusing names, if retained, are documented as compatibility aliases
  with deprecation guidance.

### ADAPTER_BOUNDARY

- app adapters are provided as product-owned runtime Layers;
- missing adapters produce typed setup errors or product-owned operation
  failures;
- Firegrid does not define provider names, model names, credentials, or
  provider success semantics.

### DEMO_ACCEPTANCE

- a basic Flamecast-local demo can start a session, produce user and assistant
  timeline events from a real adapter-backed Stream processor, show a session
  list derived from those events, refresh, and send a follow-up through the
  default ergonomic path;
- no topology JSON, direct Durable Streams app seam, fake terminal rows, or fake
  successful provider output is used.

### SCENARIO_DISCIPLINE

- scenario suites distinguish substrate protocol tests from app-path tests;
- app-path scenarios use public client and runtime APIs end-to-end;
- app-path scenarios prove timeline, read-model, operation lifecycle, and
  reconnect behavior through Stream-shaped public APIs a product demo uses;
- app-path scenarios do not author durable rows through handler bodies,
  `PlaneProducer`, RunWait, or EventStream sink services;
- bare stream emitters cannot be the only evidence for an ergonomic runtime
  feature.

### STREAM_SCENARIOS

- app-path scenarios use `Stream.tap`, `Stream.scan`, `Stream.takeUntil`, or
  equivalent Effect Stream composition to prove the public programming model;
- app-path scenarios avoid bespoke Firegrid subscription helpers unless the
  helper exists only to create a durable Stream source;
- no-gap replay scenarios test the durable source boundary rather than
  reimplementing wait logic outside Stream composition;
- stream processor scenarios prove that output persistence and read-model
  derivation are runtime responsibilities, not imperative app writes;
- time/deadline scenarios use `Clock.sleep(...)`, `Stream.fromSchedule(...)`,
  `Stream.tick(...)`, `Stream.schedule(...)`, or `Stream.timeout(...)` under the
  app runtime Layer, not Firegrid-specific wait verbs.

## Non-Goals

This proposal does not require:

- Firegrid to adopt Flamecast session/provider/prompt semantics;
- Firegrid to start Durable Streams servers;
- Firegrid to own Durable Streams HTTP transport, offsets, idempotent producer
  protocol, CDN caching behavior, or State Protocol message format;
- Firegrid to own WorkOS, BYOK, provider credentials, Standard Webhooks, or
  sandbox lifecycle;
- React hooks or framework adapters in the first slice;
- a Firegrid-specific Stream replacement or operator vocabulary;
- Restate/Temporal-style deterministic workflow replay in the first slice;
- hiding Acai specs or removing ACID traceability from tests/review.

## Spike Plan

These spikes should run before the SDD is promoted to a feature spec. They are
cheap validation work for the substrate direction. The durable Clock dispatch
spike runs first because it validates whether Effect's existing time vocabulary
can replace Firegrid-owned wait, sleep, timeout, and schedule APIs.

1. **Durable Clock dispatch and resume.** Implement a scratch Clock Layer where
   `Clock.sleep(duration)` records a wake-up in a durable timer stream, parks
   the calling fiber, and resumes it when a dispatcher observes the wake-up as
   due. Exercise `Effect.sleep`, `Effect.timeout`, `Schedule.exponential`, and a
   Clock-backed Stream operator under this Layer. Kill/restart while a sleep is
   pending and verify the restarted dispatcher resumes from the durable record.
   This spike must not override Effect `Scheduler` or introduce Firegrid
   wait/sleep/timeout wrappers.
2. **Firegrid-to-State Protocol mapping audit.** Do not retest
   `@durable-streams/state`; upstream owns materialization behavior. Map the
   current Firegrid descriptor and row families onto State Protocol
   `type`/`key`/`headers.operation`/`value` messages. In a scratch adapter,
   encode representative Firegrid rows into State Protocol-shaped messages and
   decode them back to Firegrid descriptor types. The output is a compatibility
   table: maps cleanly, maps with descriptor payloads, requires a Firegrid
   extension, or should be deleted/refactored.
3. **Idempotent producer collapse.** Replace Firegrid producer idempotency
   plumbing in one narrow path with Durable Streams producer semantics, then run
   the duplicate/conflict scenarios.
4. **Per-key state via descriptor partition.** Add `partitionKey` to one
   EventStream descriptor and implement a processor that maintains durable
   per-key state, such as a per-session counter, across restart.
5. **Operation lifecycle as a derived stream.** Model `client.call(...)` as an
   append to an operation stream, processor output as lifecycle messages on
   that stream, and browser resolution as long-polling for the terminal
   lifecycle message. No RunWait or separate lifecycle substrate in the app
   path.

If these spikes produce clean compatibility results, the future feature spec
should define Firegrid's primitives as typed descriptors over Durable Streams +
State Protocol. If one fails, the failure should identify the specific place
where Firegrid needs a real substrate primitive rather than a wrapper.

## Spike Results

### Durable Clock Dispatch And Resume

Status: viable for live durable-time dispatch; continuation requires a separate
runtime primitive.

The durable Clock spike found that a `Layer.setClock`-installed custom Effect
`Clock` can record wake-up intent before parking fibers and can drive the
standard Effect time stack without Firegrid-specific wrappers. The promoted
first implementation lane is a substrate `durable-clock` subpath with:

- a wake-up store interface for append, pending reads, due reads, dispatch,
  cancellation, and snapshots;
- a Durable Streams-backed wake-up store that represents wake-ups as State
  Protocol rows keyed by wake-up id;
- a dispatcher that installs an Effect `Clock` via `Layer.setClock`;
- `Clock.sleep` implemented as append-then-park on an in-process deferred;
- dispatcher-driven wake-up firing that resumes live parked fibers;
- tests proving `Effect.sleep`, Effect timeout APIs, `Schedule`, and
  Clock-backed `Stream` operators use the custom Clock unchanged.

The key boundary is process death. Rehydrated wake-up records can be discovered
and marked dispatched by a recreated dispatcher, but the in-memory Effect fiber
and deferred are gone. The Clock layer owns time, not continuations. Any
cross-process resumption story must be a runtime-owned re-dispatch or checkpoint
primitive that observes dispatched wake-ups and restarts logical work.

The in-memory spike's "snapshot before interrupt fires" restart technique is
not a production substrate requirement. With Durable Streams as the source of
truth, the durability boundary is the State Protocol append outside the dying
process. Cancel and dispatch are ordinary per-key State Protocol appends, and
offset ordering decides the materialized winner. Production-shaped restart
validation should append a wake-up through the Durable Streams-backed store,
kill or replace the dispatcher, start a fresh dispatcher against the same stream
URL, and verify the pending wake-up is observed and fired when due.

### Operation Lifecycle As A Derived Stream

Status: viable with caveats.

The operation-lifecycle spike found that the client-facing `send`, `call`,
`result`, and `observe` surface can become Stream-first without exposing
`RunWait` or projection `until` at the client boundary. The recommended next
lane is an additive client-side shape:

- introduce an `OperationLifecycle` stream descriptor keyed by handle id;
- write `Submitted`, `Completed`, `Failed`, and `Cancelled` lifecycle messages;
- keep public `OperationState` collapsed to `Pending`, `Completed`, `Failed`,
  and `Cancelled`;
- implement `client.observe` as `Stream.scan` over lifecycle messages;
- implement `client.result` as terminal-message filtering plus `Stream.runHead`;
- implement `client.call` as `send` followed by `result`;
- lower caller-supplied idempotency through Durable Streams producer semantics,
  not a parallel Firegrid idempotency protocol.

This result only proves the client ergonomics lane. It does not prove that the
existing `durable.run` row family can disappear. A full substrate collapse
would require a separate spec that re-derives ready-work, claim, and terminal
authority from the lifecycle stream. Until that spec exists, the viable
transitional path is dual-written: `durable.run` remains private substrate
authority while the lifecycle stream becomes the public client observation and
result surface.

The main caveat is coherence. If the next lane ships the additive lifecycle
stream, terminal writes to the lifecycle stream and terminal mutations of
`durable.run` must share first-valid-terminal-wins semantics. Reviewers should
also reject any public state widening that exposes `Running`, `Claimed`, or
other internal runtime states through `client.observe`.

### Browser-Safe Descriptor Boundary

Status: viable with caveats.

The descriptor-boundary spike found that Firegrid can introduce a pure
`@firegrid/descriptors` package for browser-safe shared app contracts. The
package can own operation and event-stream descriptors without importing
`@firegrid/substrate`, `@firegrid/runtime`, Durable Streams server/client code,
or Node-only modules.

The unlocked package decision is to move operation and event-stream descriptor
definition into `@firegrid/descriptors` in the next implementation lane. That
lets shared application modules define contract shape once and lets the Node
runtime and browser client consume the same typed descriptors from their own
locality-safe packages.

Projection descriptors remain unresolved. The spike recommends deferring their
package shape until the State Protocol mapping audit decides whether projections
are pure Firegrid descriptors, State Protocol-backed descriptor values, or a
hybrid. The future feature spec should avoid baking a projection descriptor API
until that mapping result lands.

### API Footgun And Deletion Inventory

Status: mixed, leaning API design debt.

The footgun inventory found that Firegrid's app-construction difficulty is not
only documentation drift. The current canonical/public path still exposes too
many substrate-shaped decisions to application authors: runtime composition,
subscriber wiring, `RunWait`, `PlaneProducer`, event-plane/projection handles,
materializer naming, and browser-side substrate reads.

The top APIs and patterns to remove from canonical examples are:

- `Firegrid.subscribers.*`;
- direct `RunWait` usage;
- `PlaneProducer.emit(ChangeEvent)` as app-authored write path;
- `Firegrid.eventStream` materializer naming as the application model;
- browser imports from `@firegrid/substrate/event-plane` for
  `PlaneProjectionQuery` reads.

This result means PR #114 should not be reopened as a prettier cookbook for the
current public surface. Any replacement documentation must either show the new
stream-first descriptor/runtime path or explicitly mark the older substrate
surfaces as internal, transitional, or advanced. Documentation alone will not
make the current decision tree ergonomic.

## Migration Path

1. Run the spike plan and update this SDD with the results.
2. Land this SDD once the substrate alignment is validated or narrowed.
3. Promote accepted behavior into
   `features/firegrid/firegrid-runtime-ergonomics.feature.yaml`.
4. Decide where `FiregridApp.define(...)` lives so shared descriptor modules do
   not pull Node-only runtime code.
5. Define the stream graph primitive: typed ingress streams, typed processors,
   runtime-owned output persistence, and derived projections.
6. Decide whether `packages/substrate` grows first-class durable processors and
   projection derivation over Durable Streams + State Protocol, or whether the
   first implementation lowers the graph to existing Run/Completion/EventPlane
   rows behind the runtime boundary.
7. Implement `FiregridApp.runtime(...)` lowering to the chosen substrate
   primitive while keeping handlers, `RunWait`, `PlaneProducer`, and
   EventStream sink services out of app-authored code.
8. Implement the default durable wall-clock Layer over Durable Streams
   scheduled append/read semantics, keeping RunWait mechanics internal if used.
9. Implement `FiregridApp.client(...)` with Stream-shaped events, operation
   lifecycle, and query observations.
10. Rename or alias `Firegrid.eventStream(...)` to an unambiguous materializer
   name.
11. Add one app-path package or scenario test using only the new public
   surfaces; substrate primitives remain importable but unused by app code.
12. Rework the Flamecast LT-02 demo on the ergonomic path.
13. Replace the pattern decision tree with a short happy-path guide only after
   the API is actually ergonomic.

## Open Questions

1. Should `FiregridApp.define(...)` live on `@firegrid/runtime`, on
   `@firegrid/client`, or in a new public subpath that can be imported by
   shared descriptor modules without pulling Node-only code?
2. Should stream processors be represented as plain `Stream` values, descriptor
   methods such as `SessionTimeline.from(stream)`, or a small graph builder
   that can validate cycles and output ownership?
3. What is the smallest durable wall-clock implementation needed for runtime
   processors, and can existing RunWait mechanics remain entirely internal to
   that Layer and durable Stream sources?
4. Should Firegrid also ship an explicit event-time Clock Layer for deterministic
   replay workflows, or is `TestClock` sufficient for first-slice testing?
5. Should `packages/substrate` be refactored around durable streams,
   processors, checkpoints, and projections as first-class primitives, with
   Run/Completion/RunWait becoming lower-level compatibility machinery?
6. Which current Firegrid row families can become State Protocol message types,
   and which, if any, require Firegrid-owned protocol extensions?
7. Where is adapter non-determinism journaled: as processor output facts,
   runtime-owned adapter-call facts, or idempotent external side effects keyed
   by processor input cursor?
8. Are operation lifecycle rows a projection of stream processor execution, or
   should operations remain a distinct substrate row family beneath the graph?
9. What is the smallest typed adapter contract needed to prevent fake
   successful provider output in the first Flamecast demo?
10. Should Firegrid provide a local dev host helper, or should that stay
   product-owned while Firegrid only provides a cleaner runtime entrypoint?
11. Which current APIs should be renamed or wrapped because their names obscure
   whether they return a Stream source, write to a sink, or install a runtime
   materializer?
