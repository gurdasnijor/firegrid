# Proposal: Host-Owned Stream Sets And Context Authority

Status: Draft

Date: 2026-05-14

## Problem

Firegrid currently has two related sources of complexity.

Workflow clock delivery and MCP context authority both point at the same missing
concept: durable host ownership of runtime state.

First, the Durable Streams backed workflow engine previously did not fully
satisfy the `@effect/workflow` `WorkflowEngine.scheduleClock` contract. It
persisted `clockWakeups` rows, but normal wakeup delivery depended on an
external `fireDueWorkflowClocks` loop. Tests and host code then needed a driver
outside the workflow engine, even though upstream `WorkflowEngine.layerMemory`
and `ClusterWorkflowEngine` both hide clock delivery behind `scheduleClock`.
The completed-work section below records the fix that moved clock delivery back
inside the engine.

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

Introduce **host-owned stream sets** plus a host binding on the existing
`RuntimeContext` authority row.

Durable Streams remains the storage substrate. The Electric Cloud control API
manages Streams services, but it does not currently expose server-side shards,
consumer groups, leases, filtered subscriptions, or delayed delivery knobs.
Firegrid's practical partitioning control is the stream path chosen under the
Streams service base URL.

Each running host owns a stream prefix:

```text
{namespace}.firegrid.host.{hostId}
```

Host-local operational streams derive from that prefix:

```text
{namespace}.firegrid.host.{hostId}.runtimeIngress
{namespace}.firegrid.host.{hostId}.runtimeOutput
{namespace}.firegrid.host.{hostId}.workflow
{namespace}.firegrid.host.{hostId}.durableTools
```

The existing global `RuntimeControlPlaneTable.contexts` collection remains the
context index:

```text
{namespace}.firegrid.runtime
```

That row owns context authority by carrying the host binding for each context.
The host-owned streams carry operational state for the bound host.

No durable host directory is required for the happy path. The runtime process
has its current host session as scoped host identity, and `RuntimeContext.host`
is the routing authority. Operators can inspect streams with the existing
Durable Streams CLI and Electric Cloud dashboard while V1 proves the core
routing path.

## Schema-Annotated Authority

Any string that encodes authority must be serialized from the canonical row
schema that owns that authority, not constructed through ad hoc template
literals at use sites and not moved into a parallel key type.

This follows the pattern in `DurableTable.primaryKey(...)`: schema metadata
marks the field that owns identity, and the package uses the schema's encoded
form instead of re-concatenating key parts at every call site. Host stream
authority should follow the same rule.

`HostSessionRow` owns host-scope identity and stream-prefix identity.
`RuntimeContext` owns context routing by storing the host binding copied from the
owning host session at context creation time. Both schemas carry enough
metadata to encode their authority strings.

```ts
const HostSessionRowSchema = Schema.Struct({
  hostId: HostIdSchema.pipe(
    DurableTable.primaryKey,
    hostIdentity, // illustrative annotation
  ),
  hostSessionId: Schema.String,
  status: Schema.Literal("running", "stopped"),
  startedAtMs: Schema.Number,
  streamPrefix: HostStreamPrefixSchema.pipe(streamAuthority),
})

const RuntimeContextSchema = Schema.Struct({
  contextId: ContextIdSchema.pipe(
    DurableTable.primaryKey,
    contextIdentity, // illustrative annotation
  ),
  createdAt: Schema.String,
  createdBy: Schema.optional(Schema.String),
  runtime: RuntimeContextIntentSchema,
  host: Schema.Struct({
    hostId: HostIdSchema.pipe(hostReference),
    streamPrefix: HostStreamPrefixSchema.pipe(streamAuthority),
    boundAtMs: Schema.Number,
  }),
})
```

The annotation helper names above are placeholders. The concrete Slice 2 API
should live beside the schema-driven encoder work, likely near
`DurableTable.primaryKey(...)` and the runtime table declarations, not in
callers.

### Annotation Contract

The concrete mechanism should have this shape:

1. The field schema that encodes authority is a `Schema.transform` whose encoded
   side is `Schema.String`, just like `DurableTable.primaryKey(...)`.
2. A `Schema.annotations({ ... })` marker identifies the field as a stream
   authority field for AST discovery and test assertions.
