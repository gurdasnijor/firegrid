# Launchable Substrate Host And Lab SDD

Status: proposal
Created: 2026-05-04
Owner: Durable Agent Substrate

## Purpose

The substrate now has enough library-level proof to start running real
prototype runtimes on top of it. Unit tests prove individual semantics, but
Fireline/Firepixel-like systems need a launchable local process, a narrow
client, and a developer lab that can exercise increasingly realistic flows
against durable streams and materialized state.

This SDD defines that next layer:

```text
@durable-agent-substrate/client
  durable intent producer + curated read client

@durable-agent-substrate/host
  launchable observer/operator process

@durable-agent-substrate/lab
  example/dev consumer built on the client
```

The key design decision is negative: the host is not a command/control API, and
the lab is not privileged. Application and lab writes should flow through the
same substrate-specific client that appends durable records. The host observes
durable state and runs configured substrate programs. The lab can provide
buttons and forms, but those controls use the client surface, not hidden host
mutation endpoints or special lab-only writer paths.

## References

- Durable Agent Substrate SDD: `docs/SDD_DURABLE_AGENT_SUBSTRATE.md`
- Client event planes SDD:
  `docs/SDD_CLIENT_EVENT_PLANES_AND_STATE_PRODUCERS.md`
- Fireline client altitude reference:
  `/Users/gnijor/gurdasnijor/firepixel/packages/client/README.md`
- Durable Streams test UI prior art:
  `https://github.com/durable-streams/durable-streams/blob/main/examples/test-ui/README.md`
- Restate quickstart and SDK split:
  `https://docs.restate.dev/get_started/quickstart/`
- Restate TypeScript service/runtime SDK:
  `https://docs.restate.dev/develop/ts/services`
- Restate TypeScript client SDK:
  `https://docs.restate.dev/services/invocation/clients/typescript-sdk`
- Apache Flink deployment overview:
  `https://nightlies.apache.org/flink/flink-docs-stable/docs/deployment/overview/`

The Durable Streams test UI is useful for inspector mechanics: stream registry,
live following, catchup, JSON rendering, and responsive stream inspection. It is
not a model for substrate command endpoints.

Restate is useful prior art for package altitude: a server-side runtime SDK for
defining durable behavior, a standalone client SDK for external callers, and a
launchable runtime/server that owns execution. The substrate should borrow that
split, not Restate's ingress model. In this substrate, external callers append
durable intent through the client, and the host observes durable state and runs
a caller-supplied Host Program Graph.

Flink is useful prior art for the executable runtime seam. A Flink client turns
an application into a job graph; the runtime then coordinates sources,
operators, and sinks. The substrate equivalent is the Host Program Graph:
runtime-owned event planes, subscriber programs, operator programs, evaluators,
and adapter service layers that a `SubstrateHost` runs against durable state.
The graph is provided in process at host startup; it is not submitted through a
host mutation endpoint or stored in a global/durable registry in v1.

## Goals

1. Make the substrate launchable in local development.
2. Provide a narrow client that produces durable intent rows and exposes curated
   reads without exposing raw stream/state internals at the root.
3. Provide a host process that runs substrate observers, subscribers,
   projection-match evaluators, and operator loops from durable state.
4. Provide a lab UI that helps inspect streams/state and run prototype scenarios
   through the same client used by applications.
5. Enable gradually more realistic Fireline/Firepixel-shaped runtimes without
   making Fireline, Firepixel, ACP, MCP, or process launch substrate-native.

## Non-Goals

- No mutable HTTP control plane for application commands.
- No `POST /start-work`, `POST /resolve-permission`,
  `POST /run-scenario`, or similar host-owned writer surface.
- No raw append facade on the normal client root.
- No ACP, Fireline, Firepixel, session, prompt, provider, sandbox, process, or
  transport vocabulary as substrate-native row families.
- No workflow SDK or continuation replay runtime.
- No replacement for Durable Streams protocol, state schema, or StreamDB.
- No final production observability story; use Effect/host instrumentation and
  keep durable trace history deferred.

## Layering

```text
applications / agent runtimes / lab
  -> @durable-agent-substrate/client
      append durable intents
      read curated projections

@durable-agent-substrate/host
  observe durable streams/state
  run a Host Program Graph of subscribers and operator programs
  expose read-only diagnostics and lifecycle status

Durable Streams + Durable State
  source of truth
```

