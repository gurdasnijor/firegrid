# Runtime Package Layout References

Date: 2026-05-09

Branch context: `firegrid/runtime-composition-root-sdd`, PR #134.

This document pressure-tests
`docs/proposals/SDD_FIREGRID_RUNTIME_PACKAGE_HAS_NO_PRODUCTION_ROOT.md` against
reference architectures. It is intentionally concrete and scoped to the next SDD
revision.

Relevant Firegrid ACIDs:

- `firegrid-platform-invariants.PRODUCTION_SURFACE.1`
- `firegrid-platform-invariants.PRODUCTION_SURFACE.2`
- `firegrid-platform-invariants.PRODUCTION_SURFACE.3`
- `firegrid-platform-invariants.PRODUCTION_SURFACE.4`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.9`
- `firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.10`
- `firegrid-durable-launch-runtime-operator.STREAM_TRUTH_BOUNDARY.2`
- `firegrid-durable-launch-runtime-operator.STREAM_TRUTH_BOUNDARY.3`
- `firegrid-event-pipeline-materialization.PIPELINE.1`
- `firegrid-event-pipeline-materialization.PIPELINE.5`
- `firegrid-event-pipeline-materialization.BOUNDARY.1`
- `firegrid-event-pipeline-materialization.BOUNDARY.3`
- `firegrid-event-pipeline-materialization.BOUNDARY.4`

## Research Answer

The SDD thesis is mostly right but needs sharper language:

1. `@firegrid/runtime` should not hide a package-level production root or
   umbrella `RuntimeHost`.
2. The package may expose user-constructible programs, layers, and narrowly
   named pipeline recipes. Temporal and Restate both expose constructible
   endpoint or worker objects. The distinction is that the caller constructs and
   owns them at the application boundary.
3. The physical `control-plane/` and `data-plane/` roots should not be the final
   source layout. They are valid authority terms, but not clean module ranks.
   A hybrid `substrate / domain / capabilities` layout preserves the boundary
   vocabulary without forcing every file into a plane.
4. `session-pipeline.ts` and `materialize-pipeline.ts` are legitimate only if
   treated as named library recipes, not hidden production roots. They should be
   renamed and moved under a `materialization/recipes/` or equivalent directory,
   and the SDD should state the limited import exemption for recipe modules.
5. Do not introduce one `FiregridRuntimeConfig` Tag. Use narrow module-owned
   options or Tags. Application code can aggregate its own config object.
6. `MaterializeProvider` should live in the Materialize capability/provider
   area, while `MaterializeEventSink` lives with sinks. Query helpers belong
   with `MaterializeProvider`, not beside `EventSink`.

## Effect-TS Effect Monorepo

Primary references:

- `packages/platform/src`: abstract services such as `Command.ts`,
  `CommandExecutor.ts`, `FileSystem.ts`, `HttpClient.ts`, `Socket.ts`,
  `Worker.ts`:
  https://github.com/Effect-TS/effect/tree/main/packages/platform/src
- `packages/platform-node/src`: Node implementations such as
  `NodeCommandExecutor.ts`, `NodeFileSystem.ts`, `NodeRuntime.ts`,
  `NodeWorker.ts`, `NodeContext.ts`:
  https://github.com/Effect-TS/effect/tree/main/packages/platform-node/src
- `packages/sql/src`: generic SQL abstractions:
  https://github.com/Effect-TS/effect/tree/main/packages/sql/src
- `packages/sql-pg/src/PgClient.ts`: Postgres driver implementation with
  `PgClientConfig`, `make`, `layer`, and `layerConfig`:
  https://raw.githubusercontent.com/Effect-TS/effect/main/packages/sql-pg/src/PgClient.ts
- `packages/cluster/src/ClusterWorkflowEngine.ts`: cluster-backed workflow
  engine implementation:
  https://github.com/Effect-TS/effect/blob/main/packages/cluster/src/ClusterWorkflowEngine.ts
- `packages/workflow/src/Workflow.ts`: workflow abstraction and `toLayer`:
  https://github.com/Effect-TS/effect/blob/main/packages/workflow/src/Workflow.ts

### Source Layout Walk

Effect uses package-level separation where the split is strong enough:

```txt
packages/platform/src/          generic platform abstractions
packages/platform-node/src/     Node implementations of platform services
packages/sql/src/               SQL service, statements, errors, migrations
packages/sql-pg/src/            Postgres driver and PgClient layer
packages/workflow/src/          workflow abstraction
packages/cluster/src/           cluster/sharding implementation, including ClusterWorkflowEngine
```

Inside a package, top-level files are service/capability names, not "root"
composition areas. For example, `platform/src` has `CommandExecutor.ts`,
`FileSystem.ts`, `HttpClient.ts`, and `Worker.ts`. `platform-node/src` mirrors
that with Node-specific implementations and exports `NodeContext.layer`, a
convenience layer merging multiple platform implementations.

### Composition Story

Effect packages expose service Tags, constructors, and Layers. Consumers compose
Layers. Some convenience Layers exist, but they are named as capability bundles
such as `NodeContext.layer`, not application roots.

Important pattern for Firegrid: `NodeContext.layer` is a bundle of peer
implementations, but it is still a low-level platform capability bundle. It is
not a domain runtime host.

`Workflow.make(...).toLayer(...)` registers a workflow and returns a Layer that
still requires a `WorkflowEngine`. `ClusterWorkflowEngine.layer` provides the
implementation and requires `MessageStorage | Sharding.Sharding`. This is close
to Firegrid's desired shape: workflow definitions and workflow-engine
implementation remain separate.

### Substrate / Domain / Capability Split

Effect expresses generic substrate by package:

- `@effect/workflow`: generic workflow abstraction.
- `@effect/cluster`: clustered workflow implementation.
- `@effect/platform`: capability abstractions.
- `@effect/platform-node`: Node capability implementations.
- `@effect/sql`: generic SQL substrate.
- `@effect/sql-pg`: Postgres implementation.

Firegrid should not copy the multi-package split, but it should copy the
conceptual ranking. `workflow-engine` is substrate. `runtime-context` is
Firegrid domain. `execution/sandbox`, `runtime-output`, and `materialization`
are capabilities/subsystems.

### Pluggability Seam

Pluggability is Tag plus Layer:

- `SqlClient` is generic.
- `PgClient.layer(config)` provides a concrete implementation.
- `WorkflowEngine` is generic.
- `ClusterWorkflowEngine.layer` provides a concrete implementation.

The driver package owns driver config. `PgClientConfig` is narrow to Postgres.
There is no global "EffectRuntimeConfig" that knows every platform URL.

### Configuration Story

Effect favors narrow module-owned config:

- `PgClient.layer(config: PgClientConfig)`.
- `PgClient.layerConfig(config: Config.Config.Wrap)`.
- platform implementations expose specific layers.

This argues against a monolithic `FiregridRuntimeConfig` Tag. If Firegrid wants
config Tags, they should be owned by the module that consumes them:
`RuntimeContextStoreConfig`, `RuntimeOutputJournalConfig`,
`WorkflowStateConfig`, `MaterializeProviderConfig`, etc. In many cases an
options object passed to `Live(options)` is enough.

### Fit For Firegrid

Best fit:

- service Tags + implementation Layers;
- no hidden production root;
- driver/provider implementations near provider code;
- convenience bundles allowed only when they are clearly capability bundles or
  recipes.

Poor fit:

- actual multi-package split would be too much for the current Firegrid scope.

## Restate TypeScript SDK

Primary references:

- SDK source layout:
  https://github.com/restatedev/sdk-typescript/tree/main/packages/libs/restate-sdk/src
- `src/index.ts` re-exports the Node entry:
  https://raw.githubusercontent.com/restatedev/sdk-typescript/main/packages/libs/restate-sdk/src/index.ts
- `src/endpoint/endpoint.ts` has `EndpointBuilder.bind(...)` and `build()`:
  https://raw.githubusercontent.com/restatedev/sdk-typescript/main/packages/libs/restate-sdk/src/endpoint/endpoint.ts
- Restate service API reference for `service(...)`:
  https://restatedev.github.io/sdk-typescript/functions/_restatedev_restate-sdk.service
- Restate serving docs for `serve({ services: [...] })` and
  `createEndpointHandler(...)`:
  https://docs.restate.dev/develop/ts/serving

### Source Layout Walk

The package source has a small number of runtime-facing directories and entry
files:

```txt
packages/libs/restate-sdk/src/
  endpoint/
  logging/
  types/
  utils/
  context.ts
  context_impl.ts
  endpoint.ts
  fetch.ts
  lambda.ts
  node.ts
  index.ts
