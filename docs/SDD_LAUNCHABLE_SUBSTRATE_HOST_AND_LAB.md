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
  dev inspector and scenario runner built on the client
```

The key design decision is negative: the host is not a command/control API.
Application writes should flow through a substrate-specific client that appends
durable records. The host observes durable state and runs configured substrate
programs. The lab can provide buttons and forms, but those controls use the
client surface, not hidden host mutation endpoints.

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

The Durable Streams test UI is useful for inspector mechanics: stream registry,
live following, catchup, JSON rendering, and responsive stream inspection. It is
not a model for substrate command endpoints.

Restate is useful prior art for package altitude: a server-side runtime SDK for
defining durable behavior, a standalone client SDK for external callers, and a
launchable runtime/server that owns execution. The substrate should borrow that
split, not Restate's ingress model. In this substrate, external callers append
durable intent through the client, and the host observes durable state and runs
configured profiles.

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
application / lab / prototype runtime
  -> @durable-agent-substrate/client
      append durable intents
      read curated projections

@durable-agent-substrate/host
  observe durable streams/state
  run subscribers and operator programs
  expose read-only diagnostics and lifecycle status

Durable Streams + Durable State
  source of truth
```

The client is the app-facing writer. The host is the durable observer/worker.
The lab is a developer experience over both, but scenario actions still call the
client.

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
  regular JS/TS app-facing SDK
  Promise and AsyncIterable wrappers over the same substrate client core

@durable-agent-substrate/client/effect
  Effect service/layer presentation of the same client capability

@durable-agent-substrate/host
  launchable runtime process and non-Effect entrypoints

@durable-agent-substrate/host/effect
  Effect layer constructors and withHost-style dev/test composition

@durable-agent-substrate/lab
  development inspector and scenario workbench built on the client
```

The client and `/effect` client must not fork semantics. They are two
presentations over one client core:

```text
client core
  -> root package Promise / AsyncIterable API
  -> /effect Effect services / layers
```

Likewise, `SubstrateHost.withHost(...)` may provide `SubstrateClient` to the
program it runs, but that client is the same capability as the standalone
client. `withHost` owns lifecycle composition in development; it is not a
different writer surface.

## Firepixel Shape Review

Firepixel has a useful shape to preserve while removing Firepixel-specific
vocabulary from the substrate:

- `@firepixel/client` exposes `open`, `use`, and `run` over a scoped StreamDB
  store, durable intent writers, and curated session/prompt/operator read
  handles.
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
  fibers. Runtime provider/session/resource kernels are ordinary layers, so
  process-local live handles stay outside durable state.

The substrate should adopt the shape, not the domain names:

```text
SubstrateClient.open/use/run
SubstrateHost.attached / attachedFromConfig
SubstrateHost.embeddedDev / bootPlanFromConfig
SubstrateHost.withHost
SubstrateHostLive(plan, profiles)
```

The important ergonomic property is compositionality. A Firepixel-like runtime
should provide profile layers to the host instead of forking its own process
control surface:

```ts
const RuntimeProfileLive = Layer.mergeAll(
  AcpEventPlaneLive,
  LocalProviderLive,
  PermissionMatcherLive,
  PromptOperatorLive,
)

const program = SubstrateHost.withHost(
  Effect.gen(function* () {
    const substrate = yield* SubstrateClient
    return yield* substrate.work.observe("run:demo").snapshot()
  }),
  {
    mode: "embedded-dev",
    streamName: "firepixel-prototype",
    clientId: "prototype:lab",
    profile: RuntimeProfileLive,
  },
)
```

This keeps operational complexity low: the host owns process lifetime and
subscribers/operators, the profile owns adapter/provider choices, and the client
owns durable intent production.

## Client Surface

The client should follow the Fireline client altitude:

- one root app-facing package;
- regular JS/TS `open`, `use`, and `run` helpers on the root package;
- scoped Effect service/layer APIs under `/effect`;
- durable intent methods;
- curated read handles;
- explicit subpaths for operator/testing/diagnostics;
- no raw stream, raw StreamDB collection, or raw row helper exports at the root.

The root package is suitable for non-Effect application runtimes:

```ts
import { Substrate } from "@durable-agent-substrate/client"

const substrate = await Substrate.open({ streamUrl, clientId: "lab" })