The client is how any consumer talks to the substrate. The host is how the
substrate makes progress. The lab is one consumer of the client plus optional
read-only diagnostics; it is not a third authority layer.

## Schema And Type Ownership

Every durable participant can append records to Durable Streams, but schema
ownership stays with the row family owner:

- substrate-owned rows (`durable.run`, `durable.completion`,
  `durable.claim.attempt`, and substrate trace rows if used) are defined once in
  `@durable-agent-substrate/substrate` as Effect Schema values with inferred
  TypeScript types;
- client and host code import substrate-owned schemas, types, state helpers, and
  transition builders from the substrate package instead of redefining parallel
  row shapes;
- caller-owned event-plane rows are defined by the runtime or application that
  owns that plane, using `EventPlane.define(...)` and the caller's
  `createStateSchema(...)` value;
- host-local configuration, diagnostic status, and process-lifecycle types are
  owned by `@durable-agent-substrate/host` because they are not durable
  substrate row families;
- client request/input types are owned by `@durable-agent-substrate/client`, but
  when they lower into durable substrate rows they must use substrate-owned row
  schemas and producers.

The rule is intentionally simple: row family owner equals schema and type source
of truth. Avoid a shared `types` package for now; it would make ownership less
clear and expand the low-level concept space without adding authority. If a
later package needs a schema, it should depend on the package that owns that row
family or define its own caller-owned event plane.

## Restate-Inspired Package Roles

Restate separates three roles that are worth preserving at the package-boundary
level:

- a server-side runtime SDK that authors durable behavior close to handlers;
- a standalone client SDK that invokes or schedules work from outside the
  runtime;
- a launchable runtime/server that owns execution, recovery, and operational
  lifecycle.

The substrate should map those roles without copying Restate's central service
ingress model:

```text
@durable-agent-substrate/substrate
  foundation library and Effect-native server-side primitives
  Choreography, Projection, Work, EventPlane, subscribers, operator helpers

@durable-agent-substrate/client
  Effect-native app-facing SDK for durable intents and curated reads

@durable-agent-substrate/host
  Effect-native launchable runtime process and withHost-style dev/test composition

@durable-agent-substrate/lab
  example/dev application built on the client
```

The first launchable substrate should be Effect-native. Non-Effect wrappers may
be added later for external client use, but they must be thin wrappers over the
Effect-native client and must not attempt to expose runtime suspension until a
real call site needs it.

Likewise, `SubstrateHostBoot.withHost(...)` may provide `SubstrateClient` to
the program it runs, but that client is the same capability as the standalone
client. `withHost` owns lifecycle composition in development; it is not a
different writer surface. (`withHost` is a function on the
`SubstrateHostBoot` constructor namespace alongside `attached`, `embeddedDev`,
and `attachedFromConfig`; it is not a static method on the `SubstrateHost`
Context.Tag class.)

The implementation may use either `Context.Tag` plus explicit `Live` / test
Layers or Effect's `Effect.Service` helper where it simplifies a service
definition. The design requirement is not the specific helper; it is that
services have stable interfaces, dependencies are supplied by Layers, and tests
can substitute Layers without changing durable semantics.

## Firepixel Shape Review

Firepixel has a useful shape to preserve while removing Firepixel-specific
vocabulary from the substrate:

- `@firepixel/client` exposes a narrow app client over scoped StreamDB state,
  durable intent writers, and curated session/prompt/operator read handles.
- `@firepixel/runtime` exposes thin Effect layer constructors:
  `attached`, `attachedFromConfig`, `attachedRuntime`,
  `attachedRuntimeFromConfig`, `attachedRuntimeClient`, and
  `withAttachedRuntime`.
- `@firepixel/cli` boots a runtime participant in either embedded mode
  (starts `DurableStreamTestServer`) or attached mode (joins an existing stream),
  prints readiness, and waits for process interruption.
- `@firepixel/core` owns boot-plan decoding with Effect `Config`, generated
  process identity by default, stream URL selection, embedded Durable Streams
  settings, and auth header materialization.
- `OperatorsLive(processId)` is an Effect scoped layer that forks operator
  fibers. Runtime adapters and live resources are ordinary layers, so
  process-local live handles stay outside durable state.

The substrate should adopt the shape, not the domain names:

```text
SubstrateClient service + Layer constructors
SubstrateHostBoot.attached / attachedFromConfig
SubstrateHostBoot.embeddedDev / bootPlanFromConfig
SubstrateHostBoot.withHost
SubstrateHostLive(plan, { program })
```

The important ergonomic property is compositionality. A Firepixel-like runtime
should provide a Host Program Graph to the host instead of forking its own
process control surface:

```ts
const FirelineHostProgram = HostProgramGraph.define({
  name: "fireline",
  layer: Layer.mergeAll(
    HostPrograms.timerSubscriber(),
    HostPrograms.scheduledWorkSubscriber(),
    HostPrograms.projectionMatchSubscriber(permissionMatcher),
    HostPrograms.operator(promptOperator),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        EventPlane.layer(AcpEventPlane, acpPlaneConfig),
        LocalModelAdapterLive,
      ),
    ),
  ),
})

const program = SubstrateHostBoot.withHost(
  Effect.gen(function* () {
    const substrate = yield* SubstrateClient
    return yield* substrate.work.observe("run:demo").snapshot()
  }),
  {
    mode: "embedded-dev",
    streamName: "firepixel-prototype",
    clientId: "prototype:lab",
    program: FirelineHostProgram,
  },
)
```

This keeps operational complexity low: the host owns process lifetime and
subscribers/operators, the Host Program Graph owns program wiring, and ordinary
Effect Layers own adapter choices and test replacements. The client owns durable
intent production. This is tracked by the Host Program Graph requirements in
`launchable-substrate-host.RUNTIME_COMPOSITION.1` and
`launchable-substrate-host.RUNTIME_COMPOSITION.2`.

## Client Surface

The client should follow the Fireline client altitude:

- one Effect-native app-facing package;
- scoped Effect service/layer APIs as the canonical surface;
- durable intent methods;
- curated read handles;
- explicit subpaths for operator/testing/diagnostics;
- no raw stream, raw StreamDB collection, or raw row helper exports at the root.

The canonical client surface is Effect-native:

```ts
import { Effect, Stream } from "effect"
import { SubstrateClient, SubstrateClientLive } from "@durable-agent-substrate/client"

const program = Effect.gen(function* () {
  const substrate = yield* SubstrateClient
  const work = yield* substrate.work.declare({
    idempotencyKey: "demo:review-1",
    input: { kind: "review", target: "README.md" },
  })

  yield* substrate.choreography.scheduleAt({
    at: new Date("2026-05-04T17:00:00.000Z"),
    input: { prompt: "Follow up on review" },
  })

  return yield* substrate.work.observe(work.workId).snapshot()
})

await Effect.runPromise(
  program.pipe(Effect.provide(SubstrateClientLive({ streamUrl, clientId: "lab" }))),
)
```

`SubstrateClientLive(config)` is a parameterized Layer constructor, not a class
instance. A future config-driven constructor should use Effect `Config` and
`Layer.unwrapEffect` so production boot can decode the client layer from the
same configuration source as the host.

When the client API is revisited, prefer Effect's naming convention:
`SubstrateClient.layer(config)` for the parameterized constructor and
`SubstrateClientLive` for a config-decoded Layer value.

Non-Effect callers can use `Effect.runPromise(...)` at their own process edge. A
long-lived non-Effect caller such as the lab can use `ManagedRuntime` to build
the client layer once and run many Effects through it. A separate
Promise/AsyncIterable wrapper package is a later compatibility layer, not part
of the first launchable substrate design.

Read handles should make snapshot vs follow behavior explicit:

```ts
await substrate.work.observe(workId).snapshot()

yield* substrate.work.observe(workId).stream().pipe(
  Stream.runForEach((state) => Effect.log(state)),
)

await substrate.work.observe(workId).until((state) => state.state === "completed")
```

`snapshot()` reads the current no-gap materialized view once and returns the
selected state. It does not mutate durable state and is not a live
subscription. `stream()` should return an Effect `Stream.Stream` as the primary
Effect-native surface. Async iterables are compatibility bridges, not the root
client contract.

The exact method names can change, but the boundary should not:

- client writes semantic substrate intents;
- client reads curated projections;
- client hides stream URL and id threading after layer construction;
- operator-only controls live under explicit client subpaths if needed;
- testing harnesses live under explicit client subpaths if needed;
- diagnostic raw stream/state inspection lives under a separate lab/diagnostic
  package, not the production root.

### Client V1 Decisions

