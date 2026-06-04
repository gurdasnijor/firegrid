# SDD: Fluent Runtime Workbench

Status: Draft
Product: Firegrid
Date: 2026-06-04
Canonical: No. This draft is not dispatchable unless added to
`docs/cannon/README.md`.

Related:
- `packages/fluent-firegrid`
- `packages/firelab`
- `docs/findings/tf-n3qc-fluent-firegrid-design.md`
- `repos/sdk-typescript/packages/libs/restate-sdk-gen/DESIGN.md`
- `repos/sdk-typescript/packages/libs/restate-sdk-gen/src/`
- `docs/cannon/architecture/runtime-design-constraints.md`
- `docs/cannon/architecture/runtime-pipeline-type-boundaries.md`

## Summary

`@firegrid/fluent-firegrid` has proven the useful user-facing direction: a
free, generator-based Operation/Future DSL. The next move is not to build a
second runtime with its own scheduler and a large menu of durable primitives.
The next move is to extract the engine that `fluent-firegrid` already contains,
then inject durability through the same thin awaitable seam used by
`restate-sdk-gen`.

The source-verified Restate seam is:

- `Awaitable<T>`: a thenable with `.map((value, error) => mapped)`;
- `AwaitableLib`: `all`, `race`, `any`, `allSettled`, and `isCancellation`;
- free functions reach the scheduler through a synchronous current-fiber slot;
- the scheduler never imports Restate SDK types and never writes a journal;
- durability is a property of the awaitables that operations produce.

The current `fluent-firegrid` implementation diverges at the important point:
`packages/fluent-firegrid/src/index.ts` keeps journal replay and append logic
inside `Scheduler.run`, `Scheduler.sleep`, `Scheduler.raceIndexed`, and the
recursive `drive` interpreter. That welds together two layers that the Restate
source keeps separate.

The architectural target is one substrate-free engine in `fluent-firegrid`, with
durable behavior supplied by operation producers and an `AwaitableLib`.
`fluent-runtime` then depends on that engine and owns the managed-agent durable
side of the seam: stream-backed awaitables, session/turn/harness operators,
Durable Streams fork/subscription handlers, timer wake materialization, webhook
adapters, and the HTTP/client front door.

## Ingress First

The control-plane ingress must be specified up front and it must speak the
managed-agent domain. Avoid generic durable-workflow vocabulary such as
`Invocation` unless a specific wire protocol requires it. The product concepts
are:

- `Session`: durable conversation identity and event log;
- `Prompt` / `Turn`: a request to an agent inside a session;
- `Harness`: the loop that yields effects, records progress, and resumes;
- `Tools`: named agent capabilities with input schemas;
- `Sandbox`: scoped execution environment for agents/tools;
- `Resources`: referenced inputs mounted into a sandbox/tool;
- `Orchestration`: wake by durable session identity, not workflow DAGs.

The default ingress shape is an Effect `HttpApi`, not a bespoke Firegrid
projection layer:

```ts
import {
  FetchHttpClient,
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSwagger,
} from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { createServer } from "node:http"

const FluentApi = HttpApi.make("FluentAgents")
  .add(
    HttpApiGroup.make("Sessions")
      .add(
        HttpApiEndpoint.post("start", "/sessions")
          .setPayload(Schema.Struct({
            agent: Schema.String,
            resources: Schema.Array(Schema.String),
          }))
          .addSuccess(Schema.Struct({
            sessionId: Schema.String,
            eventsUrl: Schema.String,
          })),
      )
      .add(
        HttpApiEndpoint.get("events", "/sessions/:sessionId/events")
          .addSuccess(Schema.Struct({
            eventsUrl: Schema.String,
          })),
      )
      .add(
        HttpApiEndpoint.post("prompt", "/sessions/:sessionId/prompts")
          .setPayload(Schema.Struct({
            prompt: Schema.String,
          }))
          .addSuccess(Schema.Struct({
            turnId: Schema.String,
            eventsUrl: Schema.String,
          })),
      ),
  )

const SessionsLive = HttpApiBuilder.group(
  FluentApi,
  "Sessions",
  (handlers) =>
    handlers
      .handle("start", ({ payload }) => Sessions.start(payload))
      .handle("events", ({ path }) => Sessions.events(path.sessionId))
      .handle("prompt", ({ path, payload }) =>
        Sessions.prompt({ sessionId: path.sessionId, prompt: payload.prompt }),
    ),
)

const FluentApiLive = HttpApiBuilder.api(FluentApi).pipe(
  Layer.provide(SessionsLive),
)

const ServerLive = HttpApiBuilder.serve().pipe(
  Layer.provide(HttpApiSwagger.layer()),
  Layer.provide(FluentApiLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
)

Layer.launch(ServerLive).pipe(NodeRuntime.runMain)

const clientProgram = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(FluentApi, {
    baseUrl: "http://localhost:3000",
  })
  const session = yield* client.Sessions.start({
    payload: {
      agent: "researcher",
      resources: ["repo:firegrid"],
    },
  })
  return yield* client.Sessions.prompt({
    path: { sessionId: session.sessionId },
    payload: { prompt: "Summarize the current runtime design." },
  })
})

Effect.runFork(clientProgram.pipe(Effect.provide(FetchHttpClient.layer)))
```

