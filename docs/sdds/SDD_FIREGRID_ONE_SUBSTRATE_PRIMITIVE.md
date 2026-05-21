# SDD: Firegrid — One Substrate Primitive

Status: load-bearing architecture
Created: 2026-05-20
Last amended: 2026-05-20 (peer review wave 1: channels reframed as typed
transport not as universal public API; protocol ownership tightened to
shared schemas only; autoApprove framing corrected to scoped policy
install over durable response binding; client methods stay public as
ergonomic projections; subscribe verb scoped to projection-specific APIs
not agent verbs.
Peer review wave 2 — Gary's follow-up: DONE-shaped bullet wording
re-tightened to "shared/public schemas"; three-layer chain qualified to
"every operation that touches persisted state" so synchronous handle
factories are correctly excluded.
Peer review wave 3 — tf-6w3s external-effect adapter inventory: adapter set
confirmed finite, but package-boundary wording corrected. Durable transport
libraries are substrate exceptions; host/CLI projection shims with byte,
server, or dev-server effects are explicit follow-up work, not proof of a
runtime-only boundary.)
Owner: Firegrid Architecture
Supersedes/strengthens: `SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md`
Extends: `SDD_FIREGRID_AGENT_BODY_PLAN.md`, `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
Cross-cuts: `docs/cannon/architecture/host-sdk-runtime-boundary.md`

## Thesis

**Firegrid has one persisted-state substrate primitive: `DurableTable`.**

Every persistent thing in Firegrid is a typed row in some DurableTable
collection. Workflows, channels, control plane, session plane, observations,
snapshots, agent-event-pipeline outputs, verified webhook facts, control
request rows, completion rows — all of them.

A small, fixed set of external-effect adapters (sandbox spawning, codec I/O,
HTTP webhook ingestion, LLM/provider API calls) bridge between the outside
world and DurableTable rows. Their job is to convert external effects into
durable rows; once a row lands in a DurableTable, the substrate becomes
uniform.

`tf-6w3s` source-read tightened the package-boundary claim: the adapter set is
finite, but "external effects only occur in `@firegrid/runtime`" is too broad.
`packages/effect-durable-streams` and `packages/effect-durable-operators`
are substrate transport libraries and legitimately own HTTP/storage effects
below Firegrid's runtime. Product-layer host/CLI effects remain work items:
MCP HTTP serving, runtime-context session byte-stream shims, and CLI embedded
dev-server lifecycle must either move below the runtime/substrate line or be
documented as narrow projection/test-harness exceptions with deletion or
stabilization targets.

**Channels are Firegrid's typed semantic transport layer over DurableTable.**
Channels are the unifying typed-interaction vocabulary across client / agent
/ CLI / MCP / runtime — analogous to how HTTP is the unifying transport
across browsers/servers, but typed and semantic rather than byte-oriented.
Each channel direction lowers to a fixed composition of DurableTable
primitives. Channels are not a new substrate; they are a typed transport
projection of the only substrate.

**Channels are not the public method names.** They are the transport
substrate over which public surfaces are projected. Multiple
projection-surface choices exist over the same channel registrations:

- **Agent verbs** (the body-plan surface): `wait_for(channel)`,
  `send(channel)`, `call(channel)` — the small fixed verb set the agent
  sees, deliberately constrained
- **Session/control capabilities** (typed methods):
  `firegrid.sessions.createOrLoad(...)`, `firegrid.permissions.respond(...)`
  — ergonomic typed methods over the same underlying channels
- **CLI / MCP / future REST / gRPC bindings** — transport- and
  surface-specific projections of the same channel verbs

The unifying property is: every public method on every surface ultimately
projects through the typed channel layer, which lowers to DurableTable
primitives. The channel layer is the substrate; the SURFACE NAMES are a
projection-specific concern.

## The One Diagram

```text
┌─────────────────────────────────────────────────────────────────┐
│ EXTERNAL WORLD                                                   │
│   LLM APIs · Linear · GitHub · Slack · OS processes · stdin/out  │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│ EXTERNAL-EFFECT ADAPTERS (the only non-DurableTable layer)      │
│   sandbox providers · codec adapters (ACP, stdio-jsonl)          │
│   verified webhook ingestion · network/HTTP clients              │
│   Each: byte/process effect ↔ DurableTable rows                  │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│ THE ONE SUBSTRATE PRIMITIVE                                      │
│   DurableTable                                                   │
│     writes:  .insert / .upsert / .delete / .insertOrGet          │
│     reads:   .get / .query                                       │
│     streams: .rows() → ProjectionStream<Row>                     │
│              .subscribe(build)                                    │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│ TYPED VIEW LAYER                                                 │
│   Channels (4 directions: ingress, egress, call, bidirectional)  │
│   Workflows (state machines whose state IS WorkflowEngineTable)  │
│   Both are typed semantic projections of DurableTable rows.      │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│ BINDING PROJECTIONS (N peers over the typed view layer)          │
│   @firegrid/client-sdk · @firegrid/host-sdk · @firegrid/cli      │
│   MCP/Effect-AI tool surface · future REST · gRPC · JSON-RPC     │
│   Each projects channel verbs into a transport-specific shape.   │
└─────────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────────┐
│ AGENT / APPLICATION CODE                                         │
│   wait_for(channel) · send(channel) · call(channel)              │
│   (verbs are the same whether called by agent, client, or CLI)   │
└─────────────────────────────────────────────────────────────────┘
```

Schemas (catalog) live in `@firegrid/protocol` and pierce every layer —
**but only the schemas that need to be shared across multiple packages**.
DurableTable row schemas live in protocol when they are part of a public
contract (operation request/response shapes, observation row shapes,
verified webhook fact shapes). Runtime-internal table schemas (workflow
engine state — `executions`, `activityClaims`, `deferreds`, `clockWakeups`
— and other substrate-internal collections) stay runtime-owned. Otherwise
protocol becomes a dumping ground for substrate internals.

The rule: a row schema goes in `@firegrid/protocol` only when more than
one package depends on its shape AND the dependency is part of a stable
contract. Runtime-private schemas stay in `@firegrid/runtime`.

## What DurableTable Actually Provides

From `packages/effect-durable-operators/src/DurableTable.ts`, the full
substrate primitive surface fits on one card:

```ts
interface CollectionFacade<Row extends object, Key> {
  // WRITES — change durable state
  readonly insert:      (row: Row) => Effect<void, DurableTableError>
  readonly upsert:      (row: Row) => Effect<void, DurableTableError>
  readonly delete:      (key: Key) => Effect<void, DurableTableError>
  readonly insertOrGet: (row: Row) => Effect<InsertOrGetResult<Row>, DurableTableError>