```

`types/rpc.ts` defines service/object/workflow definition helpers.
`endpoint/endpoint.ts` builds an endpoint from bound definitions.
`node.ts`, `fetch.ts`, and `lambda.ts` are deployment adapters.

### Composition Story

Restate exposes service definitions and endpoint constructors. User code does:

```ts
restate.serve({ services: [myService] })
```

or constructs a handler:

```ts
restate.createEndpointHandler({ services: [myService, myWorkflow] })
```

That is a user-constructible composition object at the application edge. The
SDK does not hide a production root that discovers all services. It exposes
entrypoint helpers that the application calls.

### Substrate / Domain / Capability Split

Restate separates:

- definition DSL: `service`, `object`, `workflow`;
- handler/runtime adapters: Node, Fetch, Lambda;
- endpoint builder/discovery;
- contexts and internal handler wrappers.

The split is by SDK concern, not by "control plane" versus "data plane".

### Pluggability Seam

The seam is service definition plus endpoint adapter:

- user-defined service/object/workflow implementations are bound into an
  endpoint;
- Node/Fetch/Lambda adapters serve the same definitions.

For Firegrid, this supports exposing `startRuntime(...)` and projection
programs, plus optional recipe constructors, while requiring apps to decide
which services and layers are served/run.

### Configuration Story

Config is local to the entrypoint helper. `serve(...)` accepts service arrays
and endpoint options. There is no SDK-wide config object carrying every
deployment concern. This again argues against `FiregridRuntimeConfig`.

### Fit For Firegrid

Best fit:

- app-owned final assembly;
- public entrypoint helpers are acceptable if they are explicitly called by the
  app;
- deployment adapters can live beside the library without becoming hidden roots.

Poor fit:

- Restate is HTTP endpoint oriented. Firegrid's Effect Layer graph is richer,
  so a direct `serve(...)` style root would be too coarse.

## Temporal Go SDK

Primary references:

- Repository top-level layout:
  https://github.com/temporalio/sdk-go/tree/master
- `worker/worker.go`: `Worker` interface, `Registry`, `RegisterWorkflow`,
  `RegisterActivity`, `Start`, `Run`, `Stop`:
  https://raw.githubusercontent.com/temporalio/sdk-go/master/worker/worker.go
- Go package docs for `worker.New(client, taskQueue, options)`:
  https://pkg.go.dev/go.temporal.io/sdk/worker
- `workflow` package docs:
  https://pkg.go.dev/go.temporal.io/sdk/workflow
- `client` package docs:
  https://pkg.go.dev/go.temporal.io/sdk/client

### Source Layout Walk

Temporal Go SDK top level is package-by-concept:

```txt
activity/
client/
converter/
interceptor/
internal/
internalbindings/
log/
mocks/
test/
testsuite/
worker/
workflow/
```

Important: public packages are conceptually ranked by SDK role. `workflow/`
contains workflow-authoring APIs. `activity/` contains activity APIs. `client/`
connects to Temporal service. `worker/` hosts registered workflows/activities.
`internal/` hides implementation machinery.

### Composition Story

Temporal does expose a user-constructible composition object: `worker.New`.
The worker is not hidden. Application code creates it with a `client.Client`,
task queue, and options, then registers workflows and activities on it and
starts it.

This pushes against an absolutist reading of "no production root." The better
rule is: no hidden root inside the package. A user-constructible runtime
process object can be legitimate if it is explicitly owned by application code.

### Substrate / Domain / Capability Split

Temporal makes workflow and activity authoring first-class packages, and keeps
large implementation mechanics in `internal/`. It does not organize source by
control/data plane.

The `worker` package is the hosting capability. It composes client connection,
task queue, registry, workflow definitions, and activity definitions, but only
when the user constructs it.

### Pluggability Seam

Pluggability is registration:

- `RegisterWorkflow(...)`;
- `RegisterActivity(...)`;
- options on `worker.New(...)`;
- interceptors/converters as separate packages.

This is analogous to Firegrid allowing application-owned layer composition and
possibly a CLI/runtime binary that constructs a runtime worker. It does not
justify a `RuntimeHost` service inside library modules.

### Configuration Story

Temporal uses narrow options:

- `client.Dial(client.Options{...})`;
- `worker.New(client, taskQueue, worker.Options{...})`;
- workflow/activity options at call sites.

There is no one SDK config object that contains all client, worker, workflow,
activity, and converter settings.

### Fit For Firegrid

Best fit:

- package-by-concept layout;
- public worker/program constructor can exist, but caller owns it;
- narrow options per constructor;
- hide implementation internals if needed.

Poor fit:

- Temporal's worker is core to its SDK. Firegrid is currently a building-block
  runtime package consumed by apps and scenarios; introducing `RuntimeHost`
  now would likely centralize too much.

## Dagster Python

Primary references:

- `_core` source layout:
  https://github.com/dagster-io/dagster/tree/master/python_modules/dagster/dagster/_core
- Dagster instance docs:
  https://legacy-versioned-docs.dagster.dagster-docs.io/deployment/dagster-instance
- Internal API docs for storage and `InstanceRef`:
  https://legacy-versioned-docs.dagster.dagster-docs.io/_apidocs/internals
- `definitions_class.py`:
  https://raw.githubusercontent.com/dagster-io/dagster/master/python_modules/dagster/dagster/_core/definitions/definitions_class.py
- `instance/__init__.py`:
  https://raw.githubusercontent.com/dagster-io/dagster/master/python_modules/dagster/dagster/_core/instance/__init__.py

### Source Layout Walk

Dagster `_core` is organized by platform subsystem:

```txt
dagster/_core/
  definitions/
  events/
  execution/
  executor/
  instance/
  launcher/
  run_coordinator/
  scheduler/
  secrets/
  storage/
  system_config/
  workspace/