That single `FluentApi` definition must drive:

- server implementation through `HttpApiBuilder.group` /
  `HttpApiBuilder.api`;
- generated documentation through `HttpApiSwagger.layer`;
- typed clients through `HttpApiClient.make`;
- request and response codecs through `Schema`.

This is much simpler than the current `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT`
model because the new fluent path does not start from a protocol catalog that
must be projected onto many legacy surfaces. For `fluent-runtime`, the HTTP API
contract itself can be the ingress catalog. When another interface is needed,
derive it from or adapt it to this same contract instead of creating a parallel
projection metadata system.

The split is:

```text
control plane
  HttpApi contract -> HttpApiBuilder server -> HttpApiClient clients
                \-> Swagger/OpenAPI docs

data plane
  Durable Streams append/read/follow/subscribe URLs
  -> session events, prompt turns, awaitable resolution, trace observation,
     sandbox/tool/resource lifecycle, and projection streams
```

Clients that need long-running observation should not force the HTTP control
plane to grow custom async task semantics. They can start sessions, send
prompts, respond to approvals, and cancel sessions through the `HttpApi`
control plane, then subscribe to the returned Durable Streams URL for
session/turn/tool/resource updates.

## Client And API Ergonomics

The internal planes should follow the six managed-agent primitives. The public
API should be designed for two callers, not for exposing runtime folders:

- application clients start/configure sessions, send prompts, approve/deny
  required actions, cancel sessions, and observe the durable event/trace stream;
- agents call durable choreography tools: `wait_for`, `wait_until`, `sleep`,
  `spawn`, `spawn_all`, and `execute`.

The current `packages/client-sdk/README.md` is useful inspiration for the app
side: scoped session handles, explicit deployment config, permission responses,
MCP tool attachment, and browser-safe methods. The top-level `README.md` is the
anchor for the agent side: waits, spawns, and execute are durable tools the
model calls, not app-client observation methods. Neither side should expose
table tags, raw stream row builders, live process handles, or a workflow graph.

There are no external users to preserve here, so do not copy legacy vocabulary
or compatibility aliases. Design the new facade directly around sessions.

Layering:

```text
HttpApi contract
  -> generated HttpApiClient       # transport-accurate, schema-derived
  -> domain facade in client.ts    # ergonomic, scoped handles
  -> Durable Streams subscriptions # observation data plane, wrapped by facade
```

Example facade shape:

```ts
const firegrid = yield* Firegrid

const session = yield* firegrid.sessions.create({
  key: { source: "linear.issue", id: "LIN-123" },
  agent: {
    command: ["node", "planner.mjs"],
    protocol: "stdio-jsonl",
  },
  resources: [
    { source: "git:firegrid", mountPath: "/workspace/firegrid" },
  ],
  tools: [
    {
      name: "linear",
      transport: "mcp",
      url: "https://mcp.example.com/linear",
      headers: { authorization: { ref: "env:LINEAR_MCP_TOKEN" } },
    },
  ],
})

yield* session.start()

const turn = yield* session.prompt({
  idempotencyKey: "initial-review",
  text: "Inspect the repo and propose the next runtime step.",
})

yield* session.events.follow({ after: turn.eventsUrl }).pipe(
  Stream.runForEach((event) =>
    event.type === "permission.requested"
      ? session.approvals.respond({
          requestId: event.requestId,
          decision: "allow",
        })
      : Effect.void,
  ),
)

yield* session.cancel("user-requested")
```

Ergonomic grouping rule:

| User-facing method | Internal primitive plane |
|---|---|
| `firegrid.sessions.create(...)` | Session + Resources + Tools + Sandbox config |
| `session.start()` | Session + Orchestration |
| `session.prompt(...)` | Session + Harness |
| `turn.events.follow()` / `session.events.follow()` | Session projection/subscription |
| `session.cancel(...)` | Session + Orchestration |
| `session.approvals.respond(...)` | Tools + Orchestration |
| `session.tools.list()` | Tools |
| `session.resources.mount(...)` | Resources + Sandbox |
| `firegrid.webhooks.register(...)` | Orchestration + external integration |
| agent `wait_for(...)` | Session + Orchestration + Projection |
| agent `wait_until(...)` / `sleep(...)` | Session + Orchestration + Timer |
| agent `spawn(...)` / `spawn_all(...)` | Session + Harness + Orchestration |
| agent `execute(...)` | Sandbox + Tools + Harness |

The API should optimize for user comprehension without creating top-level
runtime planes for every verb. `Prompt` / `Turn` remains a session event and a
harness effect, even if the public client gives it a short method name.

The generated `HttpApiClient` is the transport-accurate client; `client.ts` may
wrap it into a nicer domain facade as long as the wrapper does not introduce a
second contract. Raw Durable Streams URLs may appear in receipts for advanced
subscribers and non-TypeScript clients, but the TypeScript facade should expose
typed observation methods first.

Client and agent surface constraints:

- browser/edge-safe: no `packages/runtime`, Node process, or provider-start
  authority in the app client;
- explicit configuration: Durable Streams base URL, namespace, HTTP base URL,
  and auth are deployment config, not hidden globals;
- scoped handles: once a session handle exists, callers should not restate
  session identity for prompt, approval, tool, resource, observation, or cancel
  operations;
- launch intent is durable data: agent command, protocol, resources, MCP server
  refs, and secret refs are recorded as intent and resolved by host/runtime
  operators;
- durable wait APIs belong to the agent tool surface, not the app-client
  observation facade;
- provider actions are tools first: promote a provider action into a durable
  Firegrid channel only when Firegrid must own claim-before-side-effect,
  retries, or completion evidence;
- no compatibility aliases: new surfaces should use `sessionId`, `turnId`,
  `resource`, `tool`, and `sandbox` vocabulary directly.

## Durable Webhook Ingest

Webhook ingest should use Durable Streams subscriptions directly. The current
Durable Streams server can create a webhook wake on stream append, sign the
callback payload, include the subscription id, wake id, generation, stream tail
state, callback URL, and callback token, then retry failed delivery with
backoff. If the webhook response returns `{ done: true }`, the server auto-acks
the wake snapshot and triggers the next pending wake.

That means fluent-runtime does not need the old Effect Workflow-based webhook
machinery. Webhooks are another external integration over the stream-first
substrate:

```text
external system
  -> HTTP ingress appends webhook event to Durable Streams
  -> subscription manager wakes matching webhook subscription
  -> webhook adapter validates signature/token/generation
  -> adapter appends session/tool/resource event or external promise result
  -> session projection and waiting awaitables resume from stream state
```

Use webhook subscriptions for external integrations that should wake runtime
or adapter code when durable facts arrive. Use pull-wake subscriptions for
runtime-owned operators that claim and ack work. Both paths stay below the
fluent `HttpApi` control plane and above raw Durable Streams.

## Durable Streams Substrate Commitments

The durable side should use the protocol primitives directly instead of
rebuilding them in runtime code:

- **Fork creates child sessions.** Agent `spawn` / `spawn_all` creates child
  session streams with `PUT` plus `Stream-Forked-From` and `Stream-Fork-Offset`.
  The child inherits the parent's event history up to the spawn point, then
  diverges. There is no `RoutineStarted` / `RoutineCompleted` row family and no
  bespoke child-session intent row. The fork is the durable child-session
  record.
- **Forks reset producer state.** A fork must not inherit idempotent producer
  state. Child session writers re-bootstrap producer id/epoch/seq on the child
  stream.
- **Turn completion is stream closure.** `Stream-Up-To-Date` means "caught up
  for now"; it is not EOF. A turn/harness result is terminal only when the
  finite turn stream returns `Stream-Closed: true`.
- **Terminal result uses atomic append-and-close.** The terminal result for a
  turn or journal-backed awaitable should be written with one append carrying
  `Stream-Closed: true`, not append-then-close.
- **Replay keys off closure and producers.** Replay/re-wake must read until
  `Stream-Closed: true` for completed turns. Idempotent producer headers
  (`Producer-Id`, `Producer-Epoch`, `Producer-Seq`) provide retry safety and
  zombie fencing; replay still checks existing stream content before
  re-executing side effects.
