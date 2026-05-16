# SDD: Firegrid Runtime Boundary Reconciliation

Status: post-`#250` follow-up proposal
Created: 2026-05-15
Owner: Firegrid Runtime

Related specs:

- `firegrid-runtime-boundary-reconciliation`
- `firegrid-runtime-agent-event-pipeline`
- `firegrid-runtime-host-modularity`
- `effect-durable-operators`
- `firegrid-session-fact-client-surfaces`

## Problem

`SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md` defines the first clean runtime
cutover: runtime execution becomes sources, codecs, events, transforms,
authorities, subscribers, pipeline composition, waits, and host wiring instead
of one aggregate `runtime-host/index.ts`.

That cutover is necessary, but it should not be treated as the final runtime
layout. During review we found repeated pressure points:

- `host/index.ts` remains a large composition root containing raw-process
  execution, workflow lifecycle, command APIs, config-derived layers, and
  host-coupled agent tool implementation.
- `waits/` is a distinct durable coordination operator, but it currently mixes
  operator API, wait table, source registry, subscription router, and runtime
  adapter concerns.
- Authority/provider boundaries work best when expressed as ordinary Effect
  capabilities (`Context.Tag`, `Layer`, `Queue.Enqueue`, `Stream`, `Sink`,
  narrow `Effect` services), not as Firegrid-specific wrapper types or
  registries.
- Dynamic `SourceCollectionHandle` lookup is useful for `wait_for`, but static
  runtime subscribers should consume `Stream` capability tags through the
  Effect requirement channel.
- Public/runtime production code should not export review-only registries,
  compatibility aliases, singleton authority objects, or table-taking helper
  escape hatches.
- Some primitives now under `packages/runtime/src` may be generic durable
  operators whose natural home is `packages/effect-durable-operators`.

The goal of this SDD is to audit the post-`#250` runtime tree against the
semantic boundaries we have drawn and define the next extraction plan before
new features build on accidental folder boundaries.

## Dependency Graph Evidence

The boundary problems described above are visible in the generated dependency
graphs:

- `docs/dependency-graph-runtime.mmd`
- `docs/dependency-graph-runtime-detail.mmd`
- `docs/dependency-graph.mmd`

### Folder-Level Cycles

The post-`#250` runtime tree still has folder-level cycles. Most route through
`host/`, which confirms that `host/index.ts` is not just large; it is also
serving as a shared dependency source.

| Cycle | Cause |
| --- | --- |
| `events/` <-> `codecs/` | `events/index.ts` re-exports codec contracts as compatibility surface from the `agent-io/` rename. |
| `host/` <-> `pipeline/` | Pipeline code imports runtime context error/config types from `host/`; host imports the codec runtime pipeline. |
| `host/` <-> `sources/` | Sandbox/source code imports `RuntimeContextError` from `host/`; host imports sandbox providers. |
| `host/` <-> `subscribers/` | Subscribers import `RuntimeContextError` from `host/`; host composes subscribers. |
| `host/` <-> `transforms/` | Transforms import `RuntimeContextError` from `host/`; host reaches transforms through pipeline composition. |
| `host/` <-> `agent-tools/` | Agent-tool host/MCP code imports host authority helpers while host composes agent tools. |

The repeated cause is `RuntimeContextError`, `asRuntimeContextError`, and
`mapRuntimeContextError` living in `host/errors.ts`. Those are runtime-wide
error helpers, not host topology. Moving them out first dissolves most of the
cycles without changing behavior.

The `events/` <-> `codecs/` cycle has a different cause: a compatibility
barrel. Remove the re-export, not the codec/event boundary.

### Load-Bearing Barrels

Three barrels carry most cross-folder/runtime import traffic:

| Barrel | Inbound importers | Role |
| --- | ---: | --- |
| `packages/runtime/src/events/index.ts` | 11 | Runtime protocol/event vocabulary. |
| `packages/runtime/src/authorities/index.ts` | 8 | Durable capability tags and provider layers. |
| `@firegrid/protocol/launch/index.ts` | 6 | Launch/runtime context authority surface. |

Follow-up refactors should preserve those barrels as stable import surfaces
unless the PR explicitly migrates all importers in the same change. Internal
layout can move more freely if these public surfaces stay coherent.