```

This is the strongest counterexample to Firegrid's "no production root"
instinct. Dagster is a platform with a first-class deployment instance. Its
core package contains `DagsterInstance`, storage, run launcher, run coordinator,
scheduler, workspace, and definitions.

### Composition Story

Dagster has a real composition root: the Dagster instance. The docs describe
`dagster.yaml` as the deployment config shared by webserver, daemon, and other
processes. The instance config selects run storage, event storage, compute log
storage, run launcher, run coordinator, scheduler behavior, telemetry, and more.

This is not hidden scenario wiring. It is a product-level deployment root.

### Substrate / Domain / Capability Split

Dagster separates:

- user definitions (`definitions/`);
- execution machinery (`execution/`, `executor/`);
- deployment instance (`instance/`);
- pluggable backing services (`storage/`, `launcher/`,
  `run_coordinator/`, `scheduler/`, `secrets/`);
- workspace/code-loading (`workspace/`).

Dagster embraces a platform-level root because its package is the platform.

### Pluggability Seam

Pluggability is deployment config and abstract base classes:

- storage is configured through `dagster.yaml`;
- run launchers, run coordinators, compute log storage, and schedulers are
  replaceable components;
- user code is packaged into code locations/definitions.

### Configuration Story

Dagster uses a large deployment config file. This is right for a platform daemon
ecosystem, but it is too broad for Firegrid's runtime package at this stage.

### Fit For Firegrid

Best fit:

- useful warning: if Firegrid wants `PRODUCTION_SURFACE.3` production
  composition roots, those roots should be explicit deployment modules or app
  modules, not vague library helpers;
- subsystem layout by concept is successful at scale.

Poor fit:

- a single `FiregridRuntimeConfig` and `RuntimeHost` would copy Dagster's
  instance pattern without Firegrid yet being a full deployment platform.

## Apache Beam

Primary references:

- Beam programming guide:
  https://beam.apache.org/documentation/programming-guide/
- Beam pipeline creation docs:
  https://beam.apache.org/documentation/pipelines/create-your-pipeline/
- Beam basics:
  https://beam.apache.org/documentation/basics/

### Source Layout Walk

This reference is primarily conceptual rather than a package-layout model. Beam
organizes around the programming model:

```txt
Pipeline
  PCollection
  PTransform
  IO connectors
  Runner
