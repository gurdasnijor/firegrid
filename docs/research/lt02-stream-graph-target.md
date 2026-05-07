# LT-02 Stream-Graph Target Shape

Status: falsification artifact, not implementation.

This document intentionally sketches a target app-authoring shape that does not
compile against current Firegrid APIs. It asks whether the smallest realistic
LT-02 Flamecast app could be expressed as a durable stream graph if `ctx`,
handler bodies, imperative timeline emits, read-model upserts, and public
`RunWait` authoring disappear from the app path.

Source inputs were:

- `HANDOFF.md`
- `docs/replatforming/litmus/LT-02-local-runtime-session-loop.md`
- `/private/tmp/firegrid-runtime-ergonomics-sdd/docs/proposals/SDD_FIREGRID_RUNTIME_ERGONOMICS.md`
- `packages/client/README.md`
- `packages/runtime/README.md`
- merged feature specs under `features/firegrid/` and
  `features/flamecast/flamecast-product-contract.feature.yaml`

Relevant ACIDs:

- `flamecast-product-contract.SESSIONS_API.1`
- `flamecast-product-contract.SESSIONS_API.5`
- `flamecast-product-contract.EVENTS.1`
- `flamecast-product-contract.EVENTS.2`
- `flamecast-product-contract.LOWERING.2`
- `flamecast-product-contract.LOWERING.3`
- `flamecast-product-contract.LOWERING.7`
- `firegrid-platform-invariants.LOCALITY.1`
- `firegrid-platform-invariants.LOCALITY.2`
- `firegrid-platform-invariants.LOCALITY.4`
- `firegrid-platform-invariants.LOCALITY.5`
- `firegrid-platform-invariants.AUTHORITY.1`
- `firegrid-platform-invariants.AUTHORITY.4`
- `firegrid-platform-invariants.AUTHORITY.7`
- `firegrid-agent-runtime-substrate.LONG_LIVED_OPERATION.1`
- `firegrid-agent-runtime-substrate.LONG_LIVED_OPERATION.2`
- `firegrid-agent-runtime-substrate.RECONNECT_REPLAY.1`
- `firegrid-agent-runtime-substrate.RECONNECT_REPLAY.5`
- `firegrid-agent-runtime-substrate.TOPOLOGY_PROFILE.1`
- `firegrid-client-projection-api.BROWSER_SAFE_FACADE.1`
- `firegrid-client-projection-api.BROWSER_SAFE_FACADE.2`
- `firegrid-client-projection-api.RECONNECT_SEMANTICS.1`

## Question

If handlers, `ctx`, imperative emit/upsert APIs, and public wait authoring
disappear, what is the smallest LT-02 app-authored stream graph that still
exercises the real product loop?

Minimum product loop:

1. Browser creates a Flamecast session turn.
2. Browser observes operation lifecycle for progress/terminal state.
3. Browser observes the session timeline.
4. Browser reads a refresh-safe session projection.
5. Node runtime receives typed turn ingress.
6. Node runtime runs a product-owned adapter boundary.
7. Adapter tokens become timeline facts.
8. Session projection is derived from timeline facts.
9. Refresh/reconnect reconstructs the same state from durable data.

## Current Path Pain Points

This is representative of the current public shape, not the desired target:

```ts
// shared/contracts.ts
export const SessionTurn = Operation.define({
  name: "flamecast.session.turn",
  input: SessionTurnInput,
  output: SessionTurnOutput,
  error: SessionTurnError,
})

export const SessionTimeline = EventStream.define({
  name: "flamecast.session.timeline",
  event: FlamecastSessionEvent,
})

export const SessionsPlane = EventPlane.define({
  name: "flamecast.sessions",
  state: SessionsState,
})
```

