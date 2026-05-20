# Host SDK / Runtime Boundary Framing

Status: draft architecture framing

Date: 2026-05-20

## Purpose

`packages/host-sdk/` and `packages/runtime/` currently overlap in a way that
makes implementation dispatch hard to reason about. `host-sdk` exposes
consumer-facing host composition, but it also contains workflow definitions,
workflow execution helpers, channel registry state, runtime input dispatch,
control-request workflows, and tool execution lowering. Those are not all the
same tier.

This document makes the package-tier decision before the next refactor wave. It
does not prescribe file moves line-by-line. It names the boundary rule refactor
lanes should apply.

Inputs:

- `docs/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`
- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md`
- `docs/sdds/SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md`
- `docs/sdds/SDD_FIREGRID_ENGINE_NATIVE_PRIMITIVES_ESCAPE_HATCH.md`
- `docs/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
- landed `tf-ho99`: control-request reconciler as workflow-backed hybrid
- landed `tf-ws2x`: runtime-context engine registry collapsed into
  Layer-provided runtime services

## Decision

The firewall is **schema catalog -> bindings -> execution substrate**, with
channels as the application/agent-facing firewall inside the binding layer.

```text
@firegrid/protocol
  schema catalog, operation contracts, row/projection schemas
  no runtime execution, no MCP server, no workflow engine

bindings
  @firegrid/host-sdk
    host composition facade, channel capability composition, MCP / Effect-AI
    tool binding, local host topology entrypoints
  @firegrid/client-sdk
    browser/app-safe client binding over protocol schemas
  future @firegrid/cli
    CLI binding over protocol schemas

@firegrid/runtime
  execution substrate: workflow engine integration, workflow definitions,
  runtime event pipeline, durable authorities, adapter internals, verified
  ingress implementation, engine-native primitives
```

Channels are the load-bearing semantic firewall for agents and applications:

```text
agent/app intent
  -> protocol schema
  -> binding surface
  -> semantic channel capability
  -> runtime execution substrate
```

The host SDK may compose channel capabilities. It must not make workflow
handles, workflow execution ids, stream URLs, table CDC details, durable wait
stores, or engine services part of the application model.

## Rationale

The body-plan SDD states that channels are typed semantic capabilities: the
agent sees `wait_for(channel)`, `send(channel)`, and `call(channel)`, while the
host-provided channel binding hides workflows, durable streams, durable tables,
clocks, and future engine-native primitives. It also explicitly says Firegrid
channels are not aliases for `effect/Channel`; they are Firegrid-specific
tagged capabilities backed by ordinary Effect shapes such as lazy `Stream`
sources, effectful sinks, and request/response handlers.

The one-substrate SDD states that the workflow engine is the durable execution
substrate. Phase 1's `wait_for(source/query) -> WaitForWorkflow` bridge is a
substrate migration, not the final agent-facing surface. That makes workflow
execution infrastructure lower-tier than host SDK application code.

The schema-projection SDD supplies the package graph: protocol owns the schema
catalog; host-sdk, client-sdk, and CLI are bindings; runtime owns execution.
That is stronger than "channels and above = host-sdk" by itself. Channels are
the semantic cut, but package placement is determined by whether a module is a
schema, binding, or execution substrate.

The engine-native primitives SDD names the post-cutover direction: collapsing
polling loops, registries, and hand-rolled coordination into workflow-engine
services. That is runtime substrate work even when host composition starts it.

## Composition Boundary Rule

The shortest path out of the current ambiguity is to make `host-sdk` a
composition boundary, not a substrate owner.

Under this rule, `host-sdk` may compose ordinary Effect `Layer`s and
application/deployment resources, but the things being composed should be
semantic resources or projection bindings that can be lowered into the runtime
substrate. It should not assemble workflow engines, durable table facades,
deferred-row drivers, runtime observation providers, or control-plane dispatch
loops directly.

That gives a concrete decision test:

- If the module defines a semantic binding, channel, MCP/tool projection, host
  config DTO, or public host Layer entrypoint, it can live in `host-sdk`.
- If the module owns durable execution, workflow-engine lifecycle, table/stream
  authority, replay behavior, runtime output/session adapters, or control-plane
  dispatch, it belongs below the line in `runtime`.