- **Subscriptions provide work delivery.** Webhook and pull-wake subscriptions
  own wake generation, claims, leases, ack/release, fencing, retry, and auto-ack
  semantics. Fluent-runtime writes subscription handlers, not a second work
  delivery system.

Current source verification:

- Durable Streams `PROTOCOL.md` specifies fork, closure, subscriptions,
  idempotent producers, and the `Stream-Up-To-Date` vs `Stream-Closed`
  distinction.
- The current upstream server implements fork parsing and forked reads in
  `packages/server/src/server.ts`, `store.ts`, `file-store.ts`, and `types.ts`.
- The current local `packages/effect-durable-streams` wrapper exposes close,
  producer headers, ETag / `If-None-Match`, and closed reads, but does not yet
  expose a first-class fork helper. `fluent-runtime/Store.ts` can send the fork
  headers directly at first, then promote that to the wrapper.

## Session And Turn Stream Model

Use two stream roles instead of asking one never-ending log to mean both
"session history" and "finite work result":

- **Session stream:** durable conversation identity, launch/config intent,
  resource/tool/sandbox facts, child-session links, and observation events. A
  session stream may remain open for the life of the session.
- **Turn stream:** finite harness run for one prompt or agent self-prompt. A
  turn stream closes when the turn has a terminal result, cancellation, or
  failure.

Replay of completed work must read the turn stream until `Stream-Closed: true`.
Reading until `Stream-Up-To-Date` is only a catch-up point and cannot prove the
turn is done. This is the constraint that keeps replay-not-rows sound:
terminality is not inferred from tail state; terminality is stream closure.

Session-level projections may continue to summarize turn state for clients, but
the durable terminal signal remains the finite turn stream's close. When a
handler writes the final result, it should use atomic append-and-close so a
crash cannot leave "result row appended, stream still open" ambiguity.

Idempotent producer headers are the restart mechanism for writers. A re-driver
uses producer id/epoch/seq for retry safety and zombie fencing, but still reads
back existing turn/journal content before re-executing side-effecting `run`
steps. The selected Durable Streams store must document whether append and
producer-state updates are atomic; if not, side-effecting steps need either
their own idempotency or claim-before-side-effect discipline.

## Corrected Package Boundary

`packages/runtime` remains out of bounds. `packages/fluent-runtime` may depend
on `packages/fluent-firegrid`, because `fluent-firegrid` is the new public DSL
and shared engine, not the legacy runtime.

```text
packages/fluent-firegrid/
  src/awaitable.ts        # Awaitable<T>, AwaitableLib, isCancellation contract
  src/operation.ts        # Operation, gen, leaf markers, awaitRace, select
  src/future.ts           # Future, JournalBacking, LocalBacking, WaitTarget
  src/fiber.ts            # generator state machine and parked wait dispatch
  src/scheduler.ts        # ready queue, main-loop race, combinators, cancel fanout
  src/scheduler-types.ts  # Settled, PromiseSource, Waiter cycle-break types
  src/current.ts          # synchronous current-fiber slot
  src/channel.ts          # local single-shot channel backed by WaitTarget
  src/operations.ts       # public run/sleep/state/spawn/client helpers
  src/in-process-lib.ts   # local AwaitableLib for tests and tiny workbench
  src/index.ts            # public exports only

packages/fluent-runtime/
  src/Domain.ts           # ids, row schemas, errors, policy vocabulary
  src/Sessions.ts         # session identity, prompt/turn events, projections
  src/Harness.ts          # effect yield/resume loop and claim-first effects
  src/Tools.ts            # tool descriptors, catalog materialization, invoke
  src/Sandboxes.ts        # sandbox lifecycle and provider handles
  src/Resources.ts        # resource references, mounts, artifact refs
  src/Components.ts       # topology and harness component combinators
  src/Timers.ts           # durable sleep and wake delivery
  src/Webhooks.ts         # durable webhook ingest and subscription callbacks
  src/Awaitables.ts       # Durable Streams-backed Awaitable producers/lib
  src/Scheduler.ts        # fluent-firegrid scheduler wiring, not a new engine
  src/Store.ts            # Durable Streams append/read/follow adapter
  src/Runtime.ts          # app-owned runtime layer composition
  src/Api.ts              # aggregate HttpApi
  src/Http.ts             # server layer
  src/client.ts           # derived client entrypoint
  src/Mcp.ts              # optional adapter over HttpApi/streams, not core
  src/main.ts             # optional launcher example only

packages/firelab/src/simulations/fluent-runtime-*/
  host.ts                 # compose fluent-runtime layers
  driver.ts               # exercise public client/front-door APIs
  index.ts                # register simulation
```