### Consumer Shape

The workspace graph shows uneven app consumption:

| App | Runtime consumption pattern |
| --- | --- |
| `apps/flamecast` | Uses the runtime through the host entrypoint only. This is the clean consumer shape to preserve. |
| `apps/factory` | Reaches into host, source/env policy, wait, and event surfaces. This confirms factory still needs a separate consumer-surface audit. |

Factory reaching into `events/` for permission facts overlaps with
`firegrid-session-fact-client-surfaces`: products should prefer the public
client/session surface when the data is already normalized there. Factory
reaching into `sources/` for `RuntimeEnvResolverPolicy` suggests env policy
needs a runtime config/public host surface instead of sandbox-internal imports.

### Hidden Folder Misplacements

The graph also exposes two specific placement issues:

- `authorities/durable-wait-store.ts` imports `waits/internal/table.ts`. The
  wait row schema and the row authority are one bounded context split across
  two folders for the #250 cutover.
- `host/observation-sources.ts` pulls authority streams and wait source
  registration together only to register `SourceCollectionHandle`s. This is
  host-side glue for behavior that should be owned by provider/source
  registration layers.

## Scope Decision

This SDD is not a second event-pipeline rewrite. It is a post-`#250`
boundary reconciliation pass with three concrete outcomes:

1. make `host/index.ts` a small public entrypoint and move its remaining
   behavior into role-specific host modules;
2. classify every top-level runtime folder by semantic role so future work has
   an explicit home;
3. decide which `waits/` pieces are runtime-specific and which need a separate
   `effect-durable-operators` extraction SDD.

The first implementation PR should break folder cycles because it is the
lowest-risk change that unlocks cleaner host extraction. The waits extraction
is design work first; do not move wait internals to another package until that
package boundary is specified.

## Role Rule

Folders are allowed to contain multiple files, but a production module should
have one primary role. If a module needs two roles, it should either be:

- a composition module whose job is explicitly to wire roles together; or
- marked for extraction in this SDD.

This is intentionally stricter than "the code works today." The point is to
prevent convenience modules from becoming hidden architecture.

## Namespace Goal

The post-`#250` tree is stage-disciplined but still flat. Clean pipeline
components sit beside host orchestration, workflow-engine substrate, wait
operators, tool surfaces, adapters, and verified ingest. That makes the root
look broader than the actual runtime architecture and invites cross-boundary
imports.

The next namespace target is to group the agent event-pipeline stages under a
single bounded context, leaving non-pipeline runtime concepts adjacent:

```txt
packages/runtime/src/
  agent-event-pipeline/
    authorities/
      runtime-output-journal.ts
      runtime-ingress-appender.ts
      runtime-ingress-delivery-tracker.ts
    codecs/
    events/
    session-runtime.ts
    sources/
    subscribers/
    transforms/

  runtime-control-plane/
    runtime-control-plane-recorder.ts
    context.ts
    runs.ts

  host/
    index.ts
    layers.ts
    commands.ts
    runtime-context-workflow.ts
    raw-process-runtime.ts
    agent-tool-host-live.ts
    config-live.ts

  waits/
  workflow-engine/
  agent-tools/
  agent-adapters/
  verified-webhook-ingest/
```

The exact folder names can change, but the boundary is fixed:

- agent event-pipeline namespace owns ingress/output event materialization,
  protocol codecs, source acquisition for agent sessions, pure transforms, and
  pipeline subscribers;
- runtime control-plane namespace owns context/run lifecycle capabilities;
- host namespace composes live host topology and command entrypoints;
- waits, workflow-engine, tools, adapters, and verified ingest are adjacent
  bounded contexts, not subfolders of the agent event pipeline.

This namespacing should not be done as part of the first host extraction PR.
The first PR should reduce `host/index.ts`. A later namespace PR can move files
mechanically once the host split has made imports clearer.

## Boundary Exercise

For every runtime folder or module, ask:

```txt
What semantic role is this code playing?
Is that role already represented by Effect, DurableTable, workflow-engine, or
the runtime event pipeline?
Does this module contain more than one role?
Does this public surface exist for production behavior, or only tests/review/docs?
```