The first client surface is intentionally narrow:

- `work.declare({ idempotencyKey, input })` declares a durable run. The
  idempotency key is event metadata/header information, not part of the
  durable.run row value. The input is substrate-generic run data and may be
  represented as an optional `data` field on durable.run, matching the existing
  optional `data` pattern on durable.completion.
- `choreography.scheduleAt(...)` is the only choreography method on the client
  root in v1. `sleep`, `waitFor`, and `awaitAwakeable` require
  `CurrentWorkContext` and remain server-side runtime primitives.
- event-plane write/read APIs take the `EventPlane.define(...)` result at the
  call site. The caller composes the plane layer; the client does not keep a
  global plane registry.
- event-plane reads use the plane projection service for
  `snapshot`/`stream`/`until`, just as substrate reads use curated substrate
  projections.

### Client Responsibilities

The client may:

- declare durable work;
- create choreography intents through the choreography facade;
- emit rows to registered event planes;
- resolve externally owned completions when the caller is authorized by the
  domain-specific program graph;
- expose scoped read handles for runs, completions, ready work, event-plane
  projections, and scenario state;
- expose replay+live streams where the substrate is stream-shaped.

The client must not:

- launch runtime processes;
- perform claim-before-side-effect work;
- run subscribers;
- own projection-match evaluator loops;
- expose raw append as the normal app-facing path;
- expose private StreamDB collection objects from the root.

## Host Process

The host is a launchable process that attaches to a Durable Streams endpoint and
runs configured substrate programs.

Example command shape:

```sh
pnpm substrate host dev --stream-url http://127.0.0.1:4437/v1/stream/substrate
```

In development, a convenience command may start an embedded
`DurableStreamTestServer` with registry hooks:

```sh
pnpm substrate dev
```

For the first launchable slice, embedded Durable Streams dev-server ownership
lives in `packages/host`. A separate CLI/dev package can be introduced later if
process-launch concerns outgrow the host package, but splitting it now would add
package surface without changing semantics.

Host responsibilities:

- start or connect to a Durable Streams server;
- run timer and scheduled-work subscribers;
- run projection-match subscriber programs supplied by the Host Program Graph;
- run claim-before-side-effect operator programs;
- run configured event-plane projection observers;
- expose read-only in-process status, metrics, and health for local tooling;
- shut down through Effect scopes and process signals.

The host does not expose a mutation control plane. If the lab or an application
wants to start a scenario, it uses the client to append the durable start
intent. The host then observes that durable intent and reacts.

### Host Configuration

The host should separate boot planning from the Host Program Graph.

Boot plan:

```ts
type SubstrateHostBootPlan =
  | {
      readonly _tag: "EmbeddedDevHost"
      readonly processId: string
      readonly durableStreams: {
        readonly host: string
        readonly port: number
        readonly streamName: string
      }
    }
  | {
      readonly _tag: "AttachedHost"
      readonly processId: string
      readonly streamUrl: string
    }
```

The boot plan should be decodable from Effect `Config` and from explicit
options:

- `SUBSTRATE_STREAM_URL` selects attached mode;
- missing `SUBSTRATE_STREAM_URL` selects embedded dev mode;
- `SUBSTRATE_DS_HOST`, `SUBSTRATE_DS_PORT`, and `SUBSTRATE_STREAM` configure
  embedded dev mode;
- `SUBSTRATE_PROCESS_ID` is optional and advanced; generated process ids are the
  default;
Auth/header transport is deferred beyond the core launchable lab slice. When it
returns, it should use Effect's `Config` module and `Redacted` values directly;
diagnostics should never unwrap or serialize secret headers.

The Host Program Graph is made of Effect layers and values supplied in process,
not a global registry. It is analogous to a Flink job graph at the semantic
level: the graph describes the executable stream/state programs the host runs,
but it is not submitted through an HTTP control plane. The TypeScript host
surface supports `program: HostProgramGraph`; there is no separate profile mode.

```ts
interface HostProgramGraph<E = never, RIn = never> {
  readonly name: string
  readonly layer: Layer.Layer<never, E, RIn>
}
```

Host Program Graph definitions are named Effect Layer compositions. The `layer`
is executable: it is launched for its scoped effects and should not expose
durable-runtime dependencies through service method signatures. A graph handed
to `SubstrateHostLive` should be fully wired with `RIn = never`; an incompletely
wired graph can remain generic while tests or applications provide missing
services. If graph construction can fail, its `E` parameter should flow into the
host launch Effect's failure channel instead of being converted to a defect by
default.