- If a host binding needs runtime behavior, it should require a runtime-owned
  capability tag and provide a host-specific implementation at composition time.
  It should not import and assemble runtime substrate internals itself.

This is why files such as `runtime-substrate.ts` are confusing: they make
`host-sdk` both the composition boundary and the lower-tier substrate assembler.
As that knot is split, most placement decisions become mechanical: host-sdk
keeps the binding/projection Layer; runtime owns the live machinery underneath.

## Package Roles

### `@firegrid/protocol`

Owns:

- operation input/output schemas;
- channel target wire schemas and channel metadata schemas;
- durable row schemas that multiple packages must agree on;
- normalized observation schemas for client reads and agent-visible events;
- capability tags that are pure protocol authority surfaces, such as
  `RuntimeStartCapability`, when the service shape is a protocol-level
  contract and not a runtime implementation.

Does not own:

- live Layers that touch Durable Streams;
- workflow definitions;
- MCP server construction;
- Effect AI `Tool` / `Toolkit` values;
- runtime adapter sessions;
- host process topology.

### `@firegrid/host-sdk`

Owns binding and composition, not substrate implementation.

It should contain:

- public host construction helpers such as `FiregridRuntimeHostLive` and
  config-to-Layer adapters;
- host-author composition of channel Layers;
- channel binding definitions that are presentation-level, such as
  `LinearWebhookLive`, `session.self.lifecycle`, `session.log`, human-channel,
  or app-owned `state.changes(collection)` bindings;
- MCP server exposure and metadata projection;
- Effect AI tool binding: protocol schemas -> `Tool` / `Toolkit`;
- Node/local-process topology selection and host-author options;
- narrow live layers that provide runtime-owned capability tags when those
  layers are explicitly host-bound.

It should not contain as stable architecture:

- workflow definitions (`Workflow.make`, `Activity.make`) for runtime
  execution;
- workflow-engine lifecycle caches or execution registries;
- durable wait stores, wait routers, or source registration services;
- agent-event-pipeline subscribers that implement runtime behavior;
- direct table CDC handling except inside a channel binding adapter whose
  public surface remains a semantic channel;
- common operation execution that multiple bindings could share.

`host-sdk` may still have transitional internal files in these categories while
Phase 1 and Phase 2 are landing. Treat them as debt to move below the binding
line, not precedent for new code.

### `@firegrid/runtime`

Owns execution substrate and hidden mechanics.

It should contain:

- workflow engine implementation and engine-native primitives;
- workflow definitions: `RuntimeContextWorkflow`, `WaitForWorkflow`,
  `RuntimeContextProvisionWorkflow`, `RuntimeStartWorkflow`,
  `RuntimeLifecycleWorkflow`, scheduled-input/tool-call workflows, and future
  channel wait workflows;
- runtime event pipeline sources/codecs/events/transforms/authorities;
- runtime output/input durable authorities;
- verified webhook ingestion implementation and durable tables;
- local process / ACP / provider adapter internals;
- runtime operation execution core for validated protocol operations when that
  execution uses workflow engine, durable streams, provider adapters, or runtime
  authorities.

It should not contain:

- user-facing SDK method names;
- MCP tool descriptions or `Tool.make` bindings;
- CLI commands;
- app-specific channel inventory decisions;
- host-author convenience wrappers that only choose which Layers to compose.

Runtime may export narrow capability tags and Layers for bindings to compose.
It should not export broad table facades or "registry" objects as application
surfaces.

### `@firegrid/client-sdk`

Owns browser/app-safe client binding over protocol schemas and normalized
observations. It must remain runtime-source-free. It may depend on protocol
schemas and explicitly supplied transport/capability services. It must not call
workflow handles, runtime host modules, adapter sessions, or durable table
facades directly.

## Single Interaction Pattern

All client, agent, CLI, REST, gRPC, JSON-RPC, and host-author surfaces should
follow one interaction pattern:

```text
protocol operation / observation / channel contract
  -> environment projection package
  -> transport or runtime-owned capability tag
  -> runtime authority / workflow / adapter
  -> durable streams substrate
```