Allowed roles are intentionally small.

### Effect Capability Provider

Provides `Context.Tag` services backed by a durable table or host resource.
The provider layer is the only production layer that provides those tags.

Target shapes:

- `Queue.Enqueue<Row>` for append-only fire-and-forget writes;
- `Sink.Sink<Out, In, L, E, R>` for stream-terminal commits;
- `Stream.Stream<Row, E, R>` for static durable observation;
- object-with-method services returning `Effect` for committed-row lookup,
  id assignment, claim/complete, or lifecycle transitions.

Do not create Firegrid-specific aliases for these Effect shapes. Durability is
carried by the `Context.Tag` and provider layer identity, not by a new type
family.

### Pure Transform

Pure `Stream -> Stream` row/event shaping. Transforms own no resources and do
not write durable rows.

Examples:

- sequencing runtime ingress rows for a context;
- decoding runtime ingress rows into agent input events;
- protocol-neutral row filtering or ordering.

If the type is simply:

```ts
Stream.Stream<A, E, R> => Stream.Stream<B, E, R>
```

leave it as a function. Do not introduce a `RuntimeTransform` abstraction.

### Runtime Subscriber

A long-running runtime fiber that consumes durable observations and performs
side effects through narrow capabilities.

Examples:

- ingress delivery: committed ingress rows to active codec input;
- tool router: committed `ToolUse` observations to `ToolResult` ingress;
- stderr journal: process stderr bytes to durable log rows.

Subscribers consume `Stream` capability tags and write through durable
capability tags. They do not accept runtime-owned `DurableTable` facades and
they do not consume dynamic `SourceCollectionHandle`s as their static read
surface.

### Protocol Codec

Translates a concrete wire protocol into normalized `AgentInputEvent` /
`AgentOutputEvent` values and reports per-session protocol capabilities such as
`toolUseMode`.

Codec modules do not write durable rows directly and do not own runtime
subscriber lifecycle.

### Host Composition

Wires host identity, table layers, workflow engine, runtime start/append
commands, sandbox providers, env policy, and runtime authority providers.

Host composition can remain the orchestration root, but it should not also
implement raw-process runtime execution, agent tool host behavior, or wait
operator internals.

### Workflow Or Operator Primitive

An Effect API called by workflow handlers or runtime tools that coordinates
durable suspension/resumption.

Examples:

- `WaitFor.match(...)`;
- future approval/budget/audit middleware operators;
- runtime/session facades that express durable command semantics.

These are not pipeline subscribers simply because they may internally use a
subscriber-like router. The public role is the operator.

Static shape:

```ts
const match: <A>(
  options: WaitForOptions<A>,
) => Effect.Effect<
  WaitForOutcome<A>,
  WaitForError | ParseResult.ParseError | DurableTableError,
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | DurableWaitAppendAndGet
  | DurableWaitCompletionAppendAndGet
  | Scope.Scope
>
```

The operator value returns an `Effect`. It may require durable capabilities,
workflow services, and `Scope`, but it does not provide a long-lived service
and does not acquire a source subscription by itself.

### Subscriber Driver

A scoped runtime driver that starts a long-lived observation worker. It is
expressed as a `Layer` that provides no public service and consumes the
capabilities it needs through the requirement channel.

Static shape:

```ts
const WaitRouterLive: Layer.Layer<
  never,
  WaitRouterError,
  | DurableWaitAppendAndGet
  | DurableWaitCompletionAppendAndGet
  | SourceCollections
  | WorkflowEngine.WorkflowEngine
>
```

This is the same Effect shape as `Layer.scopedDiscard(startRouter)`: the layer
exists for its scoped fiber, not because callers should depend on a
`WaitRouter` service. The output channel `never` is the static signal that the
module is a driver/subscriber, not an operator API or capability provider.

### Generic Durable Operator

A reusable durable operator that is not inherently Firegrid runtime vocabulary.
If a primitive can be expressed over generic durable row storage, workflow
clock/deferred, and named streams without runtime session/tool/codec words, it
is a candidate for `packages/effect-durable-operators`.

## Current Runtime Tree Classification

