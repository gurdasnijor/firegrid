# Proposal: Host-Owned Stream Sets And Context Authority

Status: Draft

Date: 2026-05-14

## Problem

Firegrid currently has two related sources of complexity.

First, the Durable Streams backed workflow engine does not fully satisfy the
`@effect/workflow` `WorkflowEngine.scheduleClock` contract. It persists
`clockWakeups` rows, but normal wakeup delivery still depends on an external
`fireDueWorkflowClocks` loop. Tests and host code then need a driver outside the
workflow engine, even though upstream `WorkflowEngine.layerMemory` and
`ClusterWorkflowEngine` both hide clock delivery behind `scheduleClock`.

Second, the host-owned MCP server can expose the canonical Firegrid agent tools,
but it cannot yet be safely mounted at host boot because context authority is not
durable. A `contextId` is runtime/session state, not process env. The rejected
`FIREGRID_MCP_CONTEXT_ID` shape made the problem visible: tool calls need to be
authorized against a runtime context owned by the host serving the local MCP
listener. The same question exists for prompts: a prompt append for
`contextId = X` must route to the host and ingress stream that own context `X`.

The current stream layout also makes host ownership blurry. A namespace maps to
shared streams such as:

```text
{namespace}.firegrid.runtime
{namespace}.firegrid.runtimeIngress
{namespace}.firegrid.runtimeOutput
{namespace}.firegrid.workflow
```

If two host processes use the same `DURABLE_STREAMS_BASE_URL` and
`FIREGRID_RUNTIME_NAMESPACE`, they attach to the same workflow and runtime
tables. Durable activity claims prevent some duplicate side effects, but the
operating model remains unclear: which host owns a context, which workflow
engine should recover that context's clocks, and which ingress table receives
follow-up prompts?

## Decision

Introduce **host-owned stream sets** plus a small **global host directory**.

Durable Streams remains the storage substrate. The Electric Cloud control API
manages Streams services, but it does not currently expose server-side shards,
consumer groups, leases, filtered subscriptions, or delayed delivery knobs.
Firegrid's practical partitioning control is the stream path chosen under the
Streams service base URL.

Each running host owns a stream prefix:

```text
{namespace}.firegrid.host.{hostId}
```

Host-local runtime streams derive from that prefix:

```text
{namespace}.firegrid.host.{hostId}.runtime
{namespace}.firegrid.host.{hostId}.runtimeIngress
{namespace}.firegrid.host.{hostId}.runtimeOutput
{namespace}.firegrid.host.{hostId}.workflow
{namespace}.firegrid.host.{hostId}.durableTools
```

A small global directory stream records host sessions and the existing
`RuntimeContext` rows with their host binding:

```text
{namespace}.firegrid.hostDirectory
```

## Schema-Annotated Authority

Any string that encodes authority must be serialized from the canonical row
schema that owns that authority, not constructed through ad hoc template
literals at use sites and not moved into a parallel key type.

This follows the pattern in `DurableTable.primaryKey(...)`: schema metadata
marks the field that owns identity, and the package uses the schema's encoded
form instead of re-concatenating key parts at every call site. Host stream
authority should follow the same rule. `HostSessionRow` and `RuntimeContext` are
the authority records; their schemas should carry the metadata needed to
serialize the stream prefix and route ownership.

```ts
const HostSessionRowSchema = Schema.Struct({
  hostId: HostIdSchema.pipe(
    DurableTable.primaryKey,
    hostIdentity,
  ),
  hostSessionId: Schema.String,
  status: Schema.Literal("running", "stopped"),
  startedAtMs: Schema.Number,
  heartbeatAtMs: Schema.Number,
  streamPrefix: HostStreamPrefixSchema,
})

const RuntimeContextSchema = Schema.Struct({
  contextId: ContextIdSchema.pipe(
    DurableTable.primaryKey,
    contextIdentity,
  ),
  createdAt: Schema.String,
  createdBy: Schema.optional(Schema.String),
  runtime: RuntimeContextIntentSchema,
  host: Schema.Struct({
    hostId: HostIdSchema.pipe(hostReference),
    streamPrefix: HostStreamPrefixSchema,
    status: Schema.Literal("active", "closed"),
    updatedAtMs: Schema.Number,
  }),
})
```

The exact annotation helper names are illustrative. The important point is that
callers do not construct stream URLs. They pass structured host authority to the
engine or host layer, and that layer serializes its own stream URL internally.

```ts
DurableStreamsWorkflowEngine.layer({
  durableStreamsBaseUrl: baseUrl,
  hostSession: hostSessionRow,
})
```