Scaling rule: start each runtime domain as one file. Promote a file to a folder
only when it earns multiple internal parts while preserving the import name:

```text
Sessions.ts
```

becomes:

```text
Sessions/
  index.ts               # preserves `from "./Sessions"` imports
  Api.ts                 # HttpApi group
  Service.ts             # Context.Tag service interface
  Live.ts                # default Layer implementation
  Store.ts               # session-specific stream access
  Policy.ts              # admission and authorization
```

Use that promotion pattern for `Harness`, `Tools`, `Sandboxes`, `Resources`,
`Components`, `Timers`, `Webhooks`, `Domain`, and `Store` only after the simple
file shape becomes constraining.

## Action 1: Extract The Engine

Split `packages/fluent-firegrid/src/index.ts` along the Restate file
boundaries before building more runtime surface:

- `operation.ts`: `Operation`, `gen`, leaf markers, `awaitRace`, `select`.
- `future.ts`: `Future`, journal-backed futures, local-backed futures, and
  `WaitTarget`.
- `fiber.ts`: a single strand of execution with iterator, ready/parked/done
  state, and dispatch. This type does not exist in `fluent-firegrid` today;
  introducing it replaces the recursive `drive` interpreter.
- `scheduler.ts`: live fibers, ready queue, main-loop race, combinators, and
  cancellation fanout.
- `awaitable.ts`, `current.ts`, `channel.ts`, and `scheduler-types.ts`: the
  small support modules.

Acceptance check: `scheduler.ts` imports nothing from Durable Streams and has no
journal replay or append logic. If `scheduler.ts` still references
`DurableStream`, `stream.append`, or replay event lookup, the extraction has not
broken the weld.

## Engine Shape

The engine should mirror the Restate source split closely enough that the seam
stays obvious:

- `awaitable.ts` is the only substrate seam.
- `future.ts` distinguishes journal-backed and local-backed futures.
- `spawn(op)` creates an in-memory fiber and returns a local-backed future.
- `channel()` is local-backed, not durable.
- `scheduler.ts` owns orchestration only: ready queue, parked sources, one
  central `lib.race`, cancellation fanout, and combinator fast/fallback paths.
- `current.ts` uses a module-global slot, guarded by the synchronous generator
  invariant.

The current slot does not need `FiberRef`. The rule is stricter and simpler:
set the slot only for the synchronous span of `iterator.next` or
`iterator.throw`, and never hold it across an `await` or `Effect` suspension.
That is the same safety argument documented in Restate's `current.ts`, and it
matches the current `fluent-firegrid` `withCurrentScheduler` usage.

## Action 2: Move Journaling Behind Awaitable

The immediate refactor is to move journal work out of `Scheduler`.

Current shape:

```text
free run()
  -> Scheduler.run()
     -> read replay events
     -> execute action
     -> stream.append(StepSucceeded)
     -> Future(effect)

Scheduler.drive()
  -> recursively interprets yielded primitives
```

Target shape:

```text
free run()
  -> Operations.run()
     -> DurableJournal.runAwaitable("step", action)
     -> scheduler.makeJournalFuture(awaitable)

Scheduler.run(operation)
  -> drives fibers
  -> collects parked PromiseSources
  -> lib.race(tagged awaitables)
  -> dispatches winner
```

In other words, `run`, `sleep`, `wait_for`, approvals, state reads/writes,
child-session waits, tool calls, and external promises produce awaitables. The
scheduler only knows whether a future is journal-backed or local-backed, and
how to wait on it.

For the raw Durable Streams implementation, a journal-backed awaitable should
own:

- replay lookup for the deterministic key;
- append of the terminal result when the work first completes, using
  append-and-close for finite turn/result streams;
- `map` projection used by the scheduler's central race;
- thenable behavior for the scheduler/lib contract.

For firelab and unit tests, an in-process awaitable can implement the
same interface without Durable Streams.

After this split, the difference between an in-process package and a durable
package is one `AwaitableLib` plus one operations layer. The scheduler is shared.

## Action 3: Cut Durable Runtime Surface

After the extraction, `fluent-runtime` is the durable side of the seam:

| Concern | Default answer | Durable substrate |
|---|---|---|
| Session start | append launch/session intent and materialize session state | session event rows |
| Prompt / turn | append prompt intent, create finite turn stream, close turn stream on terminal result | session event + finite turn stream |
| Harness `run` | replay deterministic journal entries | journal-backed awaitable only |
| `sleep` / `wait_until` | replay existing wake result; timer mechanism materializes wake facts after crash | timer facts + subscription handler, not workflow orchestration |
| `wait_for` | snapshot-first projection read, then stream subscription | wait intent/result rows only when suspension is durable |
| External approval / promise | external party resolves a parked future | webhook or pull-wake subscription handler appends result and acks |
| Agent/session crash recovery | claim a pull-wake subscription and re-drive the harness from streams | subscription claim/ack/release, not custom lease infrastructure |
| `spawn` / `spawn_all` | create child session stream with `Stream-Forked-From` and fork offset; wait on child projection/turn close | stream fork, no durable routine rows and no child-intent row |
| combinators | replay and scheduler orchestration | no |
| channels | local coordination only | no |
| tool/sandbox execute | claim before externally visible effect, append result/failure | claim/result rows, not task rows |
| webhook ingest | Durable Streams subscription webhook appends/wakes external adapters | yes: subscription/webhook adapter, not Effect Workflow |
| cancellation delivery | append stop/cancel intent, scheduler fanout at yield boundary | no durable routine row family by default |

This cuts the durable surface from seven primitive families to one timer
mechanism plus Durable Streams subscription handlers:

1. **Timer materialization.** A sleeping turn/harness needs a durable fact when
   wall-clock time arrives.
2. **Pull-wake handlers.** Runtime-owned work claims subscription wakes,
   re-drives harnesses, appends results, and ack/releases through the
   substrate's generation-fenced lease protocol.
3. **Webhook handlers.** External integrations receive signed subscription
   callbacks, append durable facts, and rely on `{ done: true }` auto-ack when
   complete.

Everything else should first be justified against the question: would
deterministic replay handle this? In-session routines, combinators, channels,
and most retry composition should collapse to replay over session and finite
turn streams.

## Action 4: Decide Scheduler Ownership

The Restate model gets restart safety by deterministic re-execution off the
journal. Spawned routines are in-memory fibers. On restart, the handler runs
again; journal-backed awaitables replay; spawned fibers are reconstructed by the
same deterministic generator path.

The earlier version of this SDD proposed durable `RoutineStarted` /
`RoutineCompleted` rows and reclaim workers. That is a heavier model and should
not be the default. Durable child sessions are Durable Streams forks; local
routine futures are reconstructed by deterministic replay.

Decision needed:

- Prefer Restate-style deterministic replay for spawned routines, combinators,
  and channels.
- Add durable routine rows only if a firelab crash/restart simulation
  proves replay cannot reconstruct local routine futures.
- Use Durable Streams `fork` for agent `spawn` / `spawn_all` child sessions
  before inventing child-session row families.

There is a second decision hidden in the current implementation:
`fluent-firegrid` currently leans on Effect primitives such as `Deferred`,
`Effect.all`, and `forkDaemon` for parts of combinator execution. Restate
hand-rolls a small cooperative scheduler with one central await point. That
central await point is what makes cancellation clean: one race observes
cancellation, then the scheduler fans it out to every parked routine at yield
boundaries.

Effect fibers remain appropriate for subscription handlers and local process
plumbing. They should not replace the explicit Operation/Future scheduler if
the required semantics are Restate-like cancellation fanout,
wait-for-all-routines before returning, and substrate-free replay.

Source check: `repos/effect/packages/effect/test/Effect/forking.test.ts`
confirms Effect's local fiber guarantees are useful but local. `fork` propagates
interruption, interruption status is inherited, `forkAll` preserves result
order, and failures/defects propagate through joins. Those are good building
blocks for runtime handlers and subscription adapters. They are not, by
themselves, durable child-session semantics; Durable Streams `fork` owns that
job.

## Effect Architecture Direction

The runtime package should still look like ordinary Effect application code:

- domain-first files, not infrastructure-first folders;
- ingress-first API definition with `HttpApi` as the control-plane contract;
- `Context.Tag` service boundaries;
- `Layer` composition for runtime, store, subscription handlers, HTTP, and
  clients;
- `Scope` for HTTP servers, stream followers, subscription handlers, and
  resources;
- `Queue`, `PubSub`, and `Stream` for local process plumbing around Durable
  Streams follow/subscription events;
- `Schedule` for retry/backoff policy compilation;
- `Exit`, `Cause`, and tagged errors for terminal result shapes;
- `Schema`, `Schema.Class`, and `Schema.TaggedError` for request, result, row,
  and error codecs;