This inventory is the review checklist for the post-`#250` tree.

| Path | Primary role | Boundary status | Evidence | Folder cycle? |
| --- | --- | --- | --- | --- |
| `authorities/` | Effect capability providers | Target shape, except wait store placement. | Busy capability barrel. | No |
| `events/` | Normalized runtime event contracts | Target after compatibility re-exports drop. | Busy event/protocol barrel. | Yes, with `codecs/` |
| `transforms/` | Pure stream operators | Target shape. Plain functions over `Stream`; no transform framework. | Imports runtime errors from `host/`. | Yes, via `host/` |
| `subscribers/` | Runtime-host subscriber drivers | Target for agent event-pipeline subscribers. | Imports runtime errors from `host/`. | Yes, via `host/` |
| `pipeline/` | Per-runtime event-loop composition | Composition file, not a stage; to be inlined as `agent-event-pipeline/session-runtime.ts` in PR 6. | Pulls from many runtime folders. | Yes, with `host/` |
| `sources/` | Live process/resource acquisition | Mostly target; env policy leaks to app consumers. | Imports runtime errors from `host/`. | Yes, via `host/` |
| `codecs/` | Protocol wire-format normalization | Target shape; event barrel compatibility should drop. | Imported by `events/index.ts`. | Yes, with `events/` |
| `host/` | Host topology and command entrypoints | Mixed; source of most cycles. | Owns shared runtime errors today. | Yes |
| `waits/` | Durable coordination operator | Mixed; wait row authority belongs with wait bounded context. | Owns row schema/source registry/router. | No |
| `agent-tools/` | Runtime tool schemas, MCP exposure, and lowering | Mixed; MCP host couples to host authority. | Host/tool composition overlap. | Yes, via `host/` |
| `agent-adapters/` | Projections/adapters over codec sessions | Acceptable sibling surface. Keep out of durable runtime pipeline. | Adapter projection only. | No |
| `workflow-engine/` | Workflow engine adapter/substrate | Separate substrate boundary. Do not fold into agent runtime pipeline. | Runtime substrate dependency. | No |
| `verified-webhook-ingest/` | External ingress/source adapter | Separate ingest surface. Audit later for generic durable operator overlap. | Adjacent ingest surface. | No |

This table describes the current flat tree. The namespace target above is the
next cleanup once `host/index.ts` is split.

### `authorities/`

Role: Effect capability providers.

Target:

- keep table-family write/read ownership here;
- export split capability tags and provider layers;
- keep table-taking helpers private provider internals or explicit test
  fixtures;
- do not export singleton authority objects, review-only registries, or
  compatibility aliases.

Boundary question:

`durable-wait-store.ts` may be temporary. If generic durable waits move to
`effect-durable-operators`, runtime should retain only Firegrid adapter/provider
composition.

### `events/`

Role: normalized runtime event contracts and envelope helpers.

Target:

- own `AgentInputEvent`, `AgentOutputEvent`, protocol/runtime envelope helpers,
  and branded cross-stage identifiers;
- do not own durable storage or subscriber behavior;
- do not expose wrapper abstractions over `Stream`, `Sink`, `Effect`, or
  `Layer`.

### `transforms/`

Role: pure stream operators.

Target:

- keep shared row-shaping logic here;
- use plain `Stream` function signatures or `Channel` when first-class channel
  composition is needed;
- do not grow a runtime transform framework.

The ingress ordering extraction belongs here: both codec ingress delivery and
raw local-process stdin delivery share the same pure ordered-row selection, then
diverge into different side-effect semantics.

### `subscribers/`

Role: runtime-host subscribers over durable observations.

Target:

- host-scoped fibers that consume `Stream` capability tags;
- route through durable write capabilities;
- perform protocol/runtime side effects such as codec input delivery or
  tool-result ingress;
- do not own durable table providers or generic wait router internals.

The wait router is also subscriber-shaped: it consumes active wait rows,
attaches to named source streams, and writes completions. It should stay
wait-owned because its vocabulary is wait rows and source handles, not agent
event-pipeline events.

### `pipeline/`

Role: per-runtime source + codec + transform + subscriber composition.

Target:

- own the concrete runtime event loop for non-raw codec sessions;
- open codec sessions, fork runtime subscribers, journal output rows, and
  return terminal evidence;
- keep durable writes routed through capability tags;
- avoid casts that hide unresolved layer requirements.

### `sources/`

Role: live process/byte/resource acquisition.

Target:

- sandbox/process byte streams;
- local process stdin delivery source;
- secrets/env policy at live host boundary;
- no durable table ownership.

### `codecs/`

Role: protocol wire format normalization.

Target:

- ACP, stdio-jsonl, and future protocol sessions;
- per-session capability mode reporting;
- no durable row writes;
- no tool execution assumptions that contradict protocol directionality.

### `host/`

Role: host topology and command entrypoints.

Current issue:

`host/index.ts` is still too broad. Post-`#250`, it should be split without
changing behavior.

Target extraction:

- `host/runtime-context-workflow.ts`: workflow/activity/run lifecycle;
- `host/raw-process-runtime.ts`: raw local-process runtime and output-row
  construction;
- `host/agent-tool-host-live.ts`: host-coupled `AgentToolHost` implementation;
- `host/layers.ts`: current host session, table layers, host-scoped runtime
  composition;
- `host/commands.ts`: `startRuntime` and `appendRuntimeIngress`;
- `host/config-live.ts`: config-derived host topology layers;
- `host/index.ts`: public barrel and minimal entrypoint exports.

This is a behavior-preserving extraction follow-up, not a reason to reopen
the `#250` authority cutover.

### `agent-tools/`

Role: tool surface and lowering.

This folder is not one semantic role today. It contains:

- tool schemas and catalog metadata;
- tool lowering from normalized `ToolUse` to Firegrid effects;
- MCP server exposure for agent tools;
- scheduled input workflow helpers;
- test fixtures around tool execution.

Target:

- keep schema/catalog definitions together as the public runtime tool surface;
- keep protocol-neutral lowering separate from host-coupled live services;
- treat MCP host exposure as host/tool composition, not as a generic runtime
  subscriber;
- keep `wait_for` lowering expressed through `WaitFor.match`, not through a
  second wait abstraction.

This audit is a follow-up after `host/index.ts` extraction. Do not bundle it
into the first host split unless moving a host-coupled implementation out of
`host/index.ts` requires a small tool-host module.

### `agent-adapters/`

Role: projections/adapters over codec sessions.

Adapters can expose a codec-backed session as another API, such as an Effect AI
`LanguageModel.Service`. They are sibling projections of codec sessions, not a
stage inside the durable runtime event pipeline.

Target:

- do not let adapters write runtime durable rows directly;
- do not route runtime pipeline lifecycle through adapters;
- keep adapter registries as adapter-specific composition, not runtime
  authority registries.

### `workflow-engine/`

Role: workflow substrate adapter.

The workflow engine is below the runtime agent pipeline. It owns workflow
execution semantics, durable continuation behavior, and workflow integration
with the pinned `@effect/workflow` surface.

Target:

- do not move runtime host concerns into `workflow-engine/`;
- do not move generic workflow-engine internals into runtime host modules;
- keep version-coupled Effect/workflow adapter changes as standalone work.

### `verified-webhook-ingest/`

Role: external ingress/source adapter.

This folder is adjacent to runtime event ingestion but not part of the agent
session pipeline. It likely overlaps with generic durable-source or verified
ingress patterns, but its current Firegrid-specific semantics should not be
moved opportunistically.

Target:

- keep it outside the runtime agent event pipeline;
- audit whether keys/table/source pieces are generic durable operators;
- require a separate SDD before moving it to a substrate package.

### `waits/`

Role: durable coordination operator.

This folder still has a place, but not as a runtime pipeline stage.

`wait_for` is workflow-visible durable suspension over dynamically registered
observation streams. It is not itself an agent event subscriber. The public
operator is `WaitFor.match(...)`; the subscription router is an implementation
detail that is subscriber-shaped.

Current mixed roles:

- operator API: `WaitFor.match(...)`;
- source registry: `SourceCollections`;
- durable wait rows and completions;
- wait key construction;
- timeout/race/deferred/clock semantics;
- subscription router implementation.

Post-`#250` target:

- keep `WaitFor.match(...)` as the operator API;
- express the wait router as a wait-owned subscriber driver, for example
  `waits/internal/router.ts`;
- split wait row storage capabilities so the provider layer exposes row-level
  operations, not wait lifecycle policy;
- decide which pieces are generic durable operators and move them to
  `packages/effect-durable-operators`;
- keep runtime `waits/` only as a Firegrid adapter if needed;
- do not wrap `WaitFor.match` in speculative runtime capability tags unless a
  real production bridge consumes that service.

## Wait Operator And Subscriber Driver

The right split is:

- `WaitFor.match(...)` is the workflow/operator API. It writes durable wait
  intent, suspends on workflow deferred state, and returns `Match | Timeout`.
- the wait router is a subscriber driver. It watches active wait rows, looks up
  registered source streams, matches rows against durable trigger data, writes
  completions, and resumes workflow deferred state.

The distinction is statically visible:

- operator APIs are functions returning `Effect`;
- subscriber drivers are scoped `Layer<never, E, R>` values that provide no
  service and exist only to run host-scoped fibers.

This lets the wait router use the same static shape as tool routing and
ingress delivery without pretending the whole `waits/` concept is a subscriber
or moving wait vocabulary into the agent event-pipeline subscriber folder. It
is an operator with a wait-owned subscriber driver.

Timeout ownership is intentionally left unchanged for the first reconciliation
pass. Moving timeout resolution from `WaitFor.match` into the wait router would
change restart and race semantics, so it requires separate ACIDs.

## Wait Row Authority Is Not Wait Semantics

`authorities/durable-wait-store.ts` is the main place where semantics can
bleed. It should be a row authority over durable wait tables, not the owner of
the wait lifecycle model.

The target principle is row-level: lookup, upsert, and row-stream capabilities
for `WaitRow` and `WaitCompletionRow`. The exact tag names belong to the wait
authority PR, not to this boundary SDD. The provider layer may still be one
implementation backed by one `DurableToolsTable`, but callers should consume
narrow row capabilities. The provider should not expose bundled services like
"append and get" if the service also contains lookup, filtered active streams,
and completion scans.

Lifecycle language belongs outside the authority:

- `WaitFor.match(...)` decides when to author an active wait row and how to
  race timeout for the first reconciliation pass.
- the wait router decides which wait rows are active by filtering
  `DurableWaitIntentRows`.
- the wait router writes match completions and flips the wait row status
  through row upsert capabilities.
- reconciliation reads completion rows and resumes workflow deferred state.

In other words, the authority stores `WaitRow` and `WaitCompletionRow`.
Operators and subscriber drivers interpret those rows.

## Why `waits/` May Belong In `effect-durable-operators`

Much of the wait implementation is not intrinsically Firegrid runtime-specific:

- stable wait keys;
- wait rows and completion rows;
- active/completed wait lifecycle;
- source-name matching;
- timeout/race behavior;
- durable deferred/clock integration;
- subscription router over named streams.

Those pieces are candidates for `packages/effect-durable-operators` if they can
be expressed without Firegrid runtime vocabulary.

Runtime should keep:

- Firegrid source names and source registrations;
- agent-tool `wait_for` bindings;
- runtime-host layer composition;
- any adapter code that connects generic waits to runtime observations.

This should be a separate extraction SDD/PR. Do not move waits during the
runtime event pipeline cutover.

## Source Collections Boundary

The runtime has two read paths over committed durable rows:

- static subscribers consume `Stream` capability tags through the Effect
  requirement channel;
- dynamic `wait_for` lookup consumes `SourceCollectionHandle`s by source name.

`SourceCollectionHandle` therefore belongs to dynamic wait/source registration,
not as the universal read abstraction. If a public helper constructs source
handles directly from `DurableTableCollectionFacade`, it should be internalized
or moved to the generic durable-operator boundary.

## Compatibility And Review Surfaces

Production runtime code must not keep public surfaces that exist only for
review, tests, or compatibility:

- no exported authority registry whose only consumers are tests/docs;
- no singleton authority classes or objects;
- no table-taking helper exports;
- no stale package subpaths preserved only for apps that can be updated;
- no open-ended compatibility aliases.