This follows Effect's layer model: services keep clean interfaces, and Layers
construct and compose their dependencies. The substrate can provide helper
constructors such as `HostPrograms.timerSubscriber()` or
`HostPrograms.operator(...)`, but those helpers return Layers, usually via
`Layer.scopedDiscard` for long-running scoped programs. They do not create a
second registry beside Effect's dependency graph. Serialized config only selects
known local graph definitions in dev; it does not create a mutable runtime
registry.

This means test and production wiring use the same mechanism:

```ts
const RuntimePrograms = Layer.mergeAll(
  HostPrograms.timerSubscriber(),
  HostPrograms.scheduledWorkSubscriber(),
  HostPrograms.operator(promptOperator),
)

const ProductionHostProgram = HostProgramGraph.define({
  name: "production",
  layer: RuntimePrograms.pipe(
    Layer.provide(RemoteModelAdapterLive),
  ),
})

const TestHostProgram = HostProgramGraph.define({
  name: "test",
  layer: RuntimePrograms.pipe(
    Layer.provide(FakeModelAdapterLive),
  ),
})
```

The exact helper names can change during implementation, but the shape should
remain ordinary Layer composition. Host programs should not expose their
construction dependencies through service method signatures; those dependencies
belong in the Layer graph. Use `Layer.mergeAll` for peer programs and
`Layer.provide` when an adapter or service layer satisfies another layer's
requirements.

Host Program Graph discovery in development is explicit:

```ts
const hostPrograms = {
  prototype: PrototypeHostProgramLive,
  fakePermission: FakePermissionHostProgramLive,
} as const

SubstrateHostBoot.embeddedDev({
  streamName: "substrate-prototype",
  program: hostPrograms.prototype,
})
```

Config may select a key from a caller-supplied local map, but the substrate does
not dynamically import arbitrary modules, maintain a global registry, or fetch
Host Program Graph definitions from durable state.

### Host-Managed Subscriber Programs

Timer, scheduled-work, projection-match, and operator programs are host-managed
programs expressed through the Host Program Graph. The host owns the scoped
program fibers; the substrate single-shot subscriber and operator functions
remain the authority for catch-up scan-and-resolve behavior.

This is not intended to be a naive polling loop. The durable-subscriber model
is subscription/progress oriented:

- active programs follow durable stream/state changes;
- due-time programs also schedule a wake-up for the nearest known due time;
- restart safety comes from durable records, not process-local memory;
- duplicate terminalization attempts remain harmless under completion and claim
  authority.

Spec anchors:

- `launchable-substrate-host.HOST_PROCESS.3`
- `launchable-substrate-host.HOST_PROCESS.4`
- `launchable-substrate-host.HOST_PROCESS.5`
- `launchable-substrate-host.RUNTIME_COMPOSITION.1`
- `launchable-substrate-host.RUNTIME_COMPOSITION.2`
- `launchable-substrate-host.RUNTIME_COMPOSITION.3`
- `launchable-substrate-host.RUNTIME_COMPOSITION.9`
- `launchable-substrate-host.AUTHORITY_BOUNDARY.2`
- `launchable-substrate-host.NO_CONTROL_PLANE.1`
- `launchable-substrate-host.NO_CONTROL_PLANE.3`

The host does not have a second subscriber configuration shape. To run timer or
scheduled-work subscribers, include `HostPrograms.timerSubscriber()` or
`HostPrograms.scheduledWorkSubscriber()` in the graph. Per-kind tuning should
only be introduced if implementation genuinely needs it, and should live in
explicit Layer constructors rather than a polling-shaped tuning knob.

Each subscriber program is sequential for its own subscriber kind. A new wake-up
does not start a second scan if the previous scan is still running. Wakes should
come from the durable subscription boundary or the next known due-time deadline,
not from a fixed poll cadence. This keeps timer and scheduled-work resolution
easy to reason about and avoids turning the host into a second authority; the
underlying state machine and subscribers still decide which completions can
terminalize.