3. Internal runtime-host and table constructors call `Schema.encodeSync` on that
   field schema, or on a small compiled encoder discovered from the annotation.
4. The derived stream URL is a local value inside the layer/table constructor. It
   is not a computed property on decoded rows, not a public
   `RuntimeAuthority.streamUrlFor(...)` helper, and not a second key model.

The consumer call site stays structured and Effect-scoped. Callers provide
identity once through `CurrentHostSession` or `CurrentRuntimeContext`; they do
not pass host or context authority into table constructors directly:

```ts
const hostLayers = Layer.mergeAll(
  CurrentHostSessionLive,
  DurableStreamsWorkflowEngine.layerForHost,
)

yield* appendRuntimeIngress(request).pipe(
  provideRuntimeContext(runtimeContext),
)
```

Host-scoped constructors, such as the workflow engine, read
`CurrentHostSession` and use the annotated `HostSessionRow.streamPrefix` to
select their backing stream internally. Context-routed operations, such as
prompt append, read `CurrentRuntimeContext` at method time or inside a fresh
localized layer and use `RuntimeContext.host.streamPrefix` internally. The caller
never receives or constructs the stream URL.

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
    readonly boundAtMs: number
  }
}
```

`RuntimeContext.host.streamPrefix` intentionally duplicates
`HostSessionRow.streamPrefix`. That denormalization makes a context row
self-sufficient for prompt routing and MCP local-context checks without joining
through a separate directory on every operation. Consistency is enforced when
`insertLocalRuntimeContext` copies the current host session's stream prefix into
the runtime context row. The context row remains the routing authority.

## Why This Shape

This keeps the Durable Streams workflow engine simple. A workflow engine
instance is host-scoped: it reads `CurrentHostSession` when the host layer is
acquired and derives exactly one host-owned workflow stream internally.

```ts
const hostLayers = Layer.mergeAll(
  CurrentHostSessionLive,
  DurableStreamsWorkflowEngine.layerForHost,
)
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

The Fireline prior art points in the same direction but with a heavier
dispatcher/claim model: durable host identity and liveness are useful, while
claims and fences should only appear when ownership transfer or multi-host
execution fencing is actually in scope. This proposal keeps V1 to the smaller
authority record set: `HostSessionRow` for host-scope identity and
`RuntimeContext.host` for routing.

## Effect-Scoped Identity

Use Effect context tags to avoid manually threading host-bound `RuntimeContext`
through every call site.

V1 should define two required tags with no default value:

```ts
export class CurrentHostSession extends Context.Tag(
  "@firegrid/runtime/CurrentHostSession",
)<CurrentHostSession, HostSessionRow>() {}

export class CurrentRuntimeContext extends Context.Tag(
  "@firegrid/runtime/CurrentRuntimeContext",
)<CurrentRuntimeContext, RuntimeContext>() {}
```

`CurrentHostSession` is host-scope identity. Host-owned long-lived layers such
as `DurableStreamsWorkflowEngine.layerForHost` and durable-tools read it when
they are acquired by the host scope.

`CurrentRuntimeContext` is request/workflow fiber-scope identity. MCP request
handling, prompt append, and runtime execution resolve a `RuntimeContext` once,
then provide it for the rest of the fiber:

```ts
yield* program.pipe(
  Effect.provideService(CurrentRuntimeContext, runtimeContext),
)
```

Using `Context.Tag` keeps missing host/context authority in the Effect
environment type. Code that needs a host or runtime context should not compile
unless it is run inside a scope that provides the corresponding tag.

Services that route by context must either read `CurrentRuntimeContext` inside
each method call, or build a fresh per-context layer inside the localized scope.
They must not capture a `RuntimeContext` in a shared layer that is memoized
across contexts.

This preserves the schema-annotated authority rule. Effect context answers
"which host/context is current for this fiber"; the schema encoder answers
"which Durable Streams path does that authority row encode to".

## Prompt Routing

Prompt routing uses the same runtime context authority.

For a client or workflow-authored prompt, the runtime-host prompt surface
accepts `contextId` and the prompt payload. It resolves that context through
`findRuntimeContext`, provides `CurrentRuntimeContext`, and uses that context's
host binding to select the host-owned ingress table internally. The caller does
not open `{streamPrefix}.runtimeIngress` or construct any stream URL.