```

The guide states that transforms are operations applied to `PCollection`s, and
that I/O connectors read from and write to external systems. A runner executes
the pipeline.

### Composition Story

Users build a pipeline explicitly. The SDK does not infer a production pipeline
root. Connectors and transforms are reusable building blocks.

### Substrate / Domain / Capability Split

Beam separates:

- model: pipeline, collection, transform;
- user code: transform functions;
- I/O connectors: source/sink adapters;
- runner: execution backend.

This maps closely to Firegrid's `EventSource -> EventProjector -> EventSink ->
EventPipeline`.

### Pluggability Seam

The seam is source/transform/sink/runner. New I/O connectors and transforms do
not change the pipeline model.

### Configuration Story

Config is attached to pipeline options, transforms, and connectors. It is not
one giant process-wide config.

### Fit For Firegrid

Best fit:

- strong support for keeping materialization vocabulary as source/projector/sink
  rather than "engine";
- supports `MaterializeEventSink` as one sink and `StateProtocolEventSink` as
  another;
- query helpers are connector/provider-specific, not the pipeline abstraction.

Poor fit:

- Beam has a runner abstraction because it executes distributed pipelines.
  Firegrid should not invent `EventPipelineRunner` unless a real second runner
  appears.

## Cross-Cutting Comparison

| Reference | Source layout | Composition story | Substrate/domain/capability split | Pluggability seam | Config story | Fit for Firegrid |
| --- | --- | --- | --- | --- | --- | --- |
| Effect | Packages and files by service/capability; implementation packages mirror abstraction packages | Consumers compose Layers; convenience bundles exist for capability groups | Strong abstraction/implementation split (`platform` vs `platform-node`, `sql` vs `sql-pg`) | Tags and Layers | Narrow config per implementation (`PgClientConfig`) | Best Effect-native model; avoid multi-package split for now |
| Restate TS | SDK concerns: endpoint, types, context, runtime adapters | App calls `serve` or `createEndpointHandler` with services | Definition DSL vs endpoint adapters vs context internals | Service/object/workflow definitions bound into endpoint | Entry helper options | Supports app-owned entrypoint helpers, not hidden roots |
| Temporal Go | Packages by SDK concept: workflow, activity, client, worker, internal | App constructs `worker.New`, registers code, starts worker | Public authoring packages plus internal implementation | Worker registry and options | Narrow client/worker/workflow options | Allows user-constructible root, but should be app-owned |
| Dagster | Platform subsystems under `_core`: definitions, execution, instance, storage, launcher | First-class `DagsterInstance` deployment root | User definitions vs instance vs pluggable platform components | Instance config and component classes | Large deployment config (`dagster.yaml`) | Useful counterexample; too heavy for Firegrid runtime package today |
| Apache Beam | Programming model by pipeline/transform/IO/runner | User builds pipeline explicitly | Model vs IO connectors vs runner | Source/transform/sink/runner | Pipeline/options/connector config | Best analogy for EventPipeline; do not overbuild runner |

## Direct Answers To Firegrid Questions

### 1. Is "runtime package has no production root" consistent?

Partially.

Consistent with Effect and Beam: packages expose primitives and Layers; callers
compose. Consistent with Restate if interpreted as "the app constructs the
endpoint with SDK helpers." Temporal and Dagster show that production roots can
be legitimate, but they are explicit user/deployment constructs:

- Temporal: `worker.New(client, taskQueue, options)`.
- Dagster: `DagsterInstance` plus `dagster.yaml`.

Firegrid should say: no hidden package-level production root and no umbrella
service. User-constructible runtime workers or projection recipes are allowed
only when explicitly called by apps or binaries.

### 2. Remove physical control-plane/data-plane directories?

Recommendation: remove them as top-level physical roots, but keep them as
architecture vocabulary in docs/specs.

The current plane split is valuable for authority. It is weak as file layout
because `workflow-engine`, `execution`, and `materialization` do not each
belong cleanly to one plane. A hybrid layout should express rank:

- substrate;
- domain;
- capabilities.

### 3. Are `session-pipeline.ts` and `materialize-pipeline.ts` library constructors?

They are legitimate only as named recipes/presets, not as default runtime
composition.

Keep them if:

- they live under `materialization/recipes/`;
- they are documented as optional production surfaces satisfying
  `firegrid-platform-invariants.PRODUCTION_SURFACE.2` and
  `firegrid-event-pipeline-materialization.PIPELINE.5`;
- they do not import unrelated runtime execution services;
- they return an `EventPipelineSummary` and accept narrow options.

Move them out if they grow application topology concerns such as product
session semantics, multi-stream tenant config, or deployment-wide config.

### 4. Config Tag shape?

No package-level `FiregridRuntimeConfig` Tag.

Use:

- narrow options for `Live(options)` constructors;
- narrow config Tags only when a module needs environment-sourced config through
  Effect Config;
- app-owned aggregate config if an application wants one.

This follows Effect, Restate, Temporal, and Beam. Dagster is the exception
because it is a deployment platform with an instance root.

### 5. Dependency rule?

Use a nuanced rule:

1. Core modules may import peer Tags, types, pure helpers, and programs.
2. Core modules must not import peer `Live` Layers from other bounded contexts.
3. Implementation modules may import their own local helpers and provider
   internals.
4. Recipe modules may import peer `Live` Layers, but only under a clearly named
   recipe/preset directory and only to assemble one documented production
   surface.
5. Application entrypoints, binaries, scenarios, and tests may compose any
   public Layers.

This is stricter than the current code but less brittle than a blanket "no peer
Live imports anywhere."

### 6. Where should MaterializeProvider live?

Put provider and query APIs together, separate from sink adapter:

```txt
materialization/
  event-pipeline.ts
  runtime-output-source.ts
  projectors/
  sinks/
    state-protocol/
    materialize/
      materialize-event-sink.ts
  providers/
    materialize/
      materialize-provider.ts
      queries.ts
      types.ts
  recipes/
    session-projection.ts
    materialize-runtime-output-projection.ts