  // READS — query current state
  readonly get:    (key: Key) => Effect<Option<Row>, DurableTableError>
  readonly query:  <A>(build: (coll) => A) => Effect<A, DurableTableError>

  // SUBSCRIPTIONS — observe rows over time
  readonly rows:      () => ProjectionStream<Row, DurableTableError>
  readonly subscribe: <A>(subscribe: (coll, emit) => () => void) => Stream<A, DurableTableError>
  readonly collection: DurableTableCollection<Row>  // read-only TanStack view
}
```

That's the entire substrate. **Five write operations, two read operations,
two subscription patterns.** Everything else in Firegrid that LOOKS like a
substrate primitive is built from these by composition.

Properties that fall out of DurableTable for free:
- Replay safety (cold start rebuilds state via `createStreamDB`)
- Schema-checked writes (Effect Schema → Standard Schema at the
  `@durable-streams/state` boundary)
- Primary-key fencing for idempotent producers (`insertOrGet`)
- Per-row change notifications with `ProjectionStream<Row>` semantics
  (current rows + live non-deleted changes)
- OTel spans for every primitive operation
- Scope-managed acquire/release with preload on acquire

## How Each Channel Direction Lowers To DurableTable

The four directions defined in `packages/host-sdk/src/host/channel.ts`:

### IngressChannel — typed `wait_for` / observation

```ts
makeIngressChannel({
  target: "session.agent_output",
  schema: AgentOutputEventSchema,
  stream: agentOutputTable.events.rows(),   // ← DurableTable.rows()
})
```

`binding.stream` IS a `ProjectionStream<Row>` from DurableTable. The channel
adds: typed schema, named target, direction constraint at the type level.
Underneath it is one DurableTable primitive call.

### EgressChannel — typed `send` / write

```ts
makeEgressChannel({
  target: "session.prompt",
  schema: PromptPayloadSchema,
  append: (payload) => promptTable.intents.insert(payload),  // ← DurableTable.insert
})
```

`binding.append` is `DurableTable.insert` (or `upsert`). One primitive call.

### CallableChannel — typed `call` / request-response

```ts
makeCallableChannel({
  target: "host.sessions.createOrLoad",
  requestSchema: SessionCreateOrLoadInputSchema,
  responseSchema: SessionCreateOrLoadOutputSchema,
  call: (req) =>
    Effect.gen(function*() {
      const rowId = yield* controlPlaneTable.sessionRequests.insertOrGet({...req})
      const completion = yield* controlPlaneTable.completions.rows().pipe(
        Stream.filter(c => c.requestId === rowId),
        Stream.runHead,
      )
      return completion
    }),
})
```

`binding.call` is a fixed composition: **`DurableTable.insertOrGet`
(request) + `DurableTable.rows().filter().runHead` (response)**. Two
primitives. The composition pattern is uniform across all callable channels
that follow the request-row + completion-row pattern. (Other CallableChannel
binding patterns exist — see §"Variants of CallableChannel" below.)

### BidirectionalChannel — same shape, both sides

```ts
makeBidirectionalChannel({
  target: "factory.events",
  schema: FactoryEventSchema,
  stream: eventsTable.events.rows(),
  append: (e) => eventsTable.events.insert(e),
})
```

Ingress + egress over the same DurableTable collection. Combines the two
primitive patterns.

## Variants of CallableChannel binding

Not every callable channel uses the request-row + completion-row pattern.
Three legitimate binding shapes, all DurableTable-grounded:

**Pattern 1 — Request/completion through tables (cross-process / durable RPC):**
```ts
call: (req) => insertOrGet(req) + rows().filter().runHead
```
Use when: response is computed by a separate process/host; durability of
both request and response is required.

**Pattern 2 — Direct query (snapshot pattern):**
```ts
call: (req) => get(req.key) + query(...) + ... // composes reads
```
Use when: response is derivable from current durable state at call time;
no execution required.

**Pattern 3 — Policy-install over a durable binding (binding-swap pattern):**
```ts
// Wrap the default durable binding with a scoped responder policy
call: (req) =>
  Effect.gen(function*() {
    const decision = synthesizePolicyDecision(req)  // non-durable, scope-local
    return yield* defaultDurableBinding.call({ ...req, decision })  // durable write
  })