Prompt append is durable routing, not local process execution. A host may append
a prompt for a context bound to another host by writing to the owning context's
host-owned ingress stream. The owning host consumes that ingress when it is
running or after it restarts. This is deliberately different from MCP tool
execution, which remains host-local because tools may touch local process and
sandbox services.

The provider adapter for the owning host consumes sequenced ingress rows from
that same host-owned ingress stream and delivers them to the process/session.
Cross-host prompt append is a normal Durable Streams write to the owner host's
ingress stream. Its latency is the owner host's existing live-tail/polling
latency; V1 does not add a private low-latency host mesh for prompts.

This keeps `firegrid-agent-ingress.HOST.1` true: runtime host owns ingress
topology and exposes the package/runtime prompt append surface. It also makes
`firegrid-agent-ingress.HOST.7` more precise: stream selection is still derived
from Durable Streams base URL plus namespace, but the `RuntimeContext.host`
binding chooses the host stream prefix.

For `schedule_me`, the scheduled workflow sleeps inside the host-owned workflow
stream, then calls `AgentToolHost.appendScheduledPrompt`. The live host
implementation consumes or resolves the same host-bound `RuntimeContext` through
`findRuntimeContext` and `CurrentRuntimeContext`. There is no private workflow
prompt path.

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

V1 should use the path-scoped shape: one MCP URL per runtime context. A client
connects to `/mcp/runtime-context/:contextId`; the toolkit catalog remains the
canonical six Firegrid tools, and the route binds `FiregridAgentToolContext` for
execution. `contextId` is not a tool argument and is not selected through env or
handshake metadata.

Tool catalog publication is identical across all `:contextId` paths. The path
scopes execution authority, not the tool surface.

The MCP layer calls the `requireLocalContext(contextId)` operator. That
operator resolves the `RuntimeContext` and rejects contexts whose host binding
does not name `CurrentHostSession`. The accepted `RuntimeContext` is then used
to provide `CurrentRuntimeContext`, `FiregridAgentToolContext`, and host services
before invoking the Effect AI toolkit handler. Tool arms that append input,
spawn children, execute sandbox tools, or wait on durable sources use services
derived from that runtime context.

Context authority failures at this boundary map to MCP JSON-RPC
`InvalidParams` (`-32602`) where Effect AI can return a JSON-RPC error. The
implementation must not add custom `tools/list` or `tools/call` handlers to
paper over library semantics.

This is the durable host/session record shape that
`SDD_FIREGRID_AGENT_TOOLS_MCP_BRIDGE.md` left as the blocker for host boot
auto-mounting.

## Launch And Host Binding

Normalize host/context routing behind small Effect-native primitives. Callers
should not repeat "resolve context, derive stream, open table" logic, and
identity lookup should not be hidden behind methods that look like durable I/O.

Conceptual primitive shape:

```ts
export class ContextNotFound extends Schema.TaggedError<ContextNotFound>()(
  "ContextNotFound",
  { contextId: ContextIdSchema },
) {}

export class ContextNotLocal extends Schema.TaggedError<ContextNotLocal>()(
  "ContextNotLocal",
  {
    contextId: ContextIdSchema,
    hostId: HostIdSchema,
    currentHostId: HostIdSchema,
  },
) {}

export class CurrentHostStopped extends Schema.TaggedError<CurrentHostStopped>()(
  "CurrentHostStopped",
  { hostId: HostIdSchema },
) {}

export const findRuntimeContext = (
  contextId: ContextId,
): Effect.Effect<
  RuntimeContext,
  ContextNotFound | DurableTableError,
  RuntimeControlPlaneTable
> =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const maybeContext = yield* table.contexts.get(contextId)
    return yield* Option.match(maybeContext, {
      onNone: () => Effect.fail(new ContextNotFound({ contextId })),
      onSome: Effect.succeed,
    })
  })

export const insertLocalRuntimeContext = (
  intent: RuntimeContextIntent,
): Effect.Effect<
  RuntimeContext,
  CurrentHostStopped | DurableTableError,
  RuntimeControlPlaneTable | CurrentHostSession | Clock
> =>
  Effect.gen(function* () {
    const table = yield* RuntimeControlPlaneTable
    const host = yield* CurrentHostSession
    if (host.status !== "running") {
      return yield* Effect.fail(new CurrentHostStopped({ hostId: host.hostId }))
    }
    const boundAtMs = yield* Clock.currentTimeMillis
    const context = makeRuntimeContext({
      intent,
      host,
      boundAtMs,
    })
    yield* table.contexts.insert(context)
    return context
  })

export const requireLocalContext = (
  contextId: ContextId,
): Effect.Effect<
  RuntimeContext,
  ContextNotFound | ContextNotLocal,
  RuntimeControlPlaneTable | CurrentHostSession
> =>
  Effect.gen(function* () {
    const currentHost = yield* CurrentHostSession
    const context = yield* findRuntimeContext(contextId)
    if (context.host.hostId !== currentHost.hostId) {
      return yield* Effect.fail(
        new ContextNotLocal({
          contextId,
          hostId: context.host.hostId,
          currentHostId: currentHost.hostId,
        }),
      )
    }
    return context
  })

export const provideRuntimeContext =
  (runtimeContext: RuntimeContext) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(CurrentRuntimeContext, runtimeContext))
```