Inside `DurableStreamsWorkflowEngine.layer`, the implementation has everything
it needs: the Durable Streams base URL, the workflow table metadata, and the
canonical annotated host session schema. It can use `Schema.encodeSync` or a
schema-driven encoder compiled from the annotations to obtain the host stream
prefix, then derive the workflow table stream URL for `WorkflowEngineTable`. The
stream naming rule lives with the durable authority row schema and the
engine/table implementation, not in a public URL-construction helper and not in
a second key model.

It should not inline string construction in layer composition:

```ts
// Do not do this in product code.
DurableStreamsWorkflowEngine.layer({
  streamUrl: "...",
})
```

The same rule applies to context ids, host stream prefixes, MCP route
authority, durable table primary keys, and any future shard or lease authority
strings. If a separator, escaping rule, URL normalization rule, or authority
scope is encoded in a string, it belongs in the schema annotation or transform
on the durable authority record that owns that concept, with focused tests.

Conceptual rows:

```ts
interface HostSessionRow {
  readonly hostId: string
  readonly hostSessionId: string
  readonly status: "running" | "stopped"
  readonly startedAtMs: number
  readonly heartbeatAtMs: number
  readonly streamPrefix: string
}

interface RuntimeContext {
  readonly contextId: string
  readonly createdAt: string
  readonly createdBy?: string
  readonly runtime: RuntimeContextIntent
  readonly host: {
    readonly hostId: string
    readonly streamPrefix: string
    readonly status: "active" | "closed"
    readonly updatedAtMs: number
  }
}
```

`RuntimeContext` remains the authority for context routing. The host-owned
stream set is the authority for runtime execution state.

## Why This Shape

This keeps the Durable Streams workflow engine simple. A workflow engine
instance is configured with one host-owned workflow stream:

```ts
DurableStreamsWorkflowEngine.layer({
  durableStreamsBaseUrl: baseUrl,
  hostSession: hostSessionRow,
})
```

Every workflow row in that stream belongs to that host by construction. The
engine does not need `ownerHostId` filtering on every query, and it does not see
clocks for other hosts.

That lets the engine implement `scheduleClock` in the same spirit as upstream:

1. `DurableClock.sleep` calls `WorkflowEngine.scheduleClock`.
2. The Durable Streams engine inserts a durable clock wakeup row in its own
   workflow stream.
3. The engine schedules scoped local delivery for that row.
4. On engine startup, it reconciles pending wakeup rows from its own stream.
5. Delivery completes the durable deferred via `engine.deferredDone(...)`.

No host-level clock driver is required. The external `fireDueWorkflowClocks`
helper is removed from the normal runtime and test path.

The same host-owned topology makes MCP context authority obvious. The MCP server
is mounted by one host process. For a route such as:

```text
/mcp/runtime-context/:contextId
```

the server checks the `RuntimeContext` host binding:

```text
RuntimeContext(contextId).host.hostId === thisHostId
```

Only then does it install `FiregridAgentToolContext` for the request and invoke
`FiregridAgentToolkit`. Tool calls cannot smuggle a `contextId` in tool
arguments, and the host does not read context identity from env.

## Prompt Routing

Prompt routing uses the same runtime context authority.

For a client or workflow-authored prompt, the runtime-host prompt surface
accepts `contextId` and the prompt payload. It resolves that context through
`HostContextAuthority.resolveContext`, obtains the host-bound `RuntimeContext`,
and uses its host binding to select the host-owned ingress table internally. The caller
does not open `{streamPrefix}.runtimeIngress` or construct any stream URL.

The provider adapter for the owning host consumes sequenced ingress rows from
that same host-owned ingress stream and delivers them to the process/session.

This keeps `firegrid-agent-ingress.HOST.1` true: runtime host owns ingress
topology and exposes the package/runtime prompt append surface. It also makes
`firegrid-agent-ingress.HOST.7` more precise: stream selection is still derived
from Durable Streams base URL plus namespace, but the `RuntimeContext.host`
binding chooses the host stream prefix.

For `schedule_me`, the scheduled workflow sleeps inside the host-owned workflow
stream, then calls `AgentToolHost.appendScheduledPrompt`. The live host
implementation consumes or resolves the same host-bound `RuntimeContext` through
`HostContextAuthority`. There is no private workflow prompt path.

## MCP Tool Routing

MCP calls are host-local and context-scoped.

The listener is still configured only by listener topology:

```text
FIREGRID_MCP_ENABLED=false
FIREGRID_MCP_HOST=127.0.0.1
FIREGRID_MCP_PORT=0
FIREGRID_MCP_PATH=/mcp
```

Runtime identity is not listener config.

The request path or session state selects a context:

```text
/mcp/runtime-context/:contextId
```