try {
  const work = await substrate.work.declare({
    idempotencyKey: "demo:review-1",
    input: { kind: "review", target: "README.md" },
  })

  await substrate.choreography.scheduleAt({
    at: new Date("2026-05-04T17:00:00.000Z"),
    input: { prompt: "Follow up on review" },
  })

  const current = await substrate.work.observe(work.workId).snapshot()
} finally {
  await substrate.close()
}
```

The Effect subpath exposes the same client capability as an Effect service:

```ts
import { Effect } from "effect"
import { Substrate, SubstrateClientLive } from "@durable-agent-substrate/client/effect"

const program = Effect.gen(function* () {
  const substrate = yield* Substrate
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

The root may still offer Promise-edge convenience helpers such as
`Substrate.use(...)` and `Substrate.run(...)`; those helpers call the same client
core as `/effect`.

Read handles should make snapshot vs follow behavior explicit:

```ts
await substrate.work.observe(workId).snapshot()

for await (const state of substrate.work.observe(workId).stream()) {
  // live updates
}

await substrate.work.observe(workId).until((state) => state.state === "completed")
```

`snapshot()` reads the current no-gap materialized view once and returns the
selected state. It does not mutate durable state and is not a live
subscription.

The exact method names can change, but the boundary should not:

- root client writes semantic substrate intents;
- root client reads curated projections;
- root client hides stream URL and id threading after open;
- root client and `/effect` client share one implementation core;
- operator-only controls live under `@durable-agent-substrate/client/operator`;
- testing harnesses live under `@durable-agent-substrate/client/testing`;
- diagnostic raw stream/state inspection lives under a separate lab/diagnostic
  package, not the production root.

### Client Responsibilities

The client may:

- declare durable work;
- create choreography intents through the choreography facade;
- emit rows to registered event planes;
- resolve externally owned completions when the caller is authorized by the
  domain profile;
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

Host responsibilities:

- start or connect to a Durable Streams server;
- run timer and scheduled-work subscribers;
- run projection-match subscriber profiles supplied by the runtime;
- run claim-before-side-effect operator programs;
- run configured event-plane projection observers;
- expose read-only status, metrics, and health for local tooling;
- shut down through Effect scopes and process signals.

The host does not expose a mutation control plane. If the lab or an application
wants to start a scenario, it uses the client to append the durable start
intent. The host then observes that durable intent and reacts.

### Host Configuration

The host should separate boot planning from runtime profiles.

Boot plan:

```ts
type SubstrateHostBootPlan =
  | {
      readonly _tag: "EmbeddedDevHost"
      readonly processId: string
      readonly headers: Readonly<Record<string, string>>
      readonly durableStreams: {
        readonly host: string
        readonly port: number
        readonly streamName: string
      }
    }
  | {
      readonly _tag: "AttachedHost"
      readonly processId: string
      readonly headers: Readonly<Record<string, string>>
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
- `SUBSTRATE_AUTHORIZATION` or `SUBSTRATE_TOKEN` materializes stream headers.

Runtime profiles are Effect layers and values supplied in process, not a global
registry:

```ts
interface SubstrateHostProfile {
  readonly subscribers?: {
    readonly timer?: boolean
    readonly scheduledWork?: boolean
    readonly projectionMatch?: ReadonlyArray<ProjectionMatchProfile>
  }
  readonly operators?: ReadonlyArray<OperatorProfile>
  readonly eventPlanes?: ReadonlyArray<EventPlaneProfile>
}
```

Profile definitions can carry Effect layers and services in process. Serialized
config only selects known local profile modules in dev; it does not create a
mutable runtime registry.

### Host Composition API

The host package should expose thin constructors that mirror Firepixel's best
runtime API pattern:

```ts
SubstrateHost.attached({ streamUrl, processId, headers, profile })
SubstrateHost.attachedFromConfig({ profile })
SubstrateHost.embeddedDev({ streamName, durableStreamsPort, profile })
SubstrateHost.bootPlanFromConfig
SubstrateHost.withHost(effect, options)
```

`withHost` is a development and test convenience that provides both the
substrate client and the host layer to one Effect program. It should not blur
the production process boundary: production apps normally run clients in app
processes and hosts in worker/runtime processes.

When `withHost` provides `SubstrateClient`, that client is the same capability
exposed by `@durable-agent-substrate/client/effect`. The only difference is
lifecycle ownership: `Substrate.run(...)` opens a client against an existing
stream/runtime environment, while `SubstrateHost.withHost(...)` starts or
attaches the host and provides a client connected to that same durable stream
for the lifetime of the scope.

### Runtime Profile Boundary

A Firepixel-like agent runtime should sit above the host as a profile:

- define its event planes;
- provide projection-match evaluators;
- provide operator programs that consume ready work or event-plane projections;
- provide adapter/provider/session/resource layers;
- decide whether to launch local processes, remote agents, or fake test
  providers.

The substrate host runs the profile. The profile owns agent semantics. The
durable substrate remains generic.

## Lab UI

The lab is an inspector and scenario workbench. It can reuse Durable Streams
test UI ideas:

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
call the same client APIs that an application would call:

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

## Scenario Harnesses

Initial scenarios should be Fireline/Firepixel-shaped without importing
Fireline or Firepixel:

1. Sleep scenario
   - client declares work;
   - choreography sleep creates a timer completion and blocks work;
   - host timer subscriber resolves it;
   - ready work is derived;
   - operator completes the run;
   - lab shows raw stream, completion, ready work, and terminal run.

2. Scheduled work scenario
   - client calls `scheduleAt`;
   - host scheduled-work subscriber resolves at due time;
   - runtime profile maps resolved scheduled work into a domain event;
   - lab shows that `scheduleAt` did not block the caller.

3. Fake permission scenario
   - a caller-owned event plane records a required-action row;
   - client waits with projection-match trigger;
   - lab or policy client emits a resolution row;
   - host projection-match subscriber resolves the completion;
   - work becomes ready.

4. Tool-call-shaped execution scenario
   - a caller-owned event plane records a tool execution request;
   - an operator profile claims ready execution work;
   - fake provider performs the side effect;
   - terminal domain row is emitted;
   - lab proves claim-before-side-effect ordering.

Each scenario should be runnable from the command line and from the lab UI, with
both paths using the same client package.

## Read-Only Host Diagnostics

The host may expose read-only endpoints or IPC for local status:

- health;
- version;
- active profiles;
- subscriber loop status;
- last scan times;
- process metrics;
- stream base URL.

These endpoints are diagnostic only. They do not mutate durable state and do
not start scenarios.

## Relationship To Event Planes

The launchable host should support event-plane profiles but not own their
domain vocabulary. A profile registers:

- event-plane definition;
- stream URL;
- projection queries;
- optional subscriber evaluator adapter;
- optional operator profile that consumes projected rows.

Event-plane rows are observational, eligibility-producing, or terminal-domain
facts depending on the profile. They never replace substrate claim authority or
completion authority.

## Relationship To Choreography

The host runs the drivers that make choreography useful outside tests:

- timer subscriber for sleep;
- scheduled-work subscriber for scheduleAt;
- projection-match subscriber for waitFor;
- operator profiles for ready work;
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

Production root exports should stay narrow:

```text
@durable-agent-substrate/client
@durable-agent-substrate/client/operator
@durable-agent-substrate/client/testing
```

Raw stream inspection belongs to lab/diagnostics, not the client root.

## First Implementation Slice

The first slice should prove:

1. a package boundary for `packages/client`, `packages/host`, and `packages/lab`
   without filling every feature;
2. a client `open` / `use` / `run` resource shape against a Durable Streams URL;
3. a client method that declares work through existing substrate producers;
4. a host boot plan with embedded-dev and attached modes, Effect Config
   decoding, generated process identity, and auth header materialization;
5. a host dev process that starts or connects to `DurableStreamTestServer` and
   runs timer + scheduled-work subscribers;
6. a tiny lab UI or terminal inspector that shows substrate snapshot and stream
   registry state;
7. one sleep scenario that can be launched through the client and observed
   through the lab.

This proves the process shape without adding Fireline/Firepixel runtime
semantics.

## Open Questions

1. Should `packages/host` include the embedded Durable Streams dev server, or
   should that live in a separate CLI/dev package?
2. Should the first lab be a Vite React app like the Durable Streams test UI, or
   a terminal/TUI inspector to reduce scope?
3. Should scenario harnesses live under `packages/lab`, `examples/`, or
   `packages/client/testing`?
4. What is the minimum read-only host diagnostic surface needed for local
   confidence?
5. How should profile modules be discovered in dev without introducing a global
   runtime registry?