Wakes are coalesced rather than dropped. If a stream-edge or due-time wake
fires while a scan is already running, the runner records the wake and arms
exactly one follow-up scan that runs after the current one finishes. The
follow-up scan executes a fresh authoritative scan: the runner re-invokes the
existing single-shot subscriber function, which rebuilds from durable state
and decides terminalization. No observed change is silently lost. This
coalescing is a host-local execution detail; it is not durable subscriber
progress authority and does not replace completion/cursor/retry/terminalization
records.

The existing single-shot functions are still useful as the terminalization
primitive:

- on startup, run a catch-up scan from retained durable state;
- after a relevant durable state change, run a catch-up scan;
- when the nearest known due-time deadline arrives, run a catch-up scan.

That shape lets the first implementation reuse `runTimerSubscriber` and
`runScheduledWorkSubscriber` without baking in a polling API. A future active
delivery subscriber can add durable cursor/progress records without changing the
host/client boundary.

Subscriber status should be projection-first. Durable state such as pending
timer completions, pending scheduled-work completions, resolved terminal rows,
blocked runs, and future subscriber progress or cursor records should be read
from Durable Streams / Durable State projections.

Host-local lifecycle state is only diagnostic. It can say which graph this
process launched and whether future supervised fibers are alive, but it is not
subscriber progress authority and it must not replace durable cursor, retry,
dead-letter, completion, or terminalization records.

Future network diagnostics, if a release need proves them necessary, can later
combine durable projections for substrate facts with ephemeral process status.
The core launchable lab slice should not create HTTP routes or a host-local
liveness service.

Counts, cursor positions, retry/dead-letter state, and durable terminalization
history should come from durable records/projections once the corresponding row
families exist. For the timer/scheduled-work slice, the authoritative facts are
already the `durable.completion` rows and their terminal folds.

### Host Composition API

The host package should expose thin constructors that mirror Firepixel's best
runtime API pattern:

```ts
SubstrateHostBoot.attached({ streamUrl, processId, program })
SubstrateHostBoot.attachedFromConfig({ program })
SubstrateHostBoot.embeddedDev({ streamName, durableStreamsPort, program })
SubstrateHostBoot.bootPlanFromConfig
SubstrateHostBoot.withHost(effect, options)
```

`SubstrateHost` remains the host service identity. `SubstrateHostBoot` is a
plain constructor namespace for Layer-producing helpers; `withHost` is not a
static method on the `SubstrateHost` service tag.

`withHost` is a development and test convenience that provides both the
substrate client and the host layer to one Effect program. It should not blur
the production process boundary: production apps normally run clients in app
processes and hosts in worker/runtime processes.

When `withHost` provides `SubstrateClient`, that client is the same capability
exposed by the standalone Effect-native client package. The only difference is
lifecycle ownership: standalone client programs attach to an existing
stream/runtime environment, while `SubstrateHostBoot.withHost(...)` starts or
attaches the host and provides a client connected to that same durable stream
for the lifetime of the scope.

The first `withHost` implementation slice should stay narrow:

- compose the existing host and client capabilities in one Effect scope;
- use `Effect.scoped`, `Layer.scoped`, and `Scope` finalization for owned
  resources;
- expose no host mutation endpoints and no network diagnostics listener;
- provide the same `SubstrateClient` service shape as the standalone client;
- avoid creating a runtime registry or loading Host Program Graph definitions
  dynamically;
- keep process-signal handling out of scope unless the slice explicitly owns
  signal trapping and tests it.

That slice may claim `launchable-substrate-host.PACKAGING.6`,
`launchable-substrate-host.RUNTIME_COMPOSITION.5`,
`launchable-substrate-host.RUNTIME_COMPOSITION.6`, and
`launchable-substrate-host.RUNTIME_COMPOSITION.7` when the helper is implemented
and tested. It should not claim `launchable-substrate-host.HOST_PROCESS.7`
unless process-signal handling is implemented in addition to Effect-scoped
finalization, and it should not claim `launchable-substrate-host.HOST_PROCESS.6`
or `launchable-substrate-host.HOST_DIAGNOSTICS.*` unless an in-process
diagnostic service is intentionally added.

### Host Program Graph Boundary

A Firepixel-like agent runtime should sit above the host as a Host Program
Graph:

- define its event planes;
- compose projection-match evaluator programs;
- compose operator programs that consume ready work or event-plane projections;
- provide adapter, session, and resource layers;
- decide whether to use local processes, remote agents, or fake test adapters.

The substrate host runs the Host Program Graph. The graph owns agent semantics.
The durable substrate remains generic.