- `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`, `HttpApiBuilder`, and
  `HttpApiClient` for the front door and derived clients;
- `HttpApiSwagger` for documentation from the same API definition;
- `HttpRouter` only for health checks, websocket probes, diagnostics, and
  firelab controls.

## Layer Diagram

```text
+-----------------------------------------------------------------------+
| fluent API layer                                                      |
| @firegrid/fluent-firegrid                                             |
| gen/run/sleep/state/all/race/select/spawn/channel                     |
| Operation/Future engine, substrate-free scheduler, Awaitable seam      |
+---------------------------------------+-------------------------------+
                                        | Awaitable<T> / AwaitableLib
+---------------------------------------v-------------------------------+
| fluent runtime layer                                                   |
| @firegrid/fluent-runtime                                               |
| HttpApi control plane, derived clients, durable awaitable producers,   |
| sessions, turns, harness routing, timer materialization, Durable       |
| Streams subscription handlers, optional MCP adapter                    |
+---------------------------------------+-------------------------------+
                                        | append/read/follow/subscribe
+---------------------------------------v-------------------------------+
| durable streams infrastructure                                         |
| append-only journals, session/turn streams, stream forks, timer facts, |
| sandbox/resource/tool streams, webhook and pull-wake subscriptions     |
+-----------------------------------------------------------------------+
```

The intended payoff is the same or better runtime capability than
`packages/runtime`, but with less architectural weight: a small composable DSL
engine, one explicit awaitable seam, one traditional HTTP control plane, and a
Durable Streams data plane.

## MCP Adapter Stance

MCP should not force the core runtime shape. The Effect AI
`repos/effect/packages/ai/ai/src/McpServer.ts` already exposes a conventional
Effect service for tools, resources, prompts, stdio, and HTTP layers. A future
MCP edge can be an adapter that registers tools/resources over the fluent
control plane and returns Durable Streams subscription URLs for long-running
observation.

That avoids customizing the runtime around bleeding-edge MCP async task call
semantics. The fluent HTTP interface remains a traditional control plane;
clients that need async progress subscribe to the durable stream exposed in the
control-plane response.

## Composition Sketch

```ts
const RuntimeLive = Layer.mergeAll(
  Sessions.Live,
  Harness.Live,
  Tools.Live,
  Sandboxes.Live,
  Resources.Live,
  Components.Live,
  Timers.Live,
  Webhooks.Live,
  Awaitables.Live,
).pipe(
  Layer.provide(Store.Live({ baseUrl })),
)

const HttpLive = FluentRuntime.HttpLive.pipe(
  Layer.provide(RuntimeLive),
  Layer.provide(NodeHttpServer.layer(createServer, { port })),
)

NodeRuntime.runMain(Layer.launch(HttpLive))
```

For firelab:

```ts
export const host = FluentRuntimeTestHost.layer({
  durableStreams: memoryDurableStreams,
  agents: [researcher],
  tools: [repoSearch],
  resources: ["repo:firegrid"],
})

export const driver = Effect.gen(function* () {
  const client = yield* FluentRuntime.Client
  const session = yield* client.sessions.start({ agent: "researcher" })
  yield* session.prompt("Inspect this repo.")
})
```

## Migration Plan

1. **Extract engine files in `fluent-firegrid`.** Split the monolithic
   `index.ts` into Restate-shaped engine modules without changing behavior,
   including a real `Fiber` type.
2. **Introduce `Awaitable` / `AwaitableLib`.** Move combinators and scheduler
   waiting onto the seam.
3. **Move journaling into operation producers.** `Scheduler` stops importing
   Durable Streams and stops appending journal rows.
4. **Prove replay slice again.** Existing durable `run` replay tests should
   pass with the scheduler substrate-free.
5. **Decide scheduler ownership.** Keep the explicit scheduler if cancellation
   fanout and central-await semantics are required.
6. **Audit replay versus rows.** Cut durable rows to timer facts, stream forks,
   claim/result evidence for external effects, and subscription handler results
   unless a sim proves otherwise.
7. **Define ingress first.** Create the `HttpApi` contract and derive server,
   Swagger docs, and typed client from it before adding alternate bindings.
8. **Add firelab runtime workbench.** Build `fluent-runtime` as the
   durable `AwaitableLib`, durable operation producers, subscription handlers,
   fork-backed child sessions, finite turn streams, and front-door session/turn
   routing.
9. **Plan production cutover.** Only after simulations prove the trace model,
   start replacing isolated production runtime entrypoints.