```ts
// runtime/main.ts today-ish
const runtime = Firegrid.composeRuntime({
  handlers: [
    Firegrid.handler(SessionTurn, (input) =>
      Effect.gen(function* () {
        const timeline = yield* FiregridClient
        const producer = yield* SessionsPlane.Producer
        const wait = yield* RunWait

        yield* timeline.emit(SessionTimeline, userMessage(input))
        yield* producer.emit(sessionRows.running(input))

        const result = yield* LocalFlamecastAdapter.respond(input)

        yield* timeline.emit(SessionTimeline, assistantMessage(input, result))
        yield* producer.emit(sessionRows.completed(input, result))

        yield* wait.for(sessionVisible(input.sessionId))
        return { sessionId: input.sessionId, turnId: input.turnId }
      }),
    ),
  ],
  subscribers: [
    Firegrid.subscribers.projectionMatch({ evaluate }),
  ],
  provide: [
    FiregridClientLive({ streamUrl }),
    EventPlane.layer(SessionsPlane, { streamUrl }),
    RunWait.layer({ streamUrl }),
  ],
})
```

Pain points shown by the snippet:

- The app must know when to use a client emitter versus an EventPlane producer.
- The timeline and session read model are authored as side effects.
- Runtime code manually wires client and substrate layers.
- Public app code sees a wait primitive even though the wait is only a
  persistence/resume mechanism.
- The materializer/emitter distinction is easy to confuse.
- Browser read-model code has to choose between EventStream replay and
  projection-query mechanics.

## Proposed Target Shape

The target should feel like declaring a Flamecast app graph. Firegrid owns
durable draining, output persistence, processor checkpointing, operation
lifecycle, and refresh-safe replay. Flamecast owns session, turn, provider, and
timeline schemas.

The code below is deliberately aspirational.

```ts
// shared/flamecast-firegrid.ts
import { FiregridApp, Operation, EventStream, EventPlane } from "@firegrid/app"
import { Schema } from "effect"

export const SessionTurn = Operation.define({
  name: "flamecast.session.turn",
  input: SessionTurnInput,
  output: SessionTurnOutput,
  error: SessionTurnError,
})

export const SessionTimeline = EventStream.define({
  name: "flamecast.session.timeline",
  event: FlamecastSessionEvent,
  partitionKey: (event) => event.sessionId,
})

export const Sessions = EventPlane.define({
  name: "flamecast.sessions",
  state: {
    sessions: {
      primaryKey: "sessionId",
      schema: Schema.standardSchemaV1(SessionProjectionRow),
    },
  },
})

export const FlamecastApp = FiregridApp.define({
  name: "flamecast.local",
  operations: { SessionTurn },
  eventStreams: { SessionTimeline },
  planes: { Sessions },
})
```

```ts
// runtime/graph.ts
import { Clock, Effect, Stream } from "effect"
import { FlamecastApp, SessionTimeline, SessionTurn, Sessions } from "../shared/flamecast-firegrid"
import { LocalFlamecastAdapter } from "./adapter"

const turnIngress = FlamecastApp.ingress(SessionTurn)

const turnTimeline = turnIngress.stream.pipe(
  Stream.flatMap((turn) =>
    Stream.make(
      timeline.userMessage({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        content: turn.input,
        at: turn.acceptedAt,
      }),
      timeline.turnStarted({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        at: turn.acceptedAt,
      }),
    ).pipe(
      Stream.concat(
        LocalFlamecastAdapter.tokens(turn).pipe(
          Stream.map((token) =>
            timeline.assistantToken({
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              token,
            }),
          ),
        ),
      ),
      Stream.concat(
        Stream.fromEffect(Clock.currentTimeMillis).pipe(
          Stream.map((finishedAt) =>
            timeline.turnComplete({
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              at: finishedAt,
            }),
          ),
        ),
      ),
      Stream.catchAll((error) =>
        Stream.make(
          timeline.error({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            error: FlamecastErrors.fromAdapter(error),
          }),
        ),
      ),
    ),
  ),
)

const sessionProjection = SessionTimeline.stream.pipe(
  Stream.scan(SessionReadModel.empty, SessionReadModel.reduce),
)

const adapterAudit = LocalFlamecastAdapter.events.pipe(
  Stream.map((event) =>
    timeline.adapterEvent({
      sessionId: event.sessionId,
      turnId: event.turnId,
      detail: event.detail,
    }),
  ),
)

export const FlamecastRuntime = FlamecastApp.runtime({
  ingress: [turnIngress],
  processors: [
    FlamecastApp.processor({
      name: "flamecast.turn.timeline",
      input: turnIngress,
      output: SessionTimeline.from(Stream.merge(turnTimeline, adapterAudit)),
      requirements: [LocalFlamecastAdapter],
    }),
  ],
  projections: [
    Sessions.project({
      name: "flamecast.sessions.by-session",
      from: SessionTimeline,
      reduce: SessionReadModel.reduce,
      initial: SessionReadModel.empty,
    }),
  ],
})
```