`CurrentHostSession` and `CurrentRuntimeContext` are the identity primitives.
`RuntimeControlPlaneTable` remains the durable table service. `findRuntimeContext`
and `insertLocalRuntimeContext` are thin domain operators over that table, not a
new repository layer. They are worth naming because they centralize host binding,
not because they hide the DurableTable API. `requireLocalContext` is another
composable operator over the same table plus `CurrentHostSession`, not a method
on a monolithic authority service. The context authority errors are
`Schema.TaggedError` classes so call sites construct canonical tagged errors
with `new ContextNotLocal(...)` instead of hand-writing payload objects.
`insertLocalRuntimeContext` requires `Clock` only to stamp `boundAtMs`; this is a
standard Effect test-time dependency, not a Firegrid authority service.

The host-context-authority module may re-export these primitives from one place,
but it should not wrap them in a single service with `currentHost`,
`createLocalContext`, `resolveContext`, and `requireLocalContext` methods, and
it should not add a mostly-pass-through repository service over
`RuntimeControlPlaneTable`.

The public flows become:

- Host boot: create or load the stable host identity, construct a
  `HostSessionRow` for the host scope, provide `CurrentHostSession`, and build
  host-owned ingress, output, durable-tools, workflow, and optional MCP layers.
- Context launch: call `insertLocalRuntimeContext(intent)`. It constructs and
  inserts the `RuntimeContext` row with the current host binding already filled
  in, then provides `CurrentRuntimeContext` while `startRuntime` consumes the
  returned host-bound `RuntimeContext`. V1 should not create an intermediate
  unbound context row.
- Follow-up prompt: call `findRuntimeContext(contextId)`, then append through
  the runtime-host prompt surface inside `CurrentRuntimeContext`.
  The prompt surface chooses the context's ingress table internally.
- MCP tool call: call `requireLocalContext(contextId)`, then provide
  `CurrentRuntimeContext`, `FiregridAgentToolContext`, and host services derived
  from the resulting runtime context.

That is the cleaner normalization: a `contextId` resolves once to the durable
`RuntimeContext`, and downstream operations consume that object instead of
reconstructing stream authority themselves.

`findRuntimeContext` fails for missing contexts. It does not require the context
to be local, so prompt append can route through durable Streams to the owner
host's ingress. `requireLocalContext` performs the additional local-host
equality check used by MCP and local sandbox/tool execution. Stale-host
detection and host liveness views are deferred; they are not automatic rebind
authority.

## Operating Model

The common local case becomes easy to inspect:

```text
firegrid-smoke-local.firegrid.host.host_abc.runtimeIngress
firegrid-smoke-local.firegrid.host.host_abc.runtimeOutput
firegrid-smoke-local.firegrid.host.host_abc.workflow
firegrid-smoke-local.firegrid.host.host_abc.durableTools
firegrid-smoke-local.firegrid.runtime
```

One host process owns one stream set. Its workflow engine only recovers its own
workflow rows and clocks. Its provider adapters only consume its own ingress
rows. Its MCP listener only serves contexts bound to that host.