Recommended firelab proof sequence:

1. Fork a child session stream from a parent stream and prove the child reads
   inherited history through the fork offset, then diverges.
2. Append a terminal turn result with `Stream-Closed: true` and prove replay
   treats closure, not `Stream-Up-To-Date`, as completion.
3. Simulate a restart with idempotent producer id/epoch/seq and prove replay
   reads back before re-executing a side-effecting step.
4. Exercise pull-wake claim/ack/release for harness re-drive.
5. Exercise webhook subscription auto-ack on `{ done: true }`.

## Non-Goals

- Do not import from `packages/runtime`.
- Do not expose Durable Streams writer handles in user DSL.
- Do not make a second scheduler in `packages/fluent-runtime`.
- Do not make firelab a pass/fail harness; it remains a simulation
  workbench with traces and findings.
- Do not add durable row families for in-memory scheduler concepts until a
  restart simulation proves deterministic replay is insufficient.
- Do not add a backing interface with `sleep` or `spawn` verbs; the seam is
  `Awaitable`, and `spawn` is scheduler-local unless proven otherwise.
- Do not infer terminal work completion from `Stream-Up-To-Date`; use
  `Stream-Closed`.

## Source Notes

- Restate `awaitable.ts` defines the real substrate seam:
  `Awaitable<T>` plus `AwaitableLib`.
- Restate `scheduler.ts` depends on `AwaitableLib`, creates local fibers for
  `spawn`, and never writes journal rows.
- Restate `current.ts` documents why the module-global current slot is safe:
  generators yield synchronously and the slot is cleared before any await.
- Restate `restate-operations.ts` and `default-lib.ts` show durability living
  outside the scheduler, as operations and the production awaitable library.
- Current `packages/fluent-firegrid/src/index.ts` source-verifies the divergence:
  `Scheduler` owns Durable Streams replay/append and the recursive interpreter.
- `packages/client-sdk/README.md` provides client ergonomics inspiration:
  browser-safe app APIs, explicit config, scoped durable session handles,
  permission responses, MCP tool attachment, and the rule that app clients
  should not expose tables, stream row builders, workflow handles, or live
  runtime authority.
- Top-level `README.md` defines the product surface as durable agent tools:
  `wait_for`, `wait_until`, `sleep`, `spawn`, `spawn_all`, and `execute`; app
  clients start/configure sessions and observe durable events, while the model
  owns choreography through tools.
- Effect platform `README.md` documents the `HttpApi` model used here: one API
  definition for server implementation, generated documentation, and typed
  clients via `HttpApiClient`.
- Effect AI `McpServer.ts` exposes MCP as an ordinary Effect service with tool,
  resource, prompt, stdio, and HTTP layer registration, so MCP can stay an
  adapter over the fluent control plane and streams.
- Fireline `rfc/concepts/background.md`,
  `rfc/concepts/managed-agent-primitives.md`, and
  `rfc/concepts/terminology.md` define the managed-agent vocabulary used here:
  Session, Orchestration, Harness, Sandbox, Resources, Tools, Prompt/Turn,
  durable log, operator, claim, live resource, and durable awaitable.
- Fireline `rfc/concepts/choreography-and-combinators.md` and the retired
  `vault/canon/concepts/choreography-vs-orchestration.md` anchor the
  choreography-first stance: durable tools and stream observation instead of a
  workflow orchestration SDK.
- Durable Streams `subscription-manager.ts` lines 543-619 create webhook wakes,
  deliver signed callbacks with callback URLs/tokens and stream tail state, and
  auto-ack when the webhook returns `{ done: true }`.
- Durable Streams `PROTOCOL.md` specifies stream fork, stream closure,
  idempotent producers, webhook subscriptions, pull-wake claim/ack/release, and
  the distinction between `Stream-Up-To-Date` and `Stream-Closed`.
- Current upstream Durable Streams server source implements fork parsing and
  forked reads in `packages/server/src/server.ts`, `store.ts`, `file-store.ts`,
  and `types.ts`; local `packages/effect-durable-streams` does not yet expose a
  first-class fork helper.
- Effect `forking.test.ts` verifies local fiber interruption inheritance,
  interruption propagation, `forkAll` result ordering, and failure/defect
  propagation. Use those semantics for process-local plumbing, not durable
  child-session identity.
- The Effect examples repository's `http-server/src` tree is organized around
  domain/resource modules plus thin aggregate `Api.ts`, `Http.ts`, `client.ts`,
  and `main.ts`; `fluent-runtime` should keep that style for the durable layer.