### Host Program Graph Slice

The Host Program Graph slice made the graph the explicit host runtime contract
before broad lab UI work began. Its purpose was not to introduce a framework
registry; it gave the existing host a typed in-process graph of runtime programs
it can run.

Implemented scope:

- `HostProgramGraph` is a named wrapper around an ordinary Effect `Layer`;
- runtime dependencies and host programs compose through ordinary Effect Layers
  rather than separate registry fields;
- timer and scheduled-work subscriber programs run through `HostPrograms` Layer
  constructors;
- projection-match subscriber programs use caller-owned evaluator wiring;
- claim-before-side-effect operator programs consume substrate ready work;
- graph discovery is explicit through caller-supplied local maps;
- the host exposes no mutation endpoints, no HTTP diagnostics listener, and no
  durable program registry.

Scenario ACIDs should remain unclaimed until the corresponding lab/CLI example
program entry actually exists.

## Lab UI

The lab is an example/dev application built on the same substrate client that
any consuming runtime would use. It can offer richer visualization and scenario
buttons, but it does not get a privileged writer API and it does not use the
host as a mutation backend. It can reuse Durable Streams test UI ideas:

- stream registry discovery;
- raw stream view for diagnostics;
- live follow with catchup;
- JSON rendering;
- content-type-aware rendering;
- stream list and selected stream detail;
- state/projection panels.

Substrate-specific panels should include:

- substrate runs;
- durable completions;
- claim attempts and claim winners;
- ready work;
- subscriber scan summaries;
- event-plane snapshots;
- scenario state;
- current host status.

Scenario buttons in the lab should not call host mutation endpoints. They should
call the same client APIs that an application or prototype runtime would call:

```text
Lab button
  -> @durable-agent-substrate/client
  -> append durable intent row
  -> host observes durable state
  -> subscribers/operators react
  -> lab observes projections
```

This keeps the lab honest: if a scenario cannot be expressed through the client,
the client surface is not ready.

Raw stream views are diagnostic panels, not the app-facing path. They should be
visually separated from scenario controls so users can tell the difference
between "inspect what happened" and "write a durable intent through the client."

## Example Programs

Initial example programs should be Fireline/Firepixel-shaped without importing
Fireline or Firepixel. A scenario is not a substrate or host runtime
abstraction; it is an ordinary Effect program that uses the existing
`SubstrateClient`, `SubstrateHostBoot.withHost`, and Host Program Graph APIs.
The lab can keep a small local map of names to programs for CLI/UI selection,
but that map is lab-local metadata, not a registry, service definition, or
durable catalog.

1. Sleep example program
   - client declares work;
   - choreography sleep creates a timer completion and blocks work;
   - host timer subscriber resolves it;
   - ready work is derived;
   - operator completes the run;
   - lab shows raw stream, completion, ready work, and terminal run.

2. Scheduled work example program
   - client calls `scheduleAt`;
   - host scheduled-work subscriber resolves at due time;
   - Host Program Graph maps resolved scheduled work into a domain event;
   - lab shows that `scheduleAt` did not block the caller.

3. Fake permission example program
   - a caller-owned event plane records a required-action row;
   - client waits with projection-match trigger;
   - lab or policy client emits a resolution row;
   - host projection-match subscriber resolves the completion;
   - work becomes ready.

4. Tool-call-shaped execution example program
   - a caller-owned event plane records a tool execution request;
   - an operator program claims ready execution work;
   - fake adapter service performs the side effect;
   - terminal domain row is emitted;
   - lab proves claim-before-side-effect ordering.

Example program entries live under `packages/lab` for the first slice. They are
development examples, not production client/testing API. Each entry should be a
plain object only where metadata is useful, for example `{ name, program }`,
where `program` is an `Effect` requiring existing services rather than a new
scenario runtime type. Each entry should be runnable from the command line and
from the lab UI, with both paths using the same client package and program
definitions.

The lab package is internally split by execution surface:

- `packages/lab/src` is the browser-side surface. It is bundled by Vite
  and may import only `@durable-agent-substrate/client` and external
  packages. The repository ESLint configuration enforces that surface as
  client-only — `@durable-agent-substrate/host` and
  `@durable-agent-substrate/substrate` are not allowed there.