Tests may keep local metadata and fixtures to verify provider uniqueness or
semgrep behavior, but that metadata is not a runtime API.

## Follow-Up Plan

Work is sequenced so each PR is behavior-preserving and unlocks the next.

### PR 1: Cycle-Breaking And Static Baseline Zeroing

Goal: zero folder-level cycles under `packages/runtime/src` and zero accepted
static-tooling debt for the gates touched by the reconciliation wave.

1. Create `packages/runtime/src/runtime-errors.ts` and move
   `RuntimeContextError`, `asRuntimeContextError`, and
   `mapRuntimeContextError` out of `host/errors.ts`. Update internal importers.
2. Remove `events/index.ts` re-exports of `codecs/contract.ts` and
   `sources/byte-stream.ts`. Internal callers import codec contracts from
   `codecs/index.ts` and byte streams from `sources/byte-stream.ts`. If any app
   imports codec or byte-stream symbols through `@firegrid/runtime/events`,
   route those imports through target runtime barrels before removing the
   re-export so app builds remain unchanged.
3. Remove `host/authority-context.ts` as a runtime compatibility alias. Runtime
   internals should import the real protocol launch authority surface or the
   target runtime capability directly.
4. Add a dependency-cruiser `scope: "folder"` circular rule for
   `packages/runtime/src` after the cycle-breaking edits make the accepted
   finding count zero. Do not add a baseline file or carve-out that preserves
   the known post-`#250` cycles.
5. Drop static-tooling baselines to zero for the gates touched by this wave.
   That includes the new architecture enforcement and any existing lint gate
   whose baseline would otherwise bless known debt.

Acceptance:

- zero folder cycles under `packages/runtime/src`;
- dependency-cruiser enforces zero folder cycles directly, without a runtime
  folder-cycle baseline;
- the load-bearing barrels keep their intended public surfaces;
- downstream apps build without changes;
- `packages/runtime/src/runtime-errors.ts` is the only new top-level runtime
  file introduced by PR 1;
- static-tooling accepted findings are zero for the gates this wave changes.

### PR 2: Host Extraction

Goal: reduce `host/index.ts` to a small composition root and barrel.

Target extraction:

- `host/runtime-context-workflow.ts`: workflow/activity/run lifecycle;
- `host/raw-process-runtime.ts`: raw local-process runtime and output-row
  construction;
- `host/agent-tool-host-live.ts`: host-coupled `AgentToolHost` implementation;
- `host/layers.ts`: current host session, table layers, host-scoped runtime
  composition;
- `host/commands.ts`: `startRuntime` and `appendRuntimeIngress`;
- `host/config-live.ts`: config-derived host topology layers;
- `host/index.ts`: public barrel and minimal entrypoint exports.

PR 1 is a prerequisite. Extraction is cleaner once host no longer owns shared
runtime error types.

### PR 3: Source Registration Ownership

Goal: eliminate `host/observation-sources.ts` as standalone glue.

Authority/provider layers that expose static `Stream` capability tags should
also construct the corresponding `SourceCollectionHandle` registrations needed
for dynamic `wait_for` lookup. Host composition should merge provider layers;
it should not know every source handle that must be registered.

This may introduce an edge from authority provider code to the source-handle
constructor surface. That edge is acceptable only because dynamic source
registration is the bridge from static stream capabilities to `wait_for`
lookup; it should not become a broader dependency from authorities to wait
semantics.

### PR 4: Wait Authority Comes Home

Goal: move the wait row authority next to the wait row schema.

Move `authorities/durable-wait-store.ts` into the wait bounded context and
split its services into row-level lookup/upsert/stream capabilities. This does
not move waits to `effect-durable-operators` and does not change
`WaitFor.match`.

Target shape:

- `WaitRow` lookup by key;
- `WaitRow` upsert;
- `WaitRow` stream;
- `WaitCompletionRow` lookup by key;
- `WaitCompletionRow` upsert;
- `WaitCompletionRow` stream.

### PR 5: Wait Router Subscriber-Driver Shape

Goal: name the wait router as a subscriber driver without moving it into the
agent event-pipeline subscriber folder.