```
Use when: a scoped POLICY (e.g., `autoApprove`) should decide responses
within a scope, but the response itself still needs to land through the
durable substrate path so audit/replay/cross-host consumers see it.

**Important nuance**: the policy install (e.g., "auto-approve all
permission requests in this scope") is non-durable — it's scoped to the
host process and the Layer scope. **The response value itself IS still
written through the default durable binding** so the durable response row
exists for replay, audit, and cross-host consumers. Treat the
in-process-only "Pattern 3 variant" (binding that doesn't persist) only
for tests or genuinely throwaway compositions where durability is
explicitly out of scope.

**This is how `Layer.scoped(SomeChannel, alternateBinding)` works** —
swapping the call binding for a scope-specific implementation. The
swapped binding can choose to delegate to the substrate (preserving
durability) or short-circuit in-process (intentional non-durability for
tests).

All three patterns are legitimate. The CallableChannel type is the SAME;
only the binding implementation differs. Composition selects which
binding is installed.

## What This Unifies

Multiple previously-parallel concerns collapse to one:

| Previously parallel | Now |
| --- | --- |
| `session.wait.forAgentOutput`, `hostProjectionObserver`, `RuntimeAgentOutputAfterEvents`, direct `RuntimeOutputTable.events.rows()` | One channel: `SessionAgentOutputChannel` (ingress); one DurableTable read pattern underneath |
| `firegrid.launch`, `firegrid.sessions.createOrLoad`, `firegrid.sessions.attach`, `session.start`, `session.close` | Five callable channels: `HostContextsCreate`, `HostSessionsCreateOrLoad`, etc.; all use the request-row + completion-row binding pattern |
| `session.snapshot`, `firegrid.open`, `RuntimeContextHandle.snapshot` | Callable channels with the direct-query binding pattern over DurableTable.get + query composites |
| `permissions.autoApprove` (special-cased) | A Layer.scoped binding swap on `SessionPermissionChannel` — same as any other CallableChannel responder configuration |
| Workflow engine internal state (deferreds, activities, clocks) | Rows in `WorkflowEngineTable` (a DurableTable); workflows are state machines OVER these rows |
| Control plane (`RuntimeControlPlaneTable`) | A DurableTable; control-plane operations are callable channels over it |
| Verified webhook ingestion (`RuntimeWebhookFactsTable`) | A DurableTable populated by the verified-ingest adapter; downstream consumers wait_for over its rows |
| `FiregridRuntimeTables` / `FiregridControlPlaneTableLive` escape hatches in client-sdk | Unnecessary — channels expose the same data via typed views; the table tags become substrate-internal |

The "many parallel paths" problem in current `client-sdk/src/firegrid.ts`
exists because the typed-view consolidation never happened. Each path
evolved independently against the same underlying DurableTable rows.

## What Stays Distinct (the boundary)

**First, an important non-collapse**: not every channel becomes an
agent-visible verb. Channels are the transport vocabulary; what's
projected to the agent is a deliberate subset (the body-plan SDD's small
fixed verb set). Other channels are projected as **session/control
capabilities** — typed methods on the client/CLI/MCP surfaces, never as
generic agent `wait_for/send/call` invocations.

The agent surface stays small and constrained:
- `wait_for(channel, ...)` over agent-visible ingress/callable channels
- `send(channel, ...)` over agent-visible egress/callable channels
- `call(channel, ...)` over agent-visible callable channels

Session/control operations (`launch`, `prompt`, `start`, `close`,
`permissions.respond`, etc.) ARE channels at the transport layer, but
they ARE NOT exposed as agent verbs. They're projected as typed methods
on the appropriate surface (client SDK methods, CLI commands, MCP tools
where appropriate). The reconciliation: **everything lowers through
typed channels; some channels are user-visible verbs at the agent
plane; others are typed capabilities at the session/control plane.**

Now, three categories are explicitly NOT DurableTable. They define the
substrate boundary:

### 1. External-effect adapters

The bridge between the outside world and DurableTable rows. Small fixed set:

- **Sandbox providers**: spawn local processes, manage subprocess lifecycle.
  Implemented under `packages/runtime/src/agent-event-pipeline/sources/sandbox/`.
- **Codec adapters**: speak ACP / stdio-jsonl over byte streams to/from
  agent processes. Under
  `packages/runtime/src/agent-event-pipeline/codecs/`.
- **Verified webhook ingest**: HTTP endpoint receives bytes, verifies
  signature, writes typed row. Under
  `packages/runtime/src/verified-webhook-ingest/`.
- **Network/HTTP clients**: outbound calls to LLM providers, integration
  APIs. Per-adapter; not unified.

Each adapter does I/O the substrate cannot model. Their output becomes a
DurableTable row; their input often comes from a DurableTable row. **The
adapter layer is the only place external effects enter the substrate.**

Package placement rule:

- Firegrid application-level adapters live in `@firegrid/runtime` unless they
  are a binding-edge projection server with no durable substrate ownership.
- Durable substrate libraries (`effect-durable-streams`,
  `effect-durable-operators`) are explicit lower-tier exceptions; they provide
  the transport used by DurableTable and DurableStream and are not app-level
  adapter leaks.
- Binding packages (`host-sdk`, `cli`, future REST/gRPC/MCP packages) may own
  projection ceremony, argument parsing, and server installation for their
  surface, but byte-stream conversion, workflow/session execution, durable
  row authority, and cross-process adapter bodies belong below the binding
  line.

### 2. In-memory coordination

Some coordination is intentionally non-durable:
- Per-host fiber pools (engine worker scheduling)
- In-memory caches over durable state
- Scoped policy installs (e.g., `autoApprove` for the lifetime of a session
  handle's scope)

These are explicitly NOT durable. They're optimization or
scope-management primitives, not substrate.

### 3. Schemas and error taxonomy

- Row schemas live in `@firegrid/protocol`
- Error types (`DurableTableError`, `RuntimeContextError`,
  `UnknownChannelTarget`, etc.) are typed contract surfaces, not channels
- Channel target identifiers are string brands (`ChannelTarget`)

These are vocabulary, not primitives. They cross every layer as contracts.

## The Three-Layer Chain

Every client / agent / CLI operation lowers through exactly three layers:

```text
[binding method]   →   [channel verb]   →   [DurableTable primitive]
```

No exceptions. The chain is structurally uniform. Concrete mappings for
every current public client method:

| Client method | Channel verb | DurableTable primitive(s) |
| --- | --- | --- |
| `firegrid.launch({ runtime })` | `call(HostContextsCreate, req)` | `controlPlane.contextRequests.insertOrGet(...)` + `controlPlane.completions.rows().filter().runHead` |
| `firegrid.sessions.createOrLoad({...})` | `call(HostSessionsCreateOrLoad, req)` | `controlPlane.sessionRequests.insertOrGet(...)` + completion `rows().filter().runHead` |
| `firegrid.sessions.attach({sessionId})` | `call(HostSessionsAttach, req)` | `sessions.byId.get(sessionId)` |
| `firegrid.prompt({contextId, ...})` | `send(HostPrompt, payload)` | `controlPlane.inputIntents.insert(...)` |
| `firegrid.permissions.respond({...})` | `call(HostPermissionRespond, req)` | `responses.byRequestId.insertOrGet(...)` |
| `firegrid.watchContexts(pred)` | `wait_for(HostContexts, {match: pred})` | `contexts.rows().filter(pred)` |
| `firegrid.open(contextId)` | (synchronous handle factory, no I/O) | — |
| `session.whenReady` | `wait_for(SessionLifecycle, {match: Ready})` | `lifecycle.rows().filter().runHead` |
| `session.start()` | `call(HostSessionsStart, {sessionId})` | request + completion pattern |
| `session.prompt({...})` | `send(SessionPrompt, payload)` | `intents.insert(...)` |
| `session.snapshot()` | `call(HostSessionSnapshot, {sessionId})` | `get` + `query` over N tables |
| `session.wait.forAgentOutput({...})` | `wait_for(SessionAgentOutput, opts)` | `outputs.rows().filter().runHead` |
| `session.wait.forPermissionRequest({...})` | `wait_for(SessionPermissionRequest, opts)` | `permissionRequests.rows().filter().runHead` |
| `session.permissions.respond({...})` | `call(SessionPermission, req)` | `responses.insertOrGet(...)` |
| `session.permissions.autoApprove(d)` | `Layer.scoped(SessionPermission, policy-wrapped binding)` | `responses.insertOrGet(...)` still durable; the policy install is the scope-local part |

This table IS the architecture in concrete form. Every current method has
exactly one channel verb above it and a fixed DurableTable primitive
pattern below it. The grab-bag dissolves.

## Workflow Engine In This Model

The workflow engine is NOT a parallel substrate. It is **a state-machine
framework whose state lives in a DurableTable** (`WorkflowEngineTable`).

```ts
WorkflowEngineTable collections:
  - executions       — Workflow.execute() state
  - activityClaims   — Activity claim rows
  - activities       — Activity result rows
  - deferreds        — DurableDeferred result rows
  - clockWakeups     — DurableClock scheduled wakeups