Multiple hosts in one namespace no longer contend on one global workflow stream.
They publish separate operational stream sets and share the existing global
runtime context index.

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
- MCP tool calls are rejected if the runtime context is not bound to the local
  host;
- prompt append can still write durable ingress for the owner host, even if the
  owner is temporarily offline.

Scheduled futures inherit the owner host's availability. If `schedule_me` sleeps
for 24 hours in `host_A`'s workflow stream and `host_A` dies, that scheduled
prompt fires when `host_A` restarts and its workflow engine reconciles pending
clocks. It does not automatically move to `host_B` in V1.

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

Slice 2 is load-bearing and should be implemented transactionally by one
engineer. Schema/encoder mechanics and host-aware scoped layers are one
behavioral unit: landing only schemas without the layers, or layers without the
schema-backed authority encoder, leaves the architecture half-switched.

Slice 3 depends on Slice 2 because prompt append must resolve
`RuntimeContext.host` before selecting ingress. Slice 4 depends on Slice 2 and
the Slice 3 prompt path because MCP tools such as `schedule_me` and future
prompt-authoring tools use the same host authority surface.

### Slice 2: RuntimeContext Host Authority

Add host binding to the existing runtime context authority. Derive host-owned
stream URLs from annotated `HostSessionRow` / `RuntimeContext` schemas and
table-owned metadata over base URL and durable context rows; do not construct
stream URLs or authority strings with inline template literals at layer call
sites, and do not introduce public topology helpers or parallel key models that
duplicate the row schema.

Expected changes:

- protocol table/schema changes for host session rows and `RuntimeContext.host`;
- host stream authority annotation/transform helpers;
- runtime-host topology backed by Effect Schema annotations/transforms and
  DurableTable metadata, hidden behind host/workflow layer constructors;
- `CurrentHostSession` and `CurrentRuntimeContext` tags that keep layer
  composition declarative while deriving backing streams from host/context
  authority;
- `findRuntimeContext`, `insertLocalRuntimeContext`, `requireLocalContext`, and
  `provideRuntimeContext` operators instead of a monolithic
  `HostContextAuthority` service or a pass-through repository wrapper;
- host-owned layers read `CurrentHostSession` or `CurrentRuntimeContext`
  instead of accepting ad hoc stream URLs;
- tests proving stream derivation and runtime-context host binding lookup;
- tests prove shared layers do not capture the wrong runtime context across
  parallel fibers;
- two-host smoke proving each host writes workflow rows and clocks only to its
  own host-owned workflow stream.

Expected outcomes:

- `firegrid:host` can create host-bound `RuntimeContext` rows without adding a
  placement table or env-based context identity.
- Two host processes can share one namespace while their workflow clocks and
  workflow rows remain isolated by host-owned stream prefix.
- Runtime and workflow code can obtain current host/context authority through
  Effect context instead of passing stream URLs or `RuntimeContext` parameters
  through every layer constructor.
- Reviewers can grep for inline authority-bearing stream URL construction and
  reject it as drift from the schema encoder path.

Spec follow-up:

- `firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1`
- `firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2`
- `firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3`
- `firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.4`
- `firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1`
- `firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2`
- `firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3`
- `firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1`
- `firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.2`
- `firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.3`
- `firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1`
- `firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2`
- `firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.3`
- `firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.4`
- `firegrid-host-context-authority.HAPPY_PATH_SCOPE.1`
- `firegrid-host-context-authority.HAPPY_PATH_SCOPE.2`
- `firegrid-host-context-authority.VALIDATION.1`
- `firegrid-host-context-authority.VALIDATION.3`

### Slice 3: Prompt Routing Through RuntimeContext

Route prompt append by resolving `RuntimeContext.host` before opening the ingress
table.

Expected changes:

- runtime-host append surface uses host-bound `RuntimeContext`;
- client prompt append/open helpers resolve `RuntimeContext`;
- tests prove prompt for context `A` lands in host `A` ingress stream;
- tests prove a prompt submitted through host `B` for a context bound to
  host `A` writes host `A` ingress, while local execution still stays with
  host `A`.

Expected outcomes:

- Follow-up prompts target the correct runtime context by `contextId` without
  the caller knowing the owner host's stream URLs.