The durable streams substrate may still be the backing transport for a local
client or host process, but it should be hidden behind one of two shapes:

- a projection transport implementation owned by the projection package; or
- a runtime-owned capability tag provided by host composition.

The public surface should not expose `DurableTable` facades, workflow handles,
stream URLs, table names, deferred-row names, execution ids, or runtime
observation resolver tags as the way users interact with Firegrid. Those are
lower-tier coordinates.

This rule also constrains tests and simulations. A simulation driver intended
to model an end user should use the same projection package a user would use.
Host-side simulation code may compose Layers, but should not normalize private
substrate helpers into public import paths.

## Answers To The Open Questions

### 1. Is "channels and above = host-sdk; below channel Layer = runtime" right?

Close, but incomplete.

The stronger rule is:

```text
protocol schemas = protocol
binding surfaces and host composition = host-sdk / client-sdk / CLI
execution substrate behind channel capabilities = runtime
```

Channels are the semantic firewall between application/agent code and runtime
substrate. They are not the only package boundary. Agent-tool binding, client
binding, and CLI binding are peers over protocol schemas; runtime is below all
of them.

### 2. Is `packages/protocol` a third package in the firewall picture?

Yes. It is the source of truth for schema and operation contracts. The intended
picture is:

```text
protocol schema catalog
  -> bindings: host-sdk agent tools / client-sdk / CLI
  -> execution: runtime
```

Protocol may define channel target schemas, channel metadata row schemas, and
normalized observation schemas. It should not define live channel Layers.

### 3. What in `host-sdk` genuinely belongs there?

Belongs in `host-sdk`:

- `mcp-host.ts`: MCP server exposure and route-scoped toolkit installation.
- `agent-tools/bindings/*`: protocol -> Effect AI tool binding.
- `config-live.ts`, `layers.ts`, `types.ts`: host-author composition entrypoints
  and topology options, after they stop exporting substrate internals as the
  public model.
- channel binding modules when they are presentation adapters, such as
  `event-channel.ts`, `state-changes-channel.ts`, `human-channel.ts`,
  `session-log-channel.ts`, and `channels/session-self/*`, provided they depend
  on semantic channel capabilities and narrow runtime tags rather than workflow
  tables directly.
- `runtime-context-mcp-base-url.ts`: host-bound late binding for MCP URL
  publication.

Likely leaked below the line:

- `runtime-context-workflow-core.ts`: workflow definition and Activity body.
- `runtime-context-workflow-runtime.ts`: host-scoped workflow engine lifecycle,
  execution map, input dispatch, checkpoint source.
- `runtime-input-deferred.ts`: workflow-engine input delivery mechanics.
- `runtime-substrate.ts`: runtime execution substrate and workflow support
  capture.
- `control-request-reconciler.ts`: request workflow definitions and runtime
  control execution.
- `agent-tools/execution/tool-use-to-effect.ts`: validated operation execution
  and workflow/channel lowering.
- `agent-tool-host-live.ts`: host-coupled execution of spawn/session/tool
  operations.
- `host-owned-durable-tools.ts`: transitional durable-tools composition; should
  disappear with Phase 1.
- `per-context-runtime-output.ts`, `runtime-ingress-transform.ts`, and
  `projection-observer.ts`: likely runtime authorities/transforms unless they
  are deliberately host binding adapters.

### 4. What in `runtime` may be above the substrate line?

Some runtime exports are currently binding-facing and should be reviewed:

- `verified-webhook-ingest` exposes public request/config/result types and a
  table. The ingestion implementation belongs in runtime; the channel binding
  that turns a verified webhook fact table into `Channel<LinearWebhook>` belongs
  in host-sdk or an app integration package. Protocol should own any stable
  webhook fact schema that multiple bindings need.
- `runtime-output`, `streams`, and `events` export useful observation types.
  Stable normalized observation schemas should migrate or project through
  protocol. Runtime may keep richer internal envelopes and authority tags.
- `agent-adapters` are runtime substrate. Host SDK may offer composition helpers
  that install adapters, but adapter sessions and codec mechanics are runtime.
- `durable-tools` remains a transitional runtime surface. Phase 1 deletes it.