Rename `waits/internal/subscription-router.ts` to `waits/internal/router.ts`
or `waits/internal/wait-router.ts`, and make the driver shape explicit as a
scoped `Layer<never, E, R>` that provides no public service. Do not move timeout
ownership into the router in this PR.

### PR 6: Agent Event-Pipeline Namespace

Goal: mechanically namespace clean event-pipeline pieces away from host,
workflow-engine, waits, tools, adapters, and verified ingest.

Target direction:

```txt
agent-event-pipeline/
  protocol/
    events.ts
    codecs/
    transforms/
  sources/
  authorities/
    runtime-output-journal.ts
    runtime-ingress-appender.ts
    runtime-ingress-delivery-tracker.ts
  subscribers/
  session-runtime.ts
```

`pipeline/` is removed as a stage-looking folder. Its current composition
responsibility becomes `agent-event-pipeline/session-runtime.ts`.

### PR 7: Factory Consumer Audit

Goal: narrow `apps/factory` to public client and runtime host/config surfaces.

Factory currently reaches into event and source/env-policy internals. Permission
observations should come from the client/session surface when possible, and env
policy should be available through a runtime host/config surface rather than
sandbox internals.

### PR 8: Durable Wait Extraction SDD

Decide which `waits/` internals belong in `packages/effect-durable-operators`.
Require a package-boundary SDD before any code moves.

Draft this SDD when durable wait coordination is needed outside Firegrid
runtime vocabulary, for example by another workflow product that can consume
the same wait rows, completion rows, timeout, and source-matching primitives.

### PR 9: Public Surface Cleanup

Enforce final exports after the layout reshuffles. Use dependency-cruiser for
directory/import-boundary rules and semgrep for code-pattern rules. The
dependency-cruiser rules should fail on:

- new folder-level cycles in `packages/runtime/src`;
- direct imports from runtime host internals outside the host barrel;
- direct imports of `runtime-errors.ts` from outside `@firegrid/runtime`;
- top-level runtime folders without a documented role in this SDD.

### PR 10: Docs Consolidation

Move stable architecture guidance into `packages/runtime/ARCHITECTURE.md` once
the post-`#250` refactors land. Keep SDDs as decision records, not the only
source of operational architecture guidance.

## Refactor Sequencing Invariants

Every PR in the follow-up plan must satisfy:

1. **No folder cycles.** PR 1 pays the folder-cycle debt down to zero and adds
   a dependency-cruiser hard gate. PRs 2 onward must not regress it.
2. **Load-bearing barrels are stable.** Internal layout can change; public
   imports through `authorities/index.ts`, `events/index.ts`, and
   `@firegrid/protocol/launch/index.ts` stay coherent unless a PR migrates all
   importers.
3. **No new Firegrid abstractions.** Effect's `Context.Tag`, `Layer`,
   `Queue.Enqueue`, `Stream`, `Sink`, and narrow `Effect` services cover the
   roles this SDD defines.
4. **Apps build unchanged until the app audit.** PRs 1 through 6 are
   runtime-internal. Factory's surface audit is the first PR expected to touch
   downstream product imports.
5. **Provider uniqueness is tested against real Effect values.** Keep
   test-local metadata and avoid production registries for review tooling.
6. **No accepted-debt baselines.** New architecture enforcement lands with a
   zero accepted-finding state. Existing static tooling baselines should be
   removed or reduced to zero during the first reconciliation wave rather than
   extended.

## Non-Goals

- Do not re-open the `#250` event-pipeline cutover unless a correctness bug is
  found.
- Do not preserve compatibility aliases for downstream apps that can import
  target primitives.
- Do not introduce new Firegrid abstractions over Effect surfaces.
- Do not move `waits/` to `effect-durable-operators` without a separate
  package-boundary SDD.
- Do not turn every implementation detail into a top-level runtime stage.
- Do not split load-bearing barrels without migrating all importers in the same
  PR.
- Do not change `apps/flamecast`'s runtime import pattern. It already consumes
  runtime through a single host entrypoint.
- Do not relocate the wait router to `subscribers/`. It has subscriber-driver
  shape, but its vocabulary is wait rows and source handles, not agent
  event-pipeline events.