- A host can durably enqueue input for a context owned by another host, while
  provider delivery still happens only from the owning host's ingress stream.
- `schedule_me` delayed prompts use the same prompt append path as client
  prompts, so workflow-authored input does not create a private delivery plane.

Spec follow-up:

- `firegrid-host-context-authority.PROMPT_ROUTING.1`
- `firegrid-host-context-authority.PROMPT_ROUTING.2`
- `firegrid-host-context-authority.PROMPT_ROUTING.3`
- `firegrid-host-context-authority.VALIDATION.2`

### Slice 4: MCP Host Auto-Mount

Mount the existing `FiregridMcpServerLayer` inside host boot only after the host
can validate `RuntimeContext.host`.

Expected changes:

- route or session context injection for `/mcp/runtime-context/:contextId`;
- local host binding check before `FiregridAgentToolContext` is provided;
- tool catalog remains identical across context paths while execution authority
  is scoped by the path;
- MCP smoke proving tool calls for a locally bound context succeed and a
  foreign context is rejected with the documented context authority error
  mapping.

Expected outcomes:

- The host can mount the localhost MCP server as part of the normal host scope
  once context authority exists; no manual `contextId` Layer option or
  `FIREGRID_MCP_CONTEXT_ID` env workaround is needed.
- Host-local agents connect to a context-scoped MCP URL and see the same
  canonical six-tool catalog, with execution bound by the URL path.
- Tool calls for contexts owned by other hosts fail before local sandbox,
  provider, or workflow host services are exposed.

Spec follow-up:

- `firegrid-host-context-authority.MCP_CONTEXT_ROUTING.1`
- `firegrid-host-context-authority.MCP_CONTEXT_ROUTING.2`
- `firegrid-host-context-authority.MCP_CONTEXT_ROUTING.3`
- `firegrid-host-context-authority.MCP_CONTEXT_ROUTING.4`
- `firegrid-host-context-authority.VALIDATION.4`

## Non-Goals

- No `FIREGRID_MCP_CONTEXT_ID`.
- No `FIREGRID_MCP_AGENT_TOOLS_STREAM_URL`.
- No custom MCP JSON-RPC handlers.
- No Durable Streams control-plane dependency for sharding.
- No server-side Durable Streams partition feature assumed.
- No full cluster-style shard lease implementation in the first host-owned
  stream pass.
- No automatic host failover until ownership transfer is specified.
- No separate context placement table.
- No Firegrid-specific host/context operator CLI in V1. Use existing Durable
  Streams CLI and Electric Cloud dashboard inspection while the happy path
  lands.
- No `forceBindLocalContext` or rebind operation in V1.
- No `RuntimeContext.host.status` field in V1; terminal or cancelled context
  state remains existing runtime/run evidence until a transfer lifecycle is
  specified.

## Resolved Questions

1. `hostId` is stable for a host installation, while `hostSessionId` is per
   boot. Durable context authority binds to `hostId`; any later host-session
   liveness evidence can bind to `hostSessionId` without changing context
   routing.
2. A restarted host adopts its previous stream prefix by default when it has the
   same stable `hostId` and no ownership-transfer epoch says otherwise.
   V1 persists that stable `hostId` outside Durable Streams, either in a local
   host file such as `$HOME/.firegrid/host-id` or through a platform-provided
   stable env/config value. A fresh host id creates a fresh host-owned stream
   set; it does not adopt old scheduled work.
3. Globally discoverable `RuntimeContext` rows remain the context index.
   Host-owned streams carry operational state for the bound host. There is no
   second context placement table.
4. The MCP listener URL is logged and may be exposed to host-launched local
   agents through process-local configuration. It is not durable context
   authority.
5. Stopped host sessions and host-owned streams are retained by default.
   Cleanup uses existing Durable Streams CLI/dashboard tooling until retention
   and ownership-transfer semantics are specified.
6. Prompt append and MCP tool execution intentionally differ. Prompt append is a
   durable write that can route across hosts through `RuntimeContext.host`;
   MCP tool execution is host-local and rejects contexts not bound to the
   listener's host.
7. `RuntimeContext.host.streamPrefix` duplicates `HostSessionRow.streamPrefix`
   intentionally so context routing does not require a second lookup. The
   bind/create path copies the current host session value and tests enforce
   consistency.