The rule: if a runtime export is a public product contract, move or project it
through protocol. If it is a capability implementation, keep it runtime.

## Placement Of Specific Surfaces

| Surface | Target tier | Decision |
| --- | --- | --- |
| `RuntimeContextWorkflow`, `WaitForWorkflow`, scheduled/tool-call workflows | runtime | Workflow definitions and Activities are execution substrate. Host SDK may install their Layers but should not own their bodies. |
| `RuntimeContextProvisionWorkflow`, `RuntimeStartWorkflow`, `RuntimeLifecycleWorkflow` | runtime | `tf-ho99` proved the workflow-backed control path. The hybrid durable request-row compatibility surface can stay protocol/host-facing, but workflow execution belongs in runtime. |
| Channel Layers such as `LinearWebhookLive`, `session.self.lifecycle`, `state.changes(collection)` | split | Channel contract/metadata schema in protocol when stable; channel binding Layer in host-sdk or app integration; substrate providers in runtime. |
| `channel-registry.ts` | replace with binding edge only | `tf-kddg` should delete central registry architecture. Use per-channel `Context.Tag` + Layer composition. Any string lookup is only the MCP/protocol adapter from agent-supplied `channel: string` to the typed capability. |
| `tool-use-to-effect.ts` | split | Decode and `ToolResult` adaptation may remain host-sdk binding. Validated operation execution should move to runtime execution services, especially arms that use workflow engine, durable streams, or provider adapters. |
| `runtime-substrate.ts` | split/move below | Current host-sdk knot for runtime authorities, observation streams, workflow support, and tool execution. Runtime should own the provider/capability seams; host-sdk should compose top-level host bindings and stop exporting substrate assembly. |
| `agent-tools/execution/toolkit-layer.ts` | split | MCP/Effect-AI toolkit projection belongs in host-sdk. Its workflow/tool execution support should depend on runtime-owned capability tags, not import `host/runtime-substrate.ts`. |
| `runtime/authorities/*` | runtime | Narrow Effect capability providers over durable table families. This is substrate, not public API; export tags/layers and prevent table facades from leaking upward. |
| `runtime/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts` | move within runtime | Defines a runtime tool-execution service tag, not a subscriber driver. It should live under tool-execution/workflow seams; `subscribers/` should remain scoped observation drivers. |
| MCP server / Effect AI toolkit | host-sdk | This is host binding and route exposure. It projects protocol schemas into MCP/Effect AI surfaces. |
| Session-handle / client facade helpers | client-sdk + protocol | Client SDK owns app-safe methods. Protocol owns schemas and normalized observations. Runtime supplies capabilities, never direct client imports. |
| Durable Streams substrate access | runtime | Provider internals touch tables/streams. Host SDK consumes narrow tags or channel bindings; client SDK consumes protocol-safe transport/read capabilities. |
| Verified webhook ingestion | runtime implementation, host/app channel binding | Signature verification and durable fact insert belong in runtime. Exposing those facts as `Channel<LinearWebhook>` is a host/app channel binding. |
| Webhook route installation | host-sdk or app integration | HTTP route/server binding is deployment composition. It calls runtime ingestion and provides a channel binding; it does not own verification substrate. |
| `RuntimeStartCapability` | protocol tag, runtime/host implementation | The service shape is protocol-owned authority. Host/runtime composition provides the live implementation. |

## Dark-Factory / Consumer Story

Moving infra out of `host-sdk` must not make dark-factory harder to compose. The
consumer story should stay:

```ts
const ChannelsLive = Layer.mergeAll(
  LinearWebhookLive(...),
  HumanApprovalChannelLive(...),
)

Layer.mergeAll(
  FiregridRuntimeHostLive(options).pipe(
    Layer.provideMerge(ChannelsLive),
  ),
  FiregridMcpServerLayer(mcpOptions).pipe(
    Layer.provideMerge(ChannelsLive),
  ),
)
```