Properties of the target runtime shape:

- No positional runtime context object.
- No app-authored operation body.
- No imperative EventStream sink call from app processor code.
- No imperative session read-model write.
- No public wait primitive in the app graph.
- The adapter boundary is product-owned and explicit.
- Provider success cannot be faked unless `LocalFlamecastAdapter` itself is a
  test adapter selected by product config.

```ts
// runtime/main.ts
import { run } from "@firegrid/runtime"
import { FlamecastRuntime } from "./graph"
import { LocalFlamecastAdapterLive } from "./adapter"

await run({
  connection: { streamUrl: process.env.DURABLE_STREAMS_URL },
  runtime: FlamecastRuntime.provide([
    LocalFlamecastAdapterLive({
      command: process.env.FLAMECAST_LOCAL_ADAPTER_COMMAND,
    }),
  ]),
})
```

This entrypoint is still a separate Node process. Browser code never imports
`@firegrid/runtime`; runtime code never imports `@firegrid/client`.

## Browser Usage

The browser should look like a product client over descriptors, not a topology
or substrate client.

```ts
// client/flamecast-client.ts
import { Effect, Stream } from "effect"
import { FlamecastApp, SessionTimeline, SessionTurn, Sessions } from "../shared/flamecast-firegrid"

export const FlamecastClient = FlamecastApp.client({
  streamUrl: window.__FLAMECAST_CONFIG__.firegridStreamUrl,
})

export const createSessionTurn = (input: SessionCreate) =>
  Effect.gen(function* () {
    const handle = yield* FlamecastClient.send(SessionTurn, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      input: input.input,
      agent: input.agent,
      metadata: input.metadata,
    })

    const lifecycle = FlamecastClient.observe(SessionTurn, handle)
    const result = FlamecastClient.result(SessionTurn, handle)

    return { handle, lifecycle, result }
  })

export const observeSessionTimeline = (sessionId: string) =>
  FlamecastClient.events(SessionTimeline).pipe(
    Stream.filter((event) => event.sessionId === sessionId),
    Stream.scan(FlamecastTimeline.empty, FlamecastTimeline.reduce),
  )

export const readSessionProjection = (sessionId: string) =>
  FlamecastClient.query(Sessions, (q) =>
    q
      .from({ session: q.collection("sessions") })
      .where(({ session }) => session.sessionId === sessionId)
      .select(({ session }) => session),
  )

export const readSessionList = () =>
  FlamecastClient.query(Sessions, (q) =>
    q
      .from({ session: q.collection("sessions") })
      .orderBy(({ session }) => session.updatedAt, "desc")
      .limit(50)
      .select(({ session }) => session),
  )
```

Refresh/reconnect behavior:

```ts
// client/resume.ts
export const reconnectSession = (sessionId: string) =>
  Effect.gen(function* () {
    const client = FlamecastApp.client({
      streamUrl: window.__FLAMECAST_CONFIG__.firegridStreamUrl,
    })

    const session = yield* client.query(Sessions, bySessionId(sessionId)).snapshot

    const timeline = client.events(SessionTimeline, {
      partitionKey: sessionId,
      from: session?.timelineCursor ?? "retained-start",
    }).pipe(
      Stream.scan(FlamecastTimeline.fromProjection(session), FlamecastTimeline.reduce),
    )

    return { session, timeline }
  })
```

The browser uses:

- `call` or `send`/`result` for the session turn command;
- `observe` for public operation lifecycle;
- `events` for timeline replay/live-tail;
- `query` for refresh-safe session projection reads;
- cursor-aware replay on reconnect.

The browser does not see runtime registration, subscriber registration, kernel
imports, claim/completion/terminal authority, or product-private adapter
transport.

## Required Nonexistent APIs

