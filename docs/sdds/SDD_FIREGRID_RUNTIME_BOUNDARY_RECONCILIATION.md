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

## Scope Decision

This SDD is not a second event-pipeline rewrite. It is a post-`#250`
boundary reconciliation pass with three concrete outcomes:

1. make `host/index.ts` a small public entrypoint and move its remaining
   behavior into role-specific host modules;
2. classify every top-level runtime folder by semantic role so future work has
   an explicit home;
3. decide which `waits/` pieces are runtime-specific and which need a separate
   `effect-durable-operators` extraction SDD.

The first implementation PR should be the host extraction because it is
behavior-preserving and local to `packages/runtime`. The waits extraction is
design work first; do not move wait internals to another package until that
package boundary is specified.

## Role Rule

Folders are allowed to contain multiple files, but a production module should
have one primary role. If a module needs two roles, it should either be:

- a composition module whose job is explicitly to wire roles together; or
- marked for extraction in this SDD.

This is intentionally stricter than "the code works today." The point is to
prevent convenience modules from becoming hidden architecture.

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

| Path | Primary role | Boundary status |
| --- | --- | --- |
| `authorities/` | Effect capability providers | Target shape. Keep provider layers and capability tags here. |
| `events/` | Normalized runtime event contracts | Target shape. No storage or subscriber behavior. |
| `transforms/` | Pure stream operators | Target shape. Plain functions over `Stream`; no transform framework. |
| `subscribers/` | Runtime-host subscriber drivers | Target shape for host-scoped durable observation workers, including agent pipeline subscribers and the wait router. |
| `pipeline/` | Per-runtime event-loop composition | Target shape. Keep session-local composition here. |
| `sources/` | Live process/resource acquisition | Mostly target shape. Keep durable writes out. |
| `codecs/` | Protocol wire-format normalization | Target shape. Per-session capabilities belong here. |
| `host/` | Host topology and command entrypoints | Mixed. Needs behavior-preserving extraction. |
| `waits/` | Durable coordination operator | Mixed but not misplaced. Needs package-boundary design before extraction. |
| `agent-tools/` | Runtime tool schemas, MCP exposure, and lowering | Mixed. Needs sub-boundary audit after host extraction. |
| `agent-adapters/` | Projections/adapters over codec sessions | Acceptable sibling surface. Keep out of durable runtime pipeline. |
| `workflow-engine/` | Workflow engine adapter/substrate | Separate substrate boundary. Do not fold into agent runtime pipeline. |
| `verified-webhook-ingest/` | External ingress/source adapter | Separate ingest surface. Audit later for generic durable operator overlap. |

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
attaches to named source streams, and writes completions. It can live under
`subscribers/` if the folder is defined as host-scoped durable observation
drivers rather than only agent event-pipeline subscribers.

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
- express the wait router as a subscriber driver, either under
  `subscribers/wait-router.ts` or as clearly named wait-internal subscriber
  implementation;
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

This lets the wait router share the same subscriber folder as tool routing and
ingress delivery without pretending the whole `waits/` concept is a
subscriber. It is an operator with a subscriber driver.

Timeout ownership is intentionally left unchanged for the first reconciliation
pass. Moving timeout resolution from `WaitFor.match` into the wait router would
change restart and race semantics, so it requires separate ACIDs.

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

1. **Host Extraction PR**
   - Split `host/index.ts` into behavior-preserving modules.
   - Keep public exports stable only for target primitives.
   - Validate with existing runtime host, prompt-routing, sync-run, and codec
     event-plane tests.
   - Do not change package boundaries or wait internals.

2. **Runtime Boundary Audit PR**
   - Add a module-role inventory table for current `packages/runtime/src`.
   - Mark each folder/module as provider, transform, subscriber, codec, source,
     host composition, workflow/operator, or generic durable operator.
   - Flag modules with mixed roles.
   - Produce concrete follow-up issues for `agent-tools/`,
     `verified-webhook-ingest/`, and any public exports that do not map to a
     role.

3. **Durable Wait Extraction SDD**
   - Decide which `waits/` internals belong in `effect-durable-operators`.
   - Define a generic source registry and wait lifecycle contract.
   - Keep runtime-specific adapter code in `packages/runtime`.

4. **Public Surface Cleanup PR**
   - Re-check package exports after host/wait extraction.
   - Ensure semgrep and dependency-cruiser rules reflect the final target
     boundaries.

5. **Docs Consolidation**
   - Move stable architecture guidance from the SDD into a runtime
     `ARCHITECTURE.md` after the post-`#250` refactors land.
   - Keep SDDs as decision records, not the only source of operational
     architecture guidance.

## Non-Goals

- Do not re-open the `#250` event-pipeline cutover unless a correctness bug is
  found.
- Do not preserve compatibility aliases for downstream apps that can import
  target primitives.
- Do not introduce new Firegrid abstractions over Effect surfaces.
- Do not move `waits/` to `effect-durable-operators` without a separate
  package-boundary SDD.
- Do not turn every implementation detail into a top-level runtime stage.