```

`MaterializeProvider` owns provisioning, ingest transport, query, and subscribe.
`MaterializeEventSink` adapts projected events into `MaterializeProvider.ingest`.
This directly satisfies
`firegrid-event-pipeline-materialization.BOUNDARY.3` and
`firegrid-event-pipeline-materialization.BOUNDARY.4`.

## Candidate Layouts

### Candidate A: Effect-Native Bounded Contexts

Derived from Effect plus the current SDD.

```txt
packages/runtime/src/
  workflow-engine/
    engine-runtime.ts
    state.ts
    workflows.ts
    index.ts

  runtime-context/
    command.ts
    errors.ts
    ids.ts
    schema.ts
    service.ts
    workflow.ts
    start-runtime.ts
    index.ts

  execution/
    sandbox/
      sandbox.ts
      providers/local-process.ts
      index.ts

  runtime-output/
    writer.ts
    index.ts

  materialization/
    event-pipeline.ts
    runtime-output-source.ts
    projectors/
    sinks/
      state-protocol/
      materialize/
    providers/
      materialize/
    recipes/
      session-projection.ts
      materialize-runtime-output-projection.ts
    index.ts

  index.ts
```

Composition happens in applications, binaries, scenarios, and the explicitly
named `materialization/recipes/*` helpers. `session-pipeline.ts` and
`materialize-pipeline.ts` are moved to `recipes/` and renamed to
`session-projection.ts` and `materialize-runtime-output-projection.ts`.

Config is narrow options per `Live(options)` or recipe function. No
`FiregridRuntimeConfig`.

What gets better:

- removes the misleading plane roots;
- keeps `workflow-engine` from looking equal to `runtime-output` only by
  accident;
- preserves Effect-native Layer style;
- gives `PRODUCTION_SURFACE.3` a place for production recipe surfaces without a
  hidden root.

What gets worse:

- `substrate/domain/capability` rank is only implicit in directory names.

### Candidate B: Hybrid Substrate / Domain / Capabilities

Derived from Effect's abstraction/implementation split and Temporal's ranked
SDK concepts.

```txt
packages/runtime/src/
  substrate/
    workflow-engine/
      engine-runtime.ts
      state.ts
      workflows.ts
      index.ts

  domain/
    runtime-context/
      command.ts
      errors.ts
      ids.ts
      schema.ts
      service.ts
      workflow.ts
      start-runtime.ts
      index.ts

  capabilities/
    execution/
      sandbox/
        sandbox.ts
        providers/local-process.ts
        index.ts
    runtime-output/
      writer.ts
      index.ts
    materialization/
      event-pipeline.ts
      runtime-output-source.ts
      projectors/
      sinks/
        state-protocol/
        materialize/
      providers/
        materialize/
      recipes/
        session-projection.ts
        materialize-runtime-output-projection.ts
      index.ts

  index.ts
```

Composition happens outside package source except recipe modules under
`capabilities/materialization/recipes/`.

Config is narrow module options. No `FiregridRuntimeConfig`.

`session-pipeline.ts` and `materialize-pipeline.ts` become recipes. If they
need app-specific product behavior later, they move to the consuming app.

What gets better:

- solves the "conceptual rank is flattened" concern directly;
- keeps control/data plane as authority terminology, not source topology;
- makes `workflow-engine` visibly substrate, `runtime-context` visibly domain,
  and materialization visibly a capability subsystem.

What gets worse:

- adds one more directory level;
- "capabilities" is a broader noun than Effect usually uses.

### Candidate C: Temporal-Style Runtime Worker

Derived from Temporal's `worker.New(...)`.

```txt
packages/runtime/src/
  workflow-engine/
  runtime-context/
  execution/
  runtime-output/
  materialization/
  worker/
    runtime-worker.ts
    options.ts
  index.ts
```

Composition happens in a user-constructible `RuntimeWorker` object or
`makeRuntimeWorker(options)` function. It would register runtime-context
workflow, execution provider, journal writer, and maybe materialization
pipelines.

`session-pipeline.ts` and `materialize-pipeline.ts` might become worker
registration methods or worker options.

Config is `RuntimeWorkerOptions`, not a global Tag.

What gets better:

- gives hosts one obvious construction point;
- aligns with Temporal's proven worker model;
- may satisfy `PRODUCTION_SURFACE.3` very cleanly.

What gets worse:

- likely reintroduces `RuntimeHost` under a better name;
- too easy to centralize every future concern;
- less Effect-native than simply composing Layers at the edge;
- risks making materialization look subordinate to runtime execution.

## Recommendation

Adopt Candidate B with one adjustment: if the extra `capabilities/` level feels
too heavy in code review, Candidate A is an acceptable near-term compromise.

The recommended final layout:

```txt
packages/runtime/src/
  substrate/
    workflow-engine/

  domain/
    runtime-context/

  capabilities/
    execution/sandbox/
    runtime-output/
    materialization/
      event-pipeline.ts
      runtime-output-source.ts
      projectors/
      sinks/
        state-protocol/
        materialize/
      providers/
        materialize/
      recipes/
        session-projection.ts
        materialize-runtime-output-projection.ts

  index.ts
```

Do not introduce `composition/`, `RuntimeHost`, `RuntimeHostTopology`, or a
single `FiregridRuntimeConfig` Tag.

Keep production composition surfaces only as:

- small programs such as `startRuntime(...)`;
- service Tags and implementation Layers;
- named recipes under `materialization/recipes/` that are explicitly scoped to
  one pipeline.

The pattern not chosen:

- Temporal-style `RuntimeWorker`: useful later if Firegrid ships a standalone
  long-running runtime process, but premature for this package layout pass.
- Dagster-style instance: appropriate for a full deployment platform, too broad
  for current `@firegrid/runtime`; keep it as a rejected reference model rather
  than a candidate layout.

## Recommended SDD Changes

Concrete edits for
`docs/proposals/SDD_FIREGRID_RUNTIME_PACKAGE_HAS_NO_PRODUCTION_ROOT.md`:

1. Change the thesis from "runtime package has no production root" to "runtime
   package has no hidden production root." Add that user-constructible programs
   and recipes are allowed when explicitly invoked at an app/binary boundary.
2. Replace the flat bounded-context tree with the hybrid tree from Candidate B,
   or explicitly choose Candidate A as a near-term compromise.
3. Add a paragraph distinguishing authority planes from source layout:
   control-plane/data-plane remain spec and diagram concepts, not physical root
   directories.
4. Replace `config.ts` / `FiregridRuntimeConfig` with "no package-level config
   Tag; modules own narrow options or narrow config Tags."
5. Revise the Effect boundary rule:
   - core modules may import peer Tags, types, pure helpers, and programs;
   - core modules must not import peer `Live` Layers from other bounded
     contexts;
   - recipe modules may import peer `Live` Layers as named production surfaces;
   - app entrypoints, binaries, scenarios, and tests own final Layer
     composition.
6. Move `session-pipeline.ts` and `materialize-pipeline.ts` in the SDD tree to
   `materialization/recipes/session-projection.ts` and
   `materialization/recipes/materialize-runtime-output-projection.ts`.
7. Place `MaterializeProvider` under
   `materialization/providers/materialize/`, and place
   `MaterializeEventSink` under `materialization/sinks/materialize/`.
8. Add one sentence that query/provision helpers are provider APIs, not
   `EventSink` APIs.
9. Cite `firegrid-platform-invariants.PRODUCTION_SURFACE.3` in the recipes
   section: recipes are production modules only when they are package-exported
   and invoked by app/scenario code, not when behavior exists only in scenario
   wiring.

## Not Researched

- Kafka Streams and Faust: skipped because Beam already covers the
  source/transform/sink model and the Firegrid question is package architecture,
  not streaming semantics.
- Trigger.dev and LangGraph: skipped because Restate and Temporal cover durable
  TypeScript/application entrypoint patterns more directly.
- Materialize operator/SDK layout: skipped because the current question is
  where Firegrid's `MaterializeProvider` sits relative to `EventSink`, and the
  Firegrid-local SDD already defines the provider/query split.