The exact composition shape may change as channel Layers become first-class.
The invariant is that channel Layers are ordinary Effect services provided into
host/MCP/toolkit layers that need them; they are not a mutable registry passed
around as application state. Today, host-sdk often exposes or contains the
execution machinery directly. Under this framing, host-sdk composition helpers
provide semantic capabilities and runtime-owned services. The app still
composes one host layer; it does not import workflow definitions or durable
table facades.

That preserves ergonomics while improving testability: tests can provide a fake
channel tag, fake runtime execution service, or fake protocol capability
without booting the full host workflow engine.

## Risk Surfaces

### Runtime-to-host callback pressure

If runtime execution needs something host-specific, it must not import
`@firegrid/host-sdk`. Invert the dependency with a runtime-owned capability tag
and a host-sdk-provided live Layer. This is the existing `RuntimeToolUseExecutor`
shape: runtime owns the seam; host-sdk owns the host-bound implementation.

Apply the same pattern for future substrate-to-host needs:

```text
runtime workflow / adapter / execution service
  -> requires RuntimeOwnedCapability Tag
  -> host-sdk provides RuntimeOwnedCapabilityLive from host topology
```

Do not solve these edges by moving host composition into runtime or by letting
runtime import host-sdk. That would recreate the package cycle the firewall is
meant to prevent.

## Implementation Sequence

Do not start with a broad file relocation. Start with import direction and
surface splits.

1. **Finish `tf-kddg`: channel registry to per-channel Tags/Layers.** This
   removes the most visible registry-shaped application surface and gives the
   binding layer a type-safe capability model.
2. **Split agent-tool binding from execution.** Keep Effect AI `Tool` /
   `Toolkit` and MCP exposure in host-sdk. Introduce runtime execution services
   for validated operations. `tool-use-to-effect.ts` should shrink toward an
   adapter that decodes protocol input, calls an execution service, and encodes
   `ToolResult`.
3. **Move workflow definitions below the binding line.** Runtime owns
   `RuntimeContextWorkflow*`, `WaitForWorkflow`, and control request workflows.
   Host SDK installs the Layers and supplies host topology.
4. **Review channel bindings one by one.** If a channel module only wraps a
   runtime tag/table into a semantic channel, it can stay host-sdk. If it
   implements durable execution, move that implementation to runtime and leave a
   thin host-sdk Layer.
5. **Add static dependency guardrails.** Binding modules should not import
   workflow engine, durable table facades, or runtime internals except through
   sanctioned runtime capability subpaths. Runtime execution modules must not
   import host-sdk bindings.

This sequence is safer than "move all host code out of host-sdk" because it
keeps the public composition entrypoint stable while shrinking what that
entrypoint owns.

## Refactor Dispatch Guidance

The next dispatch should be a read/write boundary split, not another SDD:

- lane A: complete `tf-kddg` channel Tags/Layers and delete registry service;
- lane B: inventory `host-sdk/src/agent-tools/execution` and carve runtime
  execution service boundaries;
- lane C: move or wrap runtime-context workflow definitions under runtime-owned
  subpaths after PR #489 settles;
- lane D: add dependency-cruiser or lint rules for binding/execution imports.

Do not dispatch a "move packages/host-sdk/src/host to runtime" task. That would
mix composition helpers, channel bindings, MCP edge, and workflow substrate in
one unsafe change.

## Open Questions For Gurdas

1. Should Firegrid introduce a separate `@firegrid/host-runtime` package, or is
   `@firegrid/runtime` the intended home for all lower-tier host execution?
   This framing assumes `@firegrid/runtime` is the home.
2. Should stable channel metadata schemas live in `@firegrid/protocol` now, or
   wait until `tf-kddg` proves the Tag/Layer shape? This framing recommends
   protocol ownership once the wire shape is stable.
3. Should verified webhook fact schemas become protocol-owned before the first
   public webhook channel lands? This framing recommends yes if client/agent
   bindings need to observe them.
4. Should host-sdk continue exporting `FiregridRuntimeHostLive` as the primary
   composition helper after internals move, or should it be renamed to make the
   package's binding role clearer? This framing keeps the name for compatibility.

## Non-Goals

- No immediate package split.
- No compatibility shims for workflow handles or registries.
- No file-by-file move list.
- No changes to PR #489, `tf-kddg`, or in-flight Phase 1 lanes.