```

Workflow primitives reduce to DurableTable operations:

| Workflow primitive | DurableTable operation |
| --- | --- |
| `Activity.execute` | claim insertOrGet → execute body → write result row → return |
| `DurableDeferred.await` | check deferreds.get(name) → suspend if none → resume on row.rows() |
| `DurableDeferred.into` | deferreds.insertOrGet (first write wins) |
| `DurableClock.sleep` | clockWakeups.insertOrGet + schedule wake → write completion deferred |
| `Workflow.suspend` | execution.upsert({suspended: true}) + fiber-terminate |
| Engine restart-replay | preload tables on engine acquire → re-execute body → primitives short-circuit to persisted rows |

The workflow engine is a **derived view over DurableTable**: state
machines that read and write specific table collections.

This means:
- `WaitForWorkflow` execution is rows in `WorkflowEngineTable`
- Activity retry semantics are durable because Activity result rows are
  durable
- Recycle/replay works because state IS DurableTable; restart re-loads
  rows + re-runs body
- The engine doesn't need a separate "durable substrate" — it IS a
  consumer of the only substrate

## The Host-SDK / Runtime / Protocol Firewall, Reframed

The boundary picture from `docs/cannon/architecture/host-sdk-runtime-boundary.md`
becomes mechanically derivable from the substrate primitive:

```text
@firegrid/protocol
  OWNS: SHARED row schemas (catalog of DurableTable row types that
        multiple packages depend on as stable contracts)
       + operation schemas (channel request/response shapes)
       + observation source name constants
  DOES NOT OWN: live DurableTable Layers; channel bindings; execution;
                runtime-internal table schemas (workflow engine
                executions/activityClaims/deferreds/clockWakeups stay
                runtime-owned because they're substrate-internal)

@firegrid/runtime
  OWNS: DurableTable.layer(...) compositions (the substrate instances)
       + workflow definitions (state machines over WorkflowEngineTable)
       + external-effect adapters (sandbox, codecs, webhook ingest)
       + workflow-engine implementation
       + row-write authorities (control-plane recorder, output journal)
       + the runtime-defined capability Tags (RuntimeToolUseExecutor, etc.)
  DOES NOT OWN: client method names, MCP tool descriptions, channel
                bindings, host topology

@firegrid/host-sdk
  OWNS: channel bindings (typed views over runtime's DurableTables)
       + channel-registry composition (per-channel Tag + Layer, tf-kddg)
       + MCP / Effect-AI tool projections of channel verbs
       + host topology composition entrypoints
       + Live Layers for runtime-defined capability Tags (host-adapter glue)
  DOES NOT OWN: workflow execution, DurableTable composition, external-
                effect adapter internals, common operation execution

@firegrid/client-sdk
  OWNS: client method sugar over channel verbs
       + transport-specific projection of channel verbs (durable-streams
         direct OR future REST / gRPC / JSON-RPC)
  DOES NOT OWN: DurableTable construction, workflow handles, runtime
                substrate Tags

@firegrid/cli, future REST/gRPC/JSON-RPC
  OWN: their transport / surface-specific projection of channel verbs
  DO NOT OWN: independent operation catalogs, durable-table facades as
              public API, runtime substrate
```

The firewall rule is mechanically derivable:
- If the module touches `DurableTable.layer(...)` directly → runtime
- If the module composes channel bindings → host-sdk (or app integration)
- If the module defines a row schema or operation contract → protocol
- If the module is a transport-specific projection of channel verbs →
  one of the binding projection packages (client-sdk, CLI, REST, etc.)

The 8-file `currentHostSdkSubstrateDebt` carveout list in
`.dependency-cruiser.cjs` is exactly the set of files where this
boundary is currently violated.

## What This Means For Convergence

The architecture stabilizes around three concentric layers:

1. **One substrate primitive** (DurableTable) + external-effect adapters
2. **One adapter layer** (channels) with four directions
3. **N binding projections** (client-sdk, host-sdk, CLI, future
   REST/gRPC/JSON-RPC, MCP/Effect-AI)

The architecture is DONE-shaped when:
- Every persisted-state operation lowers to DurableTable primitives via a
  channel verb
- The external-effect adapter set is finite and named
- Each binding projection is a pure typed wrapper over channel verbs
- Protocol owns all shared/public schemas; no parallel catalogs in binding packages (runtime-internal schemas like workflow engine state tables stay runtime-owned)
- Workflow engine is a derived view over WorkflowEngineTable, not a
  parallel substrate

## Migration Phases

Sequencing is additive-first; full collapse comes later:

### Phase 1 — Register all current operations as channels (additive)

For every current method on the public client surface, register the
corresponding channel binding. Both old and new APIs coexist.

Concretely:
- Define `HostContextsCreate`, `HostSessionsCreateOrLoad`, ...,
  `HostSessionsClose` as callable channels with request/completion
  bindings
- Define `HostContexts`, `SessionLifecycle`, ...,
  `SessionAgentOutput`, `SessionPermissionRequest` as ingress channels
- Define `HostPrompt`, `SessionPrompt` as egress channels
- Define `SessionPermission`, `HostPermissionRespond` as callable channels
- Define `HostContextSnapshot`, `HostSessionSnapshot` as callable channels
  with direct-query bindings
- Each channel registered via `Context.Tag + Layer` (tf-kddg pattern)

Acceptance: existing tests pass; new examples can use channel verbs
directly; barrel exports expose both.

### Phase 2 — Rewrite client-sdk methods as sugar over channel registry

`client-sdk/src/firegrid.ts` methods become typed wrappers that look up
the channel Tag and dispatch via `binding.{stream, append, call}`. Same
outward signatures; internal implementation collapses to channel
lookups.

Acceptance: `client-sdk/src/firegrid.ts` net code reduces materially
(~500 → ~150 lines); all `client-sdk/operations.ts` duplicate catalog
content removed in favor of protocol catalog imports.

### Phase 3 — Keep public method APIs as ergonomic projections

**Do NOT deprecate the public method API.** Client SDK methods, session
helpers, CLI commands, MCP tool surfaces, and future REST/gRPC endpoints
are all VALID projections over the channel layer. They should remain the
ergonomic public surface; channels are the substrate that those
projections lower through INTERNALLY, not a competing public API the
user is asked to learn instead.

Concretely:
- `firegrid.sessions.createOrLoad(req)` stays as a typed Effect method on
  the client surface
- Its INTERNAL implementation is sugar over the underlying
  `HostSessionsCreateOrLoadChannel`
- The channel registry is the substrate's source of truth; the public
  surface is the projection users actually call

Acceptance: every public method is implemented internally as a thin
wrapper over channel-verb dispatch; the public method signatures are
unchanged; consumers don't need to learn the channel layer to use
Firegrid. The channel layer becomes the substrate-internal contract,
exposed only for advanced/library-author use cases or for future
projection bindings (REST/gRPC/etc.) that wrap the same channels.

### Phase 4 — Document the channel layer as the projection contract

Channels are documented as **the projection contract** — the substrate-
internal API that any new binding package (REST, gRPC, JSON-RPC, etc.)
implements wrappers over. Public client/CLI/MCP surfaces are existing
projections; future bindings are additional projections.

This is NOT "drop the public method API." It IS "the public method APIs
are projections; channels are the contract those projections share."

Acceptance: docs describe channels as the substrate-internal projection
target. Each projection package (client-sdk, host-sdk, cli, MCP) is
documented as a projection over channels. Future bindings (REST/gRPC)
become mechanical — implement the channel-verb projection in the new
transport.

### Phase 5 — Project channels into future binding packages

When `@firegrid/cli`, `@firegrid/rest`, `@firegrid/grpc`, etc. are built,
each implements the SAME channel-verb surface in its transport-specific
shape. No per-binding semantic decisions; each picks transport, not
semantics.

## Acceptance Criteria (for the architecture as a whole)

- [ ] Every public client method on `client-sdk/src/firegrid.ts` lowers
      through exactly one channel verb and a fixed DurableTable primitive
      pattern
- [ ] The external-effect adapter inventory is documented and finite
      (sandbox, codecs, webhook ingest, network clients, substrate transport
      libraries — nothing else), with host/CLI projection exceptions either
      eliminated or named with a private-beta disposition
- [ ] No package outside `@firegrid/runtime` constructs `DurableTable.layer(...)`
      directly (except in test/sim infrastructure)
- [ ] `currentHostSdkSubstrateDebt` carveout list reaches zero or contains
      only compatibility shims with no behavior
- [ ] `client-sdk` exposes channel verb namespaces (`channels.*`,
      `operations.*`, `snapshots.*` OR a unified projection that hides
      the categorization) and no longer exposes `FiregridRuntimeTables`,
      `FiregridControlPlaneTableLive`, or `runtimeControlPlaneStreamUrl`
      as public surface
- [ ] `protocol` is the only package defining `defineFiregridOperation(...)`
      or its equivalent catalog grouping
- [ ] Workflow definitions live exclusively in
      `@firegrid/runtime/workflow-engine/workflows/`
- [ ] Channel registry uses per-channel `Context.Tag + Layer` (tf-kddg);
      no central `ChannelRegistry` service
- [ ] Each channel binding is type-direction-enforced (`wait_for` only
      accepts ingress/bidirectional/callable; `send` only accepts
      egress/bidirectional/callable; `call` only accepts callable)
- [ ] Telemetry / span naming convention is documented per layer
      (`firegrid.durable_table.*` for primitive ops; `firegrid.channel.*`
      for channel verbs; `firegrid.workflow_engine.*` for engine ops)

## Non-Goals

- **Not abandoning the workflow engine.** The workflow engine stays; it
  becomes recognized as a derived view over WorkflowEngineTable, not a
  separate substrate.
- **Not unifying external-effect adapters.** Sandbox, codecs, webhook
  ingest, and network clients remain distinct adapters. Their unification
  is "they all write into DurableTable" — not "they share a common shape."
- **Not changing the DurableTable primitive surface.** The substrate
  primitive is small and complete. No new operations added.
- **Not unifying schemas across DurableTable collections.** Each row
  schema stays distinct per its semantic; protocol owns the catalog.
- **Not eliminating typed errors.** Each channel call returns
  `Effect<Res, ChannelErr>`; error types remain per-domain.
- **Not unifying the four channel directions into one type.** The
  distinction is load-bearing for type-level direction enforcement.

## Open Questions / Decisions Still Owed

### Q1: Does protocol export DurableTable row schemas, or just Schema definitions?

Today protocol exports both Schema declarations (row schemas) AND live
DurableTable tag declarations (`RuntimeControlPlaneTable`,
`RuntimeOutputTable`). The latter is what enables client-sdk's direct
durable-table escape hatch.

Options:
- **A**: Protocol exports row Schemas only. DurableTable tag declarations
  move to runtime; client-sdk can never construct table layers directly.
  Cleanest separation.
- **B**: Protocol continues exporting DurableTable tags but DOC marks them
  as substrate-internal. Bindings stop using them as public API. Same as
  today plus discipline.
- **C**: Protocol exports a transport-shaped wrapper (`RemoteTable<...>`)
  that hides DurableTable construction; the durable-streams transport is
  ONE implementation, REST/gRPC/etc. become alternatives.

**Recommend: A** for the long term; **B** as a transitional state.
Option C is over-engineering until a non-durable-streams transport
exists.

### Q2: Where do snapshot composites live?

A snapshot like `RuntimeContextSnapshot` aggregates rows from multiple
DurableTable collections. The composition logic ("read context + runs +
events + logs + outputs, assemble snapshot") needs a home:
- Runtime (alongside the table implementations)?
- Host-sdk (as part of channel binding)?
- Protocol (as a composed read schema)?

**Recommend**: composition in runtime (it's substrate read logic).
Protocol owns the snapshot schema (output shape). Host-sdk's
HostSessionSnapshot channel binding has `call: (req) => runtimeService.snapshot(req)`.

### Q3: Do CallableChannel bindings need explicit pattern declaration?

The three CallableChannel binding patterns (request/completion,
direct-query, in-process responder) have very different durability and
performance characteristics. Should the channel type declare which
pattern it uses, for type-level reasoning?

```ts
makeCallableChannel({
  ...,
  bindingPattern: "request-completion" | "direct-query" | "in-process",
})
```

Or is binding pattern an implementation detail consumers shouldn't see?

**Recommend**: implementation detail; consumers shouldn't see. Different
Layers can provide different bindings; the channel surface stays
uniform. Document the patterns in this SDD for binding-implementer
reference.

### Q4: Streaming subscriptions vs single-wait for channels?

`wait_for(channel, opts)` returns the first match. There's no canonical
verb for "subscribe to all events forever" — currently agents do
`while(true) { wait_for(...) }`.

Should there be a `subscribe(channel)` verb that returns
`Stream<Event>`?

**Recommend: NO at the agent surface; YES in projection-specific APIs
where it's natural.**

Reasoning: exposing a `subscribe(channel)` as an AGENT VERB would
reintroduce transport-shaped semantics (long-lived stream handles) into
the body plan, which the channels-as-nervous-system framing
deliberately excludes. Agent verbs are constrained to the small
fixed set (wait_for, send, call) for cognitive simplicity and
suspend/resume safety; long-lived stream handles fit poorly in the
agent execution model.

The right shape:
- **Agent surface**: `wait_for(channel, opts)` only. Repeated waits
  (the `while(true) { wait_for(...) }` pattern) are the agent's
  expression of "subscribe forever."
- **Client SDK surface**: `subscribe(channel, opts)` returning
  `Stream<Event>` is natural and ergonomic. Use cases like UI rendering
  / dashboards / monitoring genuinely want stream handles.
- **Runtime bindings**: direct `channel.binding.stream` access is
  fine for substrate-internal consumers.

The asymmetry is correct: different surfaces have different ergonomic
needs. Agent verbs stay constrained; client/runtime surfaces expose
richer combinators where appropriate.

### Q5: How are policy-install patterns (autoApprove) discovered?

`session.channels.permission.autoApprove("allow")` is sugar over
`Layer.scoped(SessionPermission, allowResponderLayer)`. But if every
callable channel can have policy installs, users need a way to discover
the installable patterns per channel.

**Recommend**: per-channel modules expose typed sugar helpers (e.g.,
`SessionPermissionChannel.autoApprove(decision)`). Discovery via IDE
autocomplete on the channel module. The Layer.scoped pattern is the
underlying truth.

## Worked Example: A Complete Operation Lowering

Concrete trace of `firegrid.sessions.createOrLoad({ runtime, externalKey })`
through every layer:

```ts
// LAYER 5 — application code
const session = yield* firegrid.sessions.createOrLoad({
  runtime: local.jsonl({ argv: [...], agentProtocol: "stdio-jsonl" }),
  externalKey: "user-42-session",
})

// LAYER 4 — client-sdk sugar (Phase 2 shape)
firegrid.sessions.createOrLoad = (req) =>
  Effect.gen(function*() {
    const ch = yield* HostSessionsCreateOrLoadChannel  // Context.Tag
    return yield* ch.binding.call(req)                 // CallableChannel binding
  })

// LAYER 3 — channel verb dispatch (channel.ts)
ch.binding = {
  _tag: "CallTarget",
  call: (req) => /* see Layer 2 */,
}

// LAYER 2 — binding implementation (runtime or host-sdk Layer)
call: (req) => Effect.gen(function*() {
  const table = yield* RuntimeControlPlaneTable
  const requestId = crypto.randomUUID()
  // Write request
  yield* table.sessionRequests.insertOrGet({   // ← LAYER 1 primitive
    requestId,
    runtime: req.runtime,
    externalKey: req.externalKey,
    createdAt: ...,
  })
  // Observe completion
  const completion = yield* table.sessionCompletions.rows().pipe(  // ← LAYER 1
    Stream.filter(c => c.requestId === requestId),
    Stream.runHead,
  )
  return {
    sessionId: completion.sessionId,
    contextId: completion.contextId,
  }
})

// LAYER 1 — DurableTable primitives
table.sessionRequests.insertOrGet(...)  // durable write, primary-key-fenced
table.sessionCompletions.rows()         // ProjectionStream<Row>: current + live changes
```

The same shape applies to **every public client operation that touches
persisted state**. Layer 5 (app code) calls Layer 4 (client sugar) calls
Layer 3 (channel verb) calls Layer 2 (binding impl) calls Layer 1
(DurableTable primitives).

Synchronous handle factories (e.g., `firegrid.open(contextId)`, which
just constructs a typed handle without touching the substrate) are the
trivial exception — they're pure value constructors, no I/O, no channel
verb invocation. They lower nowhere because they don't reach the
substrate. Every operation that DOES reach the substrate flows through
the full chain.

## What This SDD Replaces / Strengthens

- **`SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md`**: stays valid, gets
  strengthened. The "one substrate" is more precisely "one substrate
  primitive" (DurableTable); the workflow engine is a derived view over
  it. The workflow engine is not the bottom of the stack.
- **`SDD_FIREGRID_AGENT_BODY_PLAN.md`**: gets the concrete substrate
  grounding. Channels-as-nervous-system → channels-as-typed-views-over-
  DurableTable.
- **`SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`**: gets the concrete
  substrate grounding. Projection bindings are typed wrappers over
  channel verbs over DurableTable primitives.
- **`docs/cannon/architecture/host-sdk-runtime-boundary.md`**: gets a
  derivable firewall rule. The boundary is mechanically derivable from
  "who touches DurableTable directly?" rather than from per-file
  classification.

## Cross-References

- `packages/effect-durable-operators/src/DurableTable.ts` — the substrate
  primitive
- `packages/host-sdk/src/host/channel.ts` — the four channel directions
- `packages/runtime/src/workflow-engine/` — workflow engine as derived view
- `packages/protocol/` — schemas, operation catalog
- `.dependency-cruiser.cjs` — `currentHostSdkSubstrateDebt` carveout
- `SDD_FIREGRID_AGENT_BODY_PLAN.md` — channels as nervous system framing
- `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` — projection contract
- `SDD_FIREGRID_ONE_SUBSTRATE_WORKFLOW_ENGINE.md` — workflow engine
  unification (now strengthened)
- `SDD_FIREGRID_ENGINE_NATIVE_PRIMITIVES_ESCAPE_HATCH.md` — engine-native
  primitives stay valid as performance optimization over the substrate

## One-Paragraph Summary

Firegrid's architecture stabilizes on three concentric truths: **one
substrate primitive (`DurableTable`)** for all persisted state; **one
typed transport layer (channels with four directions)** that gives
typed-semantic shapes over DurableTable read/write/observe operations,
analogous to how HTTP is the typed-byte transport beneath browsers and
servers; and **N projection surfaces** (client-sdk methods, agent verbs,
CLI commands, MCP tools, future REST/gRPC/JSON-RPC bindings) that wrap
channels in surface-appropriate shapes. Channels are the transport
contract, not the user-visible API — public method names (e.g.
`firegrid.sessions.createOrLoad`) remain valid ergonomic projections and
should NOT be deprecated in favor of channel-direct access. The agent
surface stays deliberately small (`wait_for`/`send`/`call` over
agent-visible channels); session/control operations are projected as
typed capabilities on their respective surfaces. A small finite set of
external-effect adapters (sandbox, codecs, webhook ingest, network)
bridge the outside world into DurableTable rows. The workflow engine is a
derived view over `WorkflowEngineTable`, not a parallel substrate.
Protocol owns SHARED schemas only; runtime-internal table schemas stay
runtime-owned. The boundary firewall between
protocol/runtime/host-sdk/client-sdk becomes mechanically derivable from
"who touches DurableTable directly?" — and the answer is "runtime only."