The MCP layer calls `HostContextAuthority.requireLocalContext(contextId)`. That
single operation resolves the `RuntimeContext` and rejects contexts whose host
binding does not name the current host. The accepted `RuntimeContext` is then
used to provide `FiregridAgentToolContext` and host services before invoking the Effect AI
toolkit handler. Tool arms that append input, spawn children, execute sandbox
tools, or wait on durable sources use services derived from that runtime context.

This is the durable host/session record shape that
`SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md` left as the blocker for host boot
auto-mounting.

## Launch And Host Binding

Normalize host/context routing behind one host authority service. Callers should
not repeat "resolve context, derive stream, open table" logic.

Conceptual service shape:

```ts
interface HostContextAuthority {
  readonly currentHost: Effect.Effect<HostSessionRow>
  readonly bindLocalContext: (
    context: RuntimeContext,
  ) => Effect.Effect<RuntimeContext>
  readonly resolveContext: (
    contextId: string,
  ) => Effect.Effect<RuntimeContext>
  readonly requireLocalContext: (
    contextId: string,
  ) => Effect.Effect<RuntimeContext>
}
```

The normalized runtime authority object is just `RuntimeContext`. There is no
separate placement row. The host-owned stream prefix is part of the durable
runtime context's host binding, and runtime-host layers use that binding to
construct or select host-owned table layers internally.

The public flows become:

- Host boot: acquire `HostContextAuthority`, which creates or loads the
  `HostSessionRow`, heartbeats it for the host scope, and builds host-owned
  runtime, ingress, output, durable-tools, workflow, and optional MCP layers.
- Context launch: call `bindLocalContext(context)`, then `startRuntime` with
  the returned host-bound `RuntimeContext`.
- Follow-up prompt: call `resolveContext(contextId)`, then append through the
  runtime-host prompt surface. The prompt surface chooses the context's ingress
  table internally.
- MCP tool call: call `requireLocalContext(contextId)`, then provide
  `FiregridAgentToolContext` and host services derived from the resulting
  runtime context.

That is the cleaner normalization: a `contextId` resolves once to the durable
`RuntimeContext`, and downstream operations consume that object instead of
reconstructing stream authority themselves.

## Operating Model

The common local case becomes easy to inspect:

```text
firegrid-smoke-local.firegrid.host.host_abc.runtime
firegrid-smoke-local.firegrid.host.host_abc.runtimeIngress
firegrid-smoke-local.firegrid.host.host_abc.runtimeOutput
firegrid-smoke-local.firegrid.host.host_abc.workflow
firegrid-smoke-local.firegrid.host.host_abc.durableTools
firegrid-smoke-local.firegrid.hostDirectory
```

One host process owns one stream set. Its workflow engine only recovers its own
workflow rows and clocks. Its provider adapters only consume its own ingress
rows. Its MCP listener only serves contexts bound to that host.

Multiple hosts in one namespace no longer contend on one global workflow stream.
They publish separate stream sets and share only the small directory stream.

## Comparison With Alternatives

### Single Global Stream With `ownerHostId`

This is the smallest schema change, but each host still attaches to the same
large workflow/runtime streams. Filtering by `ownerHostId` improves correctness
but does not give a clean operating model or reduce preload/materialization
cost.

### Context-Owned Streams

This gives the clearest isolation:

```text
{namespace}.firegrid.context.{contextId}.workflow
```

It also creates many streams, dynamic layer acquisition per context, harder
cleanup, and noisier discovery. It is a better fit for long-lived tenant-style
contexts than for local host sessions.

### Fixed Shard Streams

This is closer to `@effect/cluster`:

```text
{namespace}.firegrid.workflow.00
{namespace}.firegrid.workflow.01
```

It needs shard leases, runner membership, rebalance, and ownership transfer
before the first implementation can safely launch MCP and prompt routing. It is
a strong later model for fleet scale, but it is heavier than host-local agents
need now.

### Full Cluster

`@effect/cluster` already has runner identity, shard acquisition, message
storage, delayed delivery, and entity routing. Firegrid should continue learning
from it, especially for future ownership transfer. The immediate goal is not to
rebuild cluster; it is to stop making runtime-host and agent-tools compensate for
missing host/context authority.

## Failure And Recovery

The first host-owned stream implementation does not provide automatic context
failover. If a host dies, its stream set remains durable, but another host does
not claim it automatically.

That is an explicit tradeoff. It keeps the first operating model simple:

- one host owns its contexts;
- that host owns the streams for those contexts;
- workflow clocks recover when that host restarts and rebuilds its workflow
  engine;
- MCP and prompt routing are rejected if the runtime context is not bound to the
  local host.

Later work can add host replacement by extending the `RuntimeContext.host`
binding with lease epochs:

```ts
interface RuntimeContextHostBinding {
  readonly hostId: string
  readonly streamPrefix: string
  readonly hostEpoch: number
  readonly leaseExpiresAtMs: number
}
```

At that point, a replacement host can atomically rebind the runtime context to a
new host-owned stream set or adopt the old stream prefix under a fenced epoch. That
should be specified separately with ownership-transfer ACIDs before
implementation.

## Completed Work

### Workflow Engine Clock Contract

The external clock driver smell has been removed. The Durable Streams workflow
engine now satisfies `workflow-engine-durable-state.VALIDATION.3` directly:
`scheduleClock` persists wakeup rows, schedules delivery in the engine layer
scope, and reconstructed engines reconcile pending wakeups on startup.

Completed changes:

- `packages/runtime/src/workflow-engine/internal/engine-runtime.ts` owns
  wakeup delivery through `WorkflowEngine.scheduleClock`.
- `packages/runtime/src/workflow-engine/internal/clock.ts` and
  `packages/runtime/src/test-helpers/durable-clock.ts` were removed.
- `fireDueWorkflowClocks` is no longer exported from `@firegrid/runtime`.
- agent-tools, durable-tools, and MCP tests no longer fork a test clock driver.
- `workflow-engine-durable-state.VALIDATION.3` now requires reconstructed
  engine wakeup delivery without a host/test clock driver.

## Remaining Implementation Slices

### Slice 2: RuntimeContext Host Binding

Add host binding to the existing runtime context authority. Derive host-owned
stream URLs from annotated `HostSessionRow` / `RuntimeContext` schemas and
table-owned metadata over base URL and durable context rows; do not construct
stream URLs or authority strings with inline template literals at layer call
sites, and do not introduce public topology helpers or parallel key models that
duplicate the row schema.

Expected changes:

- protocol table/schema changes for host session rows and `RuntimeContext.host`;
- runtime-host topology helper backed by Effect Schema annotations/transforms
  and DurableTable metadata, hidden behind host/workflow layer constructors;
- tests proving stream derivation and runtime-context host binding lookup.

Spec follow-up:

- Add explicit runtime-context host binding requirements to
  `firegrid-workflow-driven-runtime`.
- Clarify `firegrid-agent-ingress.HOST.7` for context-derived ingress stream
  selection.

### Slice 3: Prompt Routing Through RuntimeContext

Route prompt append by resolving `RuntimeContext.host` before opening the ingress
table.

Expected changes:

- runtime-host append surface uses host-bound `RuntimeContext`;
- client prompt append/open helpers resolve `RuntimeContext`;
- tests prove prompt for context `A` lands in host `A` ingress stream.

Spec follow-up:

- Extend `firegrid-agent-ingress.HOST.*` with durable `RuntimeContext.host` as the
  prompt routing authority.

### Slice 4: MCP Host Auto-Mount

Mount the existing `FiregridMcpServerLayer` inside host boot only after the host
can validate `RuntimeContext.host`.

Expected changes:

- route or session context injection for `/mcp/runtime-context/:contextId`;
- local host binding check before `FiregridAgentToolContext` is provided;
- MCP smoke proving tool calls for a locally bound context succeed and a
  foreign context is rejected.

Spec follow-up:

- Replace the deferred language in
  `firegrid-workflow-driven-runtime.PHASE_7_MCP_HOST_SERVER.9` with the
  `RuntimeContext.host`-backed auto-mount acceptance criteria.

## Non-Goals

- No `FIREGRID_MCP_CONTEXT_ID`.
- No `FIREGRID_MCP_AGENT_TOOLS_STREAM_URL`.
- No custom MCP JSON-RPC handlers.
- No Durable Streams control-plane dependency for sharding.
- No server-side Durable Streams partition feature assumed.
- No full cluster-style shard lease implementation in the first host-owned
  stream pass.
- No automatic host failover until ownership transfer is specified.

## Resolved Questions

1. `hostId` is stable for a host installation, while `hostSessionId` is per
   boot. Durable context authority binds to `hostId`; liveness and heartbeat
   evidence bind to `hostSessionId`.
2. A restarted host adopts its previous stream prefix by default when it has the
   same stable `hostId` and no ownership-transfer epoch says otherwise.
3. Globally discoverable `RuntimeContext` rows remain the context index.
   Host-owned streams carry operational state for the bound host; the host
   directory is for host sessions/liveness, not a second context placement
   table.
4. The MCP listener URL is logged and may be exposed to host-launched local
   agents through process-local configuration. It is not durable context
   authority and is not stored in the host directory for V1.
5. Stopped host sessions and host-owned streams are retained by default.
   Cleanup is an explicit dev/smoke maintenance operation until retention and
   ownership-transfer semantics are specified.