- `packages/lab/runner` and `packages/lab/bin` are Node-only dev harness
  paths. They may import `@durable-agent-substrate/host` to launch a
  Host Program Graph and orchestrate `SubstrateHostBoot.withHost` for
  the example programs. They are not bundled into the browser app and
  do not become a privileged writer surface — application and lab UI
  writes still flow exclusively through `@durable-agent-substrate/client`.

Program kickoff Effects (the part each example program runs against
`SubstrateClient`) live under `packages/lab/src/programs` so the same
kickoff can be invoked from the browser UI and from the Node runner.
Host Program Graph definitions and the Node CLI live under
`packages/lab/runner` and `packages/lab/bin` respectively.

## Host Diagnostics

Host diagnostics are deferred beyond the core launchable lab slice. This keeps
the host from becoming an operational side channel and preserves the durable
stream as the only application command path. HTTP, Unix socket, in-process
status services, or other diagnostics surfaces should only be introduced when a
release need proves they are worth the extra surface area.

If a future slice introduces diagnostics, they must be read-only and must not
expose endpoints that start work, resolve actions, or mutate substrate streams.
Auth/secret diagnostics are deferred with auth/header transport.

## Relationship To Event Planes

The launchable host should support event-plane entries in the Host Program
Graph, but it must not own their domain vocabulary. A graph entry registers:

- event-plane definition;
- stream URL;
- projection queries;
- optional subscriber evaluator adapter;
- optional operator program that consumes projected rows.

Event-plane rows are observational, eligibility-producing, or terminal-domain
facts depending on the Host Program Graph entry. They never replace substrate
claim authority or completion authority.

## Relationship To Choreography

The host runs the drivers that make choreography useful outside tests:

- timer subscriber for sleep;
- scheduled-work subscriber for scheduleAt;
- projection-match subscriber for waitFor;
- operator programs for ready work;
- future runtime-specific resume policy.

The choreography facade writes durable records and blocks runs where
appropriate. The host makes progress by observing those durable records. The
client and lab should not call private `blockRun` helpers directly.

## Packaging

Proposed packages:

```text
packages/client
packages/host
packages/lab
```

The substrate package remains the foundation library. The client package is the
normal application dependency. The host package is the launchable process. The
lab package is dev tooling.

Production exports should stay narrow and Effect-native first:

```text
@durable-agent-substrate/client
@durable-agent-substrate/host
@durable-agent-substrate/lab
```

Optional operator/testing client subpaths can be added when real call sites need
them. Raw stream inspection belongs to lab/diagnostics, not the client root.

## First Implementation Slice

The first slice should prove:

1. a package boundary for `packages/client`, `packages/host`, and `packages/lab`
   without filling every feature;
2. an Effect-native client resource shape against a Durable Streams URL;
3. a client method that declares work through existing substrate producers;
4. a host boot plan with embedded-dev and attached modes, Effect Config
   decoding, generated process identity, and auth header materialization;
5. a host dev process that starts or connects to `DurableStreamTestServer` and
   runs configured host-managed timer + scheduled-work subscriber programs;
6. a tiny lab UI or terminal inspector that shows substrate snapshot and stream
   registry state;
7. one sleep example program that can be launched through the client and observed
   through the lab.

This proves the process shape without adding Fireline/Firepixel runtime
semantics.

## Resolved Design Questions

1. Embedded Durable Streams dev-server ownership starts in `packages/host`.
   A separate CLI/dev package is deferred until process-launch concerns require
   it.
2. The first lab is a small Vite React app, following Durable Streams test UI
   inspection patterns while using substrate client APIs for scenario actions.
   A terminal inspector can be added later if useful, but the first goal is a
   visual workbench for exploring state transitions.
3. Example program entries live under `packages/lab` for the first slice. They
   can be invoked by the lab UI and by a command-line entrypoint, but they are not
   exported from the production client root.
4. Host diagnostics are deferred beyond the core launchable lab slice. Progress
   and terminalization facts come from durable projections, not process-local
   diagnostics.
5. Host Program Graph discovery uses explicit local maps supplied by the host
   application or lab. Config may select a known key from that map; there is no
   global registry, dynamic module import, or durable program catalog in the
   substrate.
6. Auth/header transport is deferred beyond the core launchable lab slice.
7. Vite lab implementation uses React with vanilla CSS or CSS modules. No UI
   framework is introduced in the first slice.
8. The example command shape is `pnpm --filter lab scenario <name>`, backed by
   the same lab-local example program entries the lab UI imports.
