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
applications / agent runtimes / lab
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

The client is how any consumer talks to the substrate. The host is how the
substrate makes progress. The lab is one consumer of the client plus optional
read-only diagnostics; it is not a third authority layer.

## Schema And Type Ownership

Every durable participant can append records to Durable Streams, but schema
ownership stays with the row family owner:

- substrate-owned rows (`durable.run`, `durable.completion`,
  `durable.claim.attempt`, and substrate trace rows if used) are defined once in
  `@durable-agent-substrate/substrate`;
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

- one Effect-native app-facing package;
- scoped Effect service/layer APIs as the canonical surface;
- `open`, `use`, and `run` helpers may exist as Effect-native conveniences;
- durable intent methods;
- curated read handles;
- explicit subpaths for operator/testing/diagnostics;
- no raw stream, raw StreamDB collection, or raw row helper exports at the root.

The canonical client surface is Effect-native:

```ts
import { Effect } from "effect"
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

Non-Effect callers can use `Effect.runPromise(...)` at their own process edge. A
separate Promise/AsyncIterable wrapper package is a later compatibility layer,
not part of the first launchable substrate design.

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

- client writes semantic substrate intents;
- client reads curated projections;
- client hides stream URL and id threading after open;
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

For the first launchable slice, embedded Durable Streams dev-server ownership
lives in `packages/host`. A separate CLI/dev package can be introduced later if
process-launch concerns outgrow the host package, but splitting it now would add
package surface without changing semantics.

Host responsibilities:

- start or connect to a Durable Streams server;
- run timer and scheduled-work subscribers;
- run projection-match subscriber profiles supplied by the runtime;
- run claim-before-side-effect operator programs;
- run configured event-plane projection observers;
- expose read-only in-process status, metrics, and health for local tooling;
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

Profile discovery in development is explicit:

```ts
const profiles = {
  prototype: PrototypeProfileLive,
  fakePermission: FakePermissionProfileLive,
} as const

SubstrateHost.embeddedDev({
  streamName: "substrate-prototype",
  profile: profiles.prototype,
})
```

Config may select a key from a caller-supplied local map, but the substrate does
not dynamically import arbitrary modules, maintain a global registry, or fetch
runtime profiles from durable state.

### Host-Managed Subscriber Programs

Slice 5 makes the timer and scheduled-work subscribers launchable under the
host. The host owns the scoped subscriber programs; the substrate subscriber
functions remain the authority for catch-up scan-and-resolve behavior.

This is not intended to be a naive polling loop. The durable-subscriber model
is subscription/progress oriented:

- active subscribers follow durable stream/state changes;
- due-time subscribers also schedule a wake-up for the nearest known due time;
- restart safety comes from durable records, not process-local memory;
- duplicate terminalization attempts remain harmless under completion
  authority.

Spec anchors:

- `launchable-substrate-host.HOST_PROCESS.3`
- `launchable-substrate-host.HOST_PROCESS.6`
- `launchable-substrate-host.RUNTIME_COMPOSITION.1`
- `launchable-substrate-host.RUNTIME_COMPOSITION.2`
- `launchable-substrate-host.RUNTIME_COMPOSITION.3`
- `launchable-substrate-host.RUNTIME_COMPOSITION.9`
- `launchable-substrate-host.AUTHORITY_BOUNDARY.2`
- `launchable-substrate-host.NO_CONTROL_PLANE.1`
- `launchable-substrate-host.NO_CONTROL_PLANE.3`

The first host-managed subscriber profile covers only:

- timer completions through `runTimerSubscriber`;
- scheduled-work completions through `runScheduledWorkSubscriber`.

Projection-match subscriber profiles and claim-before-side-effect operator
profiles stay separate. They use the same host profile mechanism later, but
they should not be pulled into the timer/scheduled-work loop slice just to
claim broad host-process requirements.

The subscriber runner configuration is a simple per-kind boolean in Slice 5:

```ts
interface SubstrateHostProfile {
  readonly subscribers?: {
    readonly timer?: boolean
    readonly scheduledWork?: boolean
    readonly projectionMatch?: ReadonlyArray<ProjectionMatchProfile>
  }
}
```

If a subscriber is disabled or omitted from the profile, the host does not start
its fiber. A future slice may introduce per-kind tuning options if implementation
genuinely needs them; until then the boolean keeps Slice 5 honest and avoids
naming a polling-shaped knob.

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

Host-local lifecycle state is only diagnostic. It can say what this process has
configured and whether a scoped subscriber program is currently alive, but it is
not subscriber progress authority and it must not replace durable cursor,
retry, dead-letter, completion, or terminalization records.

Future network diagnostics, if a release need proves them necessary, can later
combine both views:

- durable projections for substrate facts and future subscriber progress rows;
- ephemeral host process status for local liveness only.

Slice 5 should not create HTTP routes. If it exposes an in-process diagnostic
service, keep the shape intentionally narrow:

```ts
interface SubscriberProgramLiveness {
  readonly kind: "timer" | "scheduled_work"
  readonly enabled: boolean
  readonly running: boolean
  readonly lastErrorSummary?: string
}
```

Counts, cursor positions, retry/dead-letter state, and durable terminalization
history should come from durable records/projections once the corresponding row
families exist. For the timer/scheduled-work slice, the authoritative facts are
already the `durable.completion` rows and their terminal folds.

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
exposed by the standalone Effect-native client package. The only difference is
lifecycle ownership: standalone client programs attach to an existing
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

Scenario harnesses live under `packages/lab` for the first slice. They are
development examples, not production client/testing API. Each scenario should be
runnable from the command line and from the lab UI, with both paths using the
same client package and scenario definitions.

## Read-Only Host Diagnostics

The first host diagnostics surface is in-process, not HTTP. This keeps the
host from becoming an operational side channel and preserves the durable stream
as the only application command path. HTTP, Unix socket, or other networked
diagnostics are deferred until an actual release need proves they are worth the
extra surface area.

In-process diagnostics may expose:

- health;
- version;
- process id;
- boot mode;
- stream URL or stream name;
- active profiles;
- subscriber program liveness;
- operator program liveness;
- last non-secret error summary;
- process metrics;
- uptime.

Diagnostics are read-only. They do not mutate durable state and do not start
scenarios. Secret values and authorization headers are never returned through
diagnostics.

There is no default diagnostics port in v1 because there is no network
diagnostics listener. If a future slice introduces routes, they must be
read-only by construction; unknown methods must not append durable records or
start scenario work.

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
7. one sleep scenario that can be launched through the client and observed
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
3. Scenario harnesses live under `packages/lab` for the first slice. They can be
   invoked by the lab UI and by a command-line entrypoint, but they are not
   exported from the production client root.
4. Minimum host diagnostics are read-only health, version, process id, boot
   mode, stream identity, active profile names, subscriber/operator program status,
   last scan times, uptime, process metrics, and non-secret error summaries.
5. Profile discovery uses explicit local maps supplied by the host application
   or lab. Config may select a known key from that map; there is no global
   registry, dynamic module import, or durable profile catalog in the substrate.
6. Host auth config resolves deterministically: `SUBSTRATE_AUTHORIZATION` wins
   over `SUBSTRATE_TOKEN`; a bare token becomes `Authorization: Bearer <token>`;
   diagnostics never expose the resulting header.
7. Vite lab implementation uses React with vanilla CSS or CSS modules. No UI
   framework is introduced in the first slice.
8. The scenario command shape is `pnpm --filter lab scenario <name>`, backed by
   the same scenario descriptors the lab UI imports.