| Target API | Exists today? | Active spike or SDD lane that must answer it |
|---|---:|---|
| `@firegrid/app` or equivalent browser-safe app descriptor root | No | Descriptor package boundary spike, surface 37 |
| `FiregridApp.define(...)` | No | Descriptor package boundary spike, surface 37 |
| `FlamecastApp.ingress(Operation)` | No | Operation lifecycle as derived stream spike, surface 81 |
| `ingress.stream` as durable `Stream<OperationInput>` | No | Operation lifecycle as derived stream spike, surface 81 |
| `FlamecastApp.processor(...)` | No | Runtime ergonomics SDD stream processor lane |
| `SessionTimeline.from(stream)` durable output sink declaration | No | Runtime ergonomics SDD stream processor lane plus State Protocol mapping spike, surface 99 |
| Runtime-owned output persistence for processor streams | No | State Protocol mapping spike, surface 99 |
| `Sessions.project({ from, reduce, initial })` | No | Per-key state / projection derivation spike from the runtime ergonomics SDD |
| `FlamecastApp.runtime(...)` | No | Runtime ergonomics SDD stream processor lane |
| `FlamecastRuntime.provide([...])` preserving Effect requirements | No | Runtime ergonomics SDD processor environment lane |
| Runtime-provided durable `Clock` for processor time | No | Durable Clock spike, surface 66 |
| `FlamecastApp.client(...)` | No | Descriptor package boundary spike, surface 37, and client ergonomics lane |
| Root-level `client.query(...)` over app planes | Not as shown | Client projection ergonomics lane over existing `@firegrid/client/projection-query` |
| `client.events(stream, { partitionKey, from })` | Not as shown | EventStream replay/cursor ergonomics and State Protocol mapping spike, surface 99 |
| `client.observe(...)` as reconnect-safe `Stream` with lifecycle cursor | Partially | Operation lifecycle as derived stream spike, surface 81 |

Current public APIs that the target should lower to or preserve where possible:

- `FiregridClient.send`, `call`, `observe`, `result`, `emit`, and `events`;
- `@firegrid/client/projection-query` read facade;
- `Firegrid.composeRuntime(...)` and `run({ connection, runtime })` as
  lower-level runtime implementation targets;
- app-owned `EventStream.define`, `Operation.define`, and `EventPlane.define`;
- Effect `Stream`, `Clock`, `Schedule`, and ordinary Effect environment
  composition.

## Falsification Checks

The target shape is viable only if the next SDD/spec work can make these true:

1. A processor graph can be lowered to durable operation consumption without
   exposing an app-authored operation body.
2. Processor output can be persisted as caller-owned EventStream/EventPlane
   facts without an app-visible emitter or producer service.
3. A projection can be derived from timeline facts and exposed to the browser
   through a reconnect-safe query handle.
4. Operation lifecycle can be observed by the browser as public lifecycle
   state while product-specific session phase remains in caller-owned rows.
5. Refresh builds the session detail screen from durable projection plus
   timeline replay, not process memory.
6. Missing adapter configuration becomes a typed product setup error or
   operation failure, not fake assistant output.
7. Browser imports remain client/descriptor-only, and Node runtime imports
   remain runtime/descriptor/adapter-only.

The target is too vague if the next spec cannot define who owns:

- processor input checkpointing;
- output persistence idempotency at the input cursor boundary;
- projection cursor and no-gap replay boundaries;
- durable Clock deadline records and resume;
- adapter side-effect retry and duplication policy.

The target is blocked if Firegrid cannot expose durable sources as Effect
Streams without either leaking kernel authority into app code or reinventing a
Firegrid-specific stream/operator type.

## Verdict

Target shape viable, with explicit missing APIs.

This artifact does not prove implementation feasibility. It does falsify the
current handler/imperative-emitter path as the canonical LT-02 ergonomic target:
the smallest realistic Flamecast shape is a stream graph with typed ingress,
processor output, adapter token stream, derived session projection, and
refresh-safe client reads.

Next SDD edit unlocked:

- Promote a `STREAM_PROCESSORS` component into
  `features/firegrid/firegrid-runtime-ergonomics.feature.yaml`, centered on
  durable ingress streams, runtime-owned output persistence, derived
  projections, and absence of app-visible `ctx`, handler bodies, emit sinks,
  read-model upserts, or public wait authoring.
