# SDD: Firegrid Schema Projection Contract

Status: Living contract — **refreshed for the per-event runtime (post-#863)**.
The pre-cutover revision described a `RuntimeInputIntent → DurableDeferred →
RuntimeContextWorkflowSession.send` input chain; the prior revision re-anchored
it on a `signal.ts` mailbox (`SignalTable` / `armSession` / "the workflow body
reads its own signals"). **Both are gone.** `signal.ts` was deleted in #863 and
the RuntimeContext session is now a **per-event handler** (one fresh execution
per input, keyed `(contextId, inputKey)`). This revision re-anchors the contract
on that reality and makes the **binding model** crystal clear: what a binding
is, the components it composes from, and the mechanism to bind the Firegrid
catalog to *any* host/platform.

Every claim below cites a real `file:line` on current `main`. If a citation and
the tree disagree, the tree wins — fix the doc.

Related specs:

- `firegrid-schema-projection-contract`
- `firegrid-factory-aligned-agent-tools`
- `firegrid-local-mcp-run`
- `docs/sdds/SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION.md` (the channel/offset unification)
- `docs/sdds/SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md` (completion contracts)

---

## Mental model (unchanged catalog; refined binding shape)

```txt
protocol operation/observation/channel catalog        ← the product contract
  → binding shapes
       → router-shaped bindings   (MCP, HTTP, gRPC request/response ingress routers)
       → client-shaped bindings   (client-sdk facade, CLI launcher)
  → execution router  (RuntimeChannelRouter / HostPlaneChannelRouter)
  → execution      (channel-binding Lives → per-event RuntimeContext handler)
```

The schema/channel catalog in `@firegrid/protocol` is the source of truth.
Tools, client APIs, the CLI, and future transports are **bindings** of that
catalog. Bindings may differ in names and transport; they must not define
different contracts. Execution is owned by the unified host, not by any binding.

A binding has exactly two existing shapes. **Router-shaped** bindings are
request/response transport ingress routers whose handlers decode a transport
request and delegate to the execution router; **client-shaped** bindings are
programmatic facades or launchers that call the client facade directly and do
not create an inbound route table. The duality is: an ingress router maps
`transport request -> handler` at the edge, while `RuntimeChannelRouter` maps
`(target, verb) -> channel binding` at execution; a router-shaped binding is
the adapter between those two registries.

This is deliberately **not** "agent tools → client API", "client API → agent
tools", or "a new service layer → everything." Every user-facing operation has
**one** schema-owned definition; each binding projects from it.

---

## What a binding is

> **A binding is a projection of the protocol catalog onto one transport: it
> reads the operation/observation/channel schemas (and their projection
> metadata) and exposes them as that transport's surface — and nothing else.**

The contract a binding must satisfy:

- **Uses protocol as the contract source.** The projection data is
  `FiregridProjectionMetadata { operationId, toolName?, clientName?, cliName? }`
  (`packages/protocol/src/projection/schema.ts:4-9`), attached by
  `firegridProjection(...)` (`packages/protocol/src/projection/schema.ts:15-19`)
  and read with `getFiregridProjectionMetadata(...)`
  (`packages/protocol/src/projection/schema.ts:21-28`).
- **Delegates instead of inventing execution.** Router-shaped bindings delegate
  to `channelRouter.dispatch({ target, verb, payload })`
  (`packages/runtime/src/channels/router.ts:70-72`). Client-shaped bindings call
  the client facade/channel Tags (`packages/client-sdk/src/firegrid.ts:352-375`,
  `:420-450`, `:1186-1221`, `:1405-1451`). MCP delegates through the
  `ToolDispatch` facade (`packages/runtime/src/unified/mcp-host/toolkit-layer.ts:72-78`,
  `packages/runtime/src/unified/mcp-host/tool-dispatch.ts:777-791`).
- **Never clones a schema.** Names/help/examples come from the schema's
  annotations; request/response shapes come from the schema itself. A binding
  never redefines a contract field.
- **Projects responses back through the schema.** Rows → public observations are
  `Schema.transform`/decoders owned by protocol (e.g.
  `RuntimeAgentOutputObservationFromRowSchema`,
  `packages/protocol/src/session-facade/schema.ts:540-546`, consumed by
  `runtimeAgentOutputObservationFromRow`,
  `packages/protocol/src/session-facade/schema.ts:548-551`), never
  `JSON.parse(row.raw)` in the binding.

**The invariant that matters is IMPORT DIRECTION, not a folder taxonomy.**
projection ← protocol schemas; execution ← the router/channel-binding Lives.
There is no `Binding<T>` base class, no `defineBinding` descriptor, and no
required package layout. A file is projection if it reads protocol schemas and
names; it is execution if it performs substrate effects. A router-shaped edge
may live in runtime/host composition because it needs the execution router, but
its transport surface still comes from protocol, not from cloned schemas or a
peer binding. (The same rule forbids a `defineFiregridOperation` descriptor as
the contract source of truth — see Boundary rules.)

---

## Binding components

```txt
   ┌──────────────────────────  @firegrid/protocol (the catalog)  ──────────────────────────┐
   │                                                                                          │
   │  schema catalog            firegridProjection            channel TARGETS  + KINDS        │
   │  agent-tools/schema.ts      projection/schema.ts          channels/core.ts                │
   │  session-facade/schema.ts   {operationId, toolName?,      makeChannelTarget()            │
   │  channels/*                  clientName?, cliName?}        Ingress/Egress/Callable/        │
   │  (Schema.Struct/Union)      getFiregridProjectionMetadata Bidirectional/DurableEvent      │
   │        │                          │                              │  + VERBS               │
   └────────┼──────────────────────────┼──────────────────────────────┼─ channels/router.ts ──┘
            │  read shapes              │  read per-surface names       │  send | wait_for | call
            ▼                           ▼                               ▼
   ┌─────────────────────────────  BINDING SHAPES  ────────────────────────────────────────────┐
   │  router-shaped: MCP toolkit / future HTTP / future gRPC  → ingress router handlers         │
   │  client-shaped: client-sdk facade / CLI launcher          → programmatic calls              │
   └───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                │  delegate (never invent execution)
                                                ▼
   ┌──────────────────────────  EXECUTION ROUTER / FACADES (runtime)  ─────────────────────────┐
   │  RuntimeChannelRouter / HostPlaneChannelRouter .dispatch({target,verb,payload})            │
   │  channels/router.ts        ·        ToolDispatch.call(...)   mcp-host/tool-dispatch.ts      │
   └───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                │
                                                ▼
   ┌──────────────────────────  EXECUTION (runtime)  ──────────────────────────────────────────┐
   │  channel-binding Lives  (unified/channel-bindings.ts)  →  per-event RuntimeContext handler  │
   │                                                            (unified/subscribers/runtime-context.ts) │
   └────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Component | What it is | Lives in (file:line) | Boundary |
| --- | --- | --- | --- |
| **Schema catalog** | The operation/observation request/response shapes (`Schema.Struct`/`Schema.Union`). The product contract. | `protocol/src/agent-tools/schema.ts`, `protocol/src/session-facade/schema.ts`, `protocol/src/channels/*` | Source of truth. No transport, no execution. |
| **`firegridProjection` metadata** | The one Firegrid custom annotation carrying per-surface names: `{ operationId, toolName?, clientName?, cliName? }`. | `packages/protocol/src/projection/schema.ts:4-9` (type), `:15-19` (`firegridProjection`), `:21-28` (`getFiregridProjectionMetadata`); agent-tool inputs attach it via `toolAnnotations` (`packages/protocol/src/agent-tools/schema.ts:78-85`). | Input schemas carry projection names. `cliName` is reserved; see the CLI resolution below. |
| **Channel TARGET** | A typed, branded string address for a route. | `packages/protocol/src/channels/core.ts:18-25` (`ChannelTarget`, `makeChannelTarget`). | Stable dispatch key. |
| **Channel VERB** | The action over a target: `send` \| `wait_for` \| `call`. | `packages/protocol/src/channels/router.ts:11-18` (`ChannelRouteVerb`), `:20-33` (`channelRouteVerbsForDirection`). | egress→`send`, ingress→`wait_for`, call→`call`, bidirectional→`send`+`wait_for`. |
| **Channel KIND** | The route shape and its binding slot. | `packages/protocol/src/channels/core.ts:99-108` (`IngressChannel`/`binding.stream`), `:110-119` (`EgressChannel`/`binding.append`), `:121-137` (`BidirectionalChannel`/`stream`+`append`), `:139-149` (`CallableChannel`/`binding.call`), `:151-155` (`ChannelRegistration`). | Determines legal verbs and whether execution is stream, append, or call. |
| **Dispatch request** | The execution-router request envelope `{ target, verb, payload? }`. | `packages/protocol/src/channels/router.ts:89-93` (`ChannelDispatchRequest`). | Transport-neutral request to the execution router. |
| **Execution router** | `RuntimeChannelRoute` plus `RuntimeChannelRouter` / `HostPlaneChannelRouter` Tags. | `packages/runtime/src/channels/router.ts:45-52` (`RuntimeChannelRoute`), `:61-73` (`RuntimeChannelRouterService`), `:79-89` (Tags), `:126-190` (`makeRuntimeChannelRouter`), `:224-249` (`runtimeRouteFromChannel`). | Runtime-owned. Decodes the route payload, checks the verb, then invokes `binding.append`/`binding.call`/`binding.stream`. |
| **Router-shaped binding** | A transport ingress router whose handlers project catalog routes/tools and then delegate to the execution router/facade. | Effect `HttpRouter`: `repos/effect/packages/platform-node/examples/http-router.ts:16-54`; tagged `HttpRouter`: `repos/effect/packages/platform-node/examples/http-tag-router.ts:6-24`, `:37-41`. MCP: `Tool.make(...).setParameters(...).setSuccess(...)` (`packages/runtime/src/unified/mcp-host/toolkit.ts:168-178`), handler `ToolDispatch.call(...)` (`packages/runtime/src/unified/mcp-host/toolkit-layer.ts:72-78`), tool executor `router.dispatch(...)` (`packages/runtime/src/unified/mcp-host/tool-dispatch.ts:164-176`, `:191-224`). | MCP/HTTP/gRPC request/response ingress. It owns transport decoding/encoding; execution stays behind the router. |
| **Client-shaped binding** | A programmatic facade or launcher with no inbound route table. | Client facade interfaces/Tag: `packages/client-sdk/src/firegrid.ts:285-375`; metadata-driven method wrapper: `:420-450`; writes through channel Tags: `:1186-1221`, `:1405-1451`, `:1463-1533`; reads through protocol views: `:956-966`, `:993-1019`, `:1034-1040`, `:1063-1064`. CLI edge today: `@firegrid/cli` shell (`packages/cli/src/index.ts:1-5`) and `@effect/cli` commands in runtime bins (`packages/runtime/src/bin/firegrid.ts:120-193`). | client-sdk and CLI launcher. No `cliName` route projection, no transport ingress router. |
| **Channel-binding Lives** | The execution-side `Layer`s backing each target. Post-#863 they execute a fresh per-event RuntimeContext handler — no `signal.ts`. | `packages/runtime/src/unified/channel-bindings.ts:103` (`executeSessionInput`), `:311`/`:339`/`:365` (signaling Lives), `:452` (production bundle). | Runtime-owned execution. |
| **`ToolDispatch`** | The MCP facade: `ToolDispatch.call({contextId, toolUseId, toolName, input})` → the MCP dispatch workflow. | `packages/runtime/src/unified/mcp-host/tool-dispatch.ts:777-791` (service + Tag), `:817-824` (`call`→`McpToolDispatchWorkflow.execute`). | MCP entry's execution facade. |

### Router duality — side by side

| Edge ingress router | Execution router |
| --- | --- |
| Effect `HttpRouter` registers `(method, path) -> handler`: `HttpRouter.empty.pipe(HttpRouter.get("/", ...), HttpRouter.post("/upload", ...))` (`repos/effect/packages/platform-node/examples/http-router.ts:16-39`) and `HttpServer.serve(...)` turns the router into a server (`repos/effect/packages/platform-node/examples/http-router.ts:52-54`). `HttpRouter.Tag` gives the same registry shape through a Tag/Layer surface (`repos/effect/packages/platform-node/examples/http-tag-router.ts:6-24`) and `HttpRouter.Default.unwrap(HttpServer.serve(...))` serves it (`repos/effect/packages/platform-node/examples/http-tag-router.ts:37-41`). | Firegrid `RuntimeChannelRouter` registers `(target, verb) -> RuntimeChannelRoute`: `ChannelDispatchRequest` carries `target`, `verb`, and `payload` (`packages/protocol/src/channels/router.ts:89-93`); `RuntimeChannelRoute.invoke(payload, verb)` is the registered handler (`packages/runtime/src/channels/router.ts:45-52`); `makeRuntimeChannelRouter(...).dispatch(...)` finds the target, checks the verb, decodes the payload, then calls `matched.invoke(...)` (`packages/runtime/src/channels/router.ts:126-190`). |

The decision rule is therefore mechanical:

- **Is the surface transport request/response-shaped?** Use a router-shaped
  binding: build a transport ingress router whose handlers decode the transport
  request, then call `channelRouter.dispatch({ target, verb, payload })`.
- **Is the surface programmatic or a process launcher?** Use a client-shaped
  binding: expose a facade/launcher over the client-sdk operation methods. Do
  not project per-operation CLI routes and do not introduce an inbound router.

### Channel kinds — what each means + when to use

`ChannelDirection` is `ingress | egress | call | bidirectional`
(`protocol/src/channels/core.ts:4`). The kind dictates the binding payload and
the legal verb(s):

| Kind | Shape | Verb | Use when |
| --- | --- | --- | --- |
| **`IngressChannel<S>`** (`core.ts:99`) | `binding.stream` — a typed `Stream` the consumer reads. | `wait_for` | The caller observes/waits for typed rows produced elsewhere (e.g. `session.lifecycle`, `host-control.ts:133`; per-session child output via `runtimeRouteFromFactoryIngressChannel`, `router.ts:302`). |
| **`EgressChannel<S, Receipt>`** (`core.ts:110`) | `binding.append(payload) → Receipt`. | `send` | The caller appends one typed event and gets a receipt. |
| **`CallableChannel<Req, Res>`** (`core.ts:139`) | `binding.call(request) → response`. | `call` | A synchronous request/response derivation with no durable input delivery (e.g. `host.contexts.create` → a derived `SessionHandleReference`, `host-control.ts:57`). |
| **`BidirectionalChannel<S>`** (`core.ts:121`) | both `stream` and `append`. | `send` + `wait_for` | A single target that is both written and observed. |
| **`DurableEventChannel<P>`** (`core.ts:303`) | `EgressChannel<P, EventOffset>` — append returns a wire offset (`EventOffsetSchema`, `core.ts:290`). Built with `makeDurableEventChannel` (`core.ts:305`). | `send` | **The input-delivery default.** Every input op (prompt, permission response, session start, cancel/close, scheduled fire, webhook ingest, peer emit) is "durably append an event, return an offset" — one shape instead of seven response schemas (`core.ts:265`). `host.prompt`/`session.prompt`/`host.sessions.start`/`session.cancel`/`session.close`/`host.permissions.respond` are all `DurableEventChannel` (`host-control.ts:65/77/98/107/116/145`). |

A route also declares **completion semantics** (`ChannelRouteCompletion`,
`core.ts:62`): `acknowledgement` (default — the dispatch result is an
append/identity receipt) or `terminal` (the result IS terminal completion
evidence, carried by a `receiptSchema`, typically `RouteCompletionReceipt`,
`core.ts:36`). This is route-owned descriptor metadata, **not** a caller
`isComplete`/await-mode flag (`core.ts:54`).

---

## How to add a new binding

Start from the shape, not from the transport name.

### Router-shaped transport: MCP / HTTP / gRPC

1. Read protocol schemas, channel targets, verbs, and route metadata:
   `FiregridProjectionMetadata` (`packages/protocol/src/projection/schema.ts:4-9`),
   channel kinds (`packages/protocol/src/channels/core.ts:99-155`), and
   `ChannelRouteVerb` / `ChannelDispatchRequest`
   (`packages/protocol/src/channels/router.ts:11-33`, `:89-93`).
2. Build the transport ingress router. HTTP uses Effect `HttpRouter.get/post`
   handlers (`repos/effect/packages/platform-node/examples/http-router.ts:16-39`);
   MCP uses Effect AI `Tool.make(...).setParameters(...).setSuccess(...)`
   (`packages/runtime/src/unified/mcp-host/toolkit.ts:168-178`).
3. Each handler decodes the inbound transport request to the schema payload and
   delegates to the execution router:
   `channelRouter.dispatch({ target, verb, payload })`. The runtime router then
   checks the target/verb and invokes the channel binding
   (`packages/runtime/src/channels/router.ts:153-175`, `:224-249`).
4. Encode the dispatch result through the response schema/route metadata. A
   transport-specific success envelope belongs at the edge; the route's schema
   remains protocol-owned.

**gRPC sketch:** a generated gRPC method is one ingress-router handler. The
service/method name maps to a protocol `target` and `verb`; the protobuf/JSON
payload decodes to the route input schema; the handler calls
`channelRouter.dispatch({ target, verb, payload })`; the returned value is
encoded through the route response schema. gRPC is router-shaped because the
ingress edge is a request/response server.

### Client-shaped facade or launcher: client-sdk / CLI

1. Expose programmatic methods whose names come from `clientName` or an explicit
   facade decision, not from a route table. The current client facade is the
   `Firegrid` Tag and `FiregridService` interfaces
   (`packages/client-sdk/src/firegrid.ts:285-375`).
2. Validate input with the operation schema and annotate spans from projection
   metadata (`packages/client-sdk/src/firegrid.ts:420-450`).
3. Call the owned facade/channel Tag directly. Examples: `session.prompt` calls
   `sessionPromptChannel.forSession(sessionId).binding.append(...)`
   (`packages/client-sdk/src/firegrid.ts:1204-1221`), `sessions.createOrLoad`
   calls `hostSessionsCreateOrLoadChannel.binding.call(...)`
   (`packages/client-sdk/src/firegrid.ts:1405-1451`), and top-level methods are
   returned from `Firegrid.of(...)` (`packages/client-sdk/src/firegrid.ts:1463-1533`).
4. For a CLI, build `@effect/cli` commands as a launcher over the client facade.
   The source evidence for the CLI type shape is `Command.make(...)` /
   `Command.withSubcommands(...)` (`packages/runtime/src/bin/firegrid.ts:120-183`)
   and `Command.run(...)` (`packages/runtime/src/bin/firegrid.ts:185-193`). That is
   a launcher shape, not an inbound router shape.

### Worked example — MCP (router-shaped, realized)

`runtime/src/unified/mcp-host/toolkit.ts` realizes the recipe verbatim:

- step 2: `const metadata = Option.getOrThrow(getFiregridProjectionMetadata(group.input))`
  (`packages/runtime/src/unified/mcp-host/toolkit.ts:169`);
  `const toolName = metadata.toolName ?? metadata.operationId`
  (`packages/runtime/src/unified/mcp-host/toolkit.ts:170`).
- step 3: `Tool.make(toolName, ...).setParameters(group.input).setSuccess(group.output).setFailure(...)`
  (`packages/runtime/src/unified/mcp-host/toolkit.ts:171-177`);
  collected into `FiregridAgentToolkit = Toolkit.make(...)`
  (`packages/runtime/src/unified/mcp-host/toolkit.ts:259`).
- step 4: the toolkit handler resolves `ToolDispatch` and calls
  `dispatch.call({ contextId, toolUseId, toolName, input })`
  (`packages/runtime/src/unified/mcp-host/toolkit-layer.ts:72-78`);
  `ToolDispatch.call` runs `McpToolDispatchWorkflow.execute(...)`
  (`packages/runtime/src/unified/mcp-host/tool-dispatch.ts:817-824`), whose body
  dispatches each tool through `router.dispatch({ target, verb, payload })`
  (`packages/runtime/src/unified/mcp-host/tool-dispatch.ts:174`).

The MCP binding is router-shaped even though its ingress router is a toolkit
instead of an HTTP path table: `Tool.make(...)` registers tool handlers, the
handler delegates to `ToolDispatch.call(...)`, and the executor lowers tool
names to `RuntimeChannelRouter.dispatch(...)` (`packages/runtime/src/unified/mcp-host/tool-dispatch.ts:164-176`,
`:191-224`).

### Worked example — client (client-shaped, realized)

`client-sdk/src/firegrid.ts` projects the session-facade catalog into the client
facade. It is browser-safe (protocol-only imports, enforced by
`client-sdk-no-runtime`).

- step 2: `const metadata = Option.getOrThrow(getFiregridProjectionMetadata(operation.input))`
  (`packages/client-sdk/src/firegrid.ts:434`), reading `operationId`/`clientName`
  (`packages/client-sdk/src/firegrid.ts:435-439`).
- step 3/4: writes resolve a protocol channel `Tag` and invoke its binding —
  e.g. `session.start()` → `hostSessionsStartChannel.binding.append({ sessionId })`
  (`packages/client-sdk/src/firegrid.ts:1373-1381`); `session.prompt` →
  `sessionPromptChannel.forSession(sessionId).binding.append(...)`
  (`packages/client-sdk/src/firegrid.ts:1204-1221`); `sessions.cancel` →
  `sessionCancelChannel.binding.append(...)`
  (`packages/client-sdk/src/firegrid.ts:1224-1249`); `permissions.respond` →
  `hostPermissionRespondChannel.binding.append(...)`
  (`packages/client-sdk/src/firegrid.ts:1517-1533`).
- step 5: reads project rows → observations via
  `runtimeAgentOutputObservationFromRow`
  (`packages/client-sdk/src/firegrid.ts:911`, `:1063-1064`), and caller-facing
  read paths use protocol-owned views (`runtimeContextsView`,
  `runtimeRunsForContextView`, `runtimeEventsForContextView`,
  `runtimeLogsForContextView`) rather than table-shaped logic
  (`packages/client-sdk/src/firegrid.ts:956-966`, `:993-1019`, `:1034-1040`,
  `:1063-1064`; view definitions in `packages/protocol/src/launch/views.ts:22-46`).

### Worked example — CLI (client-shaped resolution)

`cliName` is **reserved**. It remains a metadata field
(`packages/protocol/src/projection/schema.ts:4-9`) and some historical schemas
still carry values (`packages/protocol/src/agent-tools/schema.ts:480-499`,
`:516-538`, `:557-566`, `:578-590`, `:608-619`), but the resolved model does not
use `cliName` to project an inbound router or per-operation route table.

The CLI is client-shaped: it is a launcher/facade over Firegrid operations, not
a request/response transport server. Current source confirms that
`@firegrid/cli` is only a package shell pointing to runtime bin entrypoints
(`packages/cli/src/index.ts:1-5`), and those bin entrypoints are process
launchers built with `@effect/cli` `Command.make(...)` /
`Command.withSubcommands(...)` / `Command.run(...)`
(`packages/runtime/src/bin/firegrid.ts:120-193`). The current runtime-owned
`firegrid run` path still composes host/runtime services and invokes channel
Tags directly (`packages/runtime/src/bin/run.ts:97-153`); that is a process
entrypoint, not a precedent for a CLI projection router. The open-slice-2 text
"project flags/help from `cliName`" is therefore corrected: rebuild any
programmatic CLI as a client-shaped launcher over the client-sdk facade; keep
`cliName` reserved unless a future SDD reactivates it for non-router help text.

### Worked example — gRPC / REST (router-shaped sketch)

A new HTTP/gRPC/JSON-RPC transport is router-shaped:

1. Depend on protocol schemas for operation shapes and channel route metadata.
2. Build an ingress router in the host/transport layer: `HttpRouter` for HTTP,
   a gRPC service implementation for gRPC.
3. For each transport handler, decode the request body to the protocol input,
   call `channelRouter.dispatch({ target, verb, payload })`, and encode the
   result through the protocol response schema.
4. Do not add a second execution registry. The runtime router already decodes the
   payload against the route `inputSchema` and invokes the channel binding
   (`packages/runtime/src/channels/router.ts:166-175`, `:224-249`).

---

## Input boundary — per-event (post-#863)

The pre-cutover `RuntimeInputIntent → DurableDeferred → ...send` chain and the
`signal.ts` mailbox (`SignalTable` / `armSession` / "the body reads its own
signals") are both **superseded**. `signal.ts` was deleted in #863. The live
path is per-event:

```text
client method (sessions.prompt / start / cancel / permissions.respond)
  → protocol-owned channel call (host.prompt / session.prompt / host.sessions.start
    / session.cancel / session.close / host.permissions.respond — DurableEventChannel)
  → host channel-binding Live EXECUTES a fresh per-event RuntimeContext handler
    (Workflow.execute({discard}), keyed (contextId, inputKey), input carried in the payload)
  → the handler body: startOrAttach the live process (Activity), then forward the
    input envelope to adapter.send (or, for terminal input, adapter.deregister), and RETURN
```

Mechanics (file:line):

- The binding delivers one input by `executeSessionInput(...)` →
  `RuntimeContextSessionWorkflow.execute({...}, { discard: true })`
  (`unified/channel-bindings.ts:103`). `execute({discard:true})` *creates* the
  execution — this is the input-before-start "arm" — and returns its
  `executionId`. Production targets are the Signaling Lives
  (`HostPromptChannelSignalingLive` `:307`, `SessionPromptChannelSignalingLive`
  `:333`, `SessionCancelChannelSignalingLive` `:361`), bundled as
  `UnifiedSignalingChannelBindingsLive` (`:452`).
- The handler is a per-event workflow: `RuntimeContextSessionWorkflow`
  (`unified/subscribers/runtime-context.ts:67`) with
  `idempotencyKey: (p) => `${p.contextId}:${p.inputKey}`` (`:71`) and the input
  carried in the payload (`RuntimeContextSessionPayloadSchema.input`, `:54`). The
  body (`:74`) does `startOrAttach` (`:83`) then `send` (`:109`) or, for
  `kind: "terminal"`, `deregister` (`:94`), and returns.

At-most-once delivery is two layers: `Workflow.idempotencyKey` ⇒ one execution
per `(contextId, inputKey)`; `Activity.make` ⇒ one `adapter.send` per execution.
There is **no `SignalTable`, no mailbox, and no shared-mutable consume cursor** —
a blind-RMW cursor races (rationale
in `unified/subscribers/runtime-context.ts:23-26` and the review
`docs/reviews/2026-06-02-tf-ogoj-sdd-review.md`); per-input executions over a
payload-carried input do not. The client writes **intent over
a channel**, never runtime-owned state.

Sibling completions (permission decision, tool result) feed back the same way:
each sibling workflow's result is itself a session input, relayed by EXECUTING a
fresh per-event handler (not by signaling a parked body). The await-once
completions those siblings park on are `@effect/workflow` `DurableDeferred`s
riding the engine's `deferredResult`/`deferredDone` — a **load-bearing
primitive** of the per-event design, not a residual to GC.

---

## Schema catalog — use Effect `Schema` natively

The catalog exposes operation-shaped schema entries whose metadata lives on the
**AST annotations**, read by bindings. Lean on Effect `Schema`
(`repos/effect/packages/effect/src/Schema.ts`) instead of inventing wrappers:

- **Metadata** — `Schema.annotations`: `identifier`, `title`, `description`,
  `examples`, plus the one Firegrid custom annotation
  (`firegridProjection({ operationId, toolName?, clientName?, cliName? })`,
  `protocol/src/projection/schema.ts:15`).
- **Row → observation / id conversions** — `Schema.transform` /
  `Schema.transformOrFail`: a durable row → public observation is a *transform*,
  not a hand-written parser.
- **Narrower public views** — `Schema.pick` / `Schema.omit` / `Schema.pluck`:
  derive a public view from a richer durable/provider row instead of redefining
  it.
- **Encoded vs decoded** — `Schema.encodedSchema` / `Schema.typeSchema` for
  transport vs in-memory shapes (this is what a gRPC/REST `.proto`/OpenAPI
  generator reads).
- **Unions / tags** — `Schema.Union`, `Schema.TaggedStruct`, `Schema.TaggedClass`
  for observation/event families (e.g. `RuntimeAgentOutputObservationSchema` is a
  `Schema.Union`, `session-facade/schema.ts:276`).
- **JSON envelopes** — `Schema.parseJson` for the JSON-encoded payload envelopes.
- **Composition** — `Schema.extend` to compose without copying fields.

Each operation is a plain grouping read from the schemas — **not** a descriptor
object:

```ts
export const SessionCreateOrLoad = {
  input: SessionCreateOrLoadInputSchema,   // carries firegridProjection annotation
  output: SessionHandleReferenceSchema,
} as const
```

Bindings read names/help/examples from the schema's AST annotations (Effect's
annotation ids + `getFiregridProjectionMetadata`). They do **not** depend on a
`FiregridOperationEntry` / `defineFiregridOperation` wrapper.

> **Resolved (was open cleanup):** the transitional
> `FiregridOperationEntry` / `defineFiregridOperation` wrapper is **gone** —
> `packages/protocol/src/operations/index.ts` is now an empty compatibility
> module (`packages/protocol/src/operations/index.ts:1`), and `rg
> "defineFiregridOperation|FiregridOperationEntry" packages/protocol/src` finds
> no live wrapper definitions. The good path (annotation +
> `getFiregridProjectionMetadata`) is what `toolkit.ts`/`firegrid.ts` use.

---

## Realized bindings

| Binding | Lives in | State |
| --- | --- | --- |
| Agent-tool (MCP) | `packages/runtime/src/unified/mcp-host/toolkit.ts:168-178` (`Tool.make`/`Toolkit.make`) + `packages/runtime/src/unified/mcp-host/toolkit-layer.ts:72-78` (`ToolDispatch.call`) | router-shaped, realized |
| Client facade | `packages/client-sdk/src/firegrid.ts:285-375`, `:420-450`, `:1463-1533` | client-shaped, realized |
| Client read-side views | `packages/protocol/src/launch/views.ts:22-46` consumed by `packages/client-sdk/src/firegrid.ts:956-966`, `:993-1019`, `:1034-1040`, `:1063-1064` | caller-facing read projection realized; row-source wiring still uses protocol table Tags at composition (`packages/client-sdk/src/firegrid.ts:935-936`, `:1548-1579`) |
| Read-side observations | `packages/protocol/src/session-facade/schema.ts:276-285` (`RuntimeAgentOutputObservationSchema`, a `Schema.Union`) and `:548-551` (`runtimeAgentOutputObservationFromRow`) | realized |
| CLI | `packages/cli/src/index.ts:1-5` shell; process bins in `packages/runtime/src/bin/firegrid.ts:120-193` | client-shaped resolution; no router projection |

The agent-tool binding already follows the router-shaped target: a tool is **(a)** a
schema in `@firegrid/protocol/agent-tools`, **(b)** a `Tool.make(...)` in
`toolkit.ts` reading its name from the schema's projection annotation
(`packages/runtime/src/unified/mcp-host/toolkit.ts:169-171`), **(c)** an entry in
`Toolkit.make(...)` (`packages/runtime/src/unified/mcp-host/toolkit.ts:259`), and
**(d)** a handler that routes through `ToolDispatch.call`
(`packages/runtime/src/unified/mcp-host/toolkit-layer.ts:72-78`) — so the binding
never imports waits, host, or the workflow engine directly.

Read binding: operation schemas project into methods; observation schemas project
into snapshots, streams, and waits. No product app should ever
`JSON.parse(row.raw)` or decode `AgentOutputEventSchema` itself; it reads
`session.snapshot().agentOutputs` and `session.wait.forAgentOutput(...)`.

---

## Package-boundary graph (enforced)

```text
@firegrid/protocol           ← contract; no client/runtime imports
@firegrid/client-sdk         → protocol only (browser/app-safe)
@firegrid/host-sdk           → public host-composition surface (unified)
@firegrid/runtime            → execution substrate + runtime-owned process bins
@firegrid/cli                → package shell / terminal launcher surface
```

These are not review conventions — they are dep-cruiser rules today:
`client-sdk-no-runtime-scan`, `runtime-no-host-sdk-scan`,
`host-sdk-public-composition-surface-only-unified`, `protocol-no-client-or-runtime`,
`client-sdk-no-broad-durable-streams-root`
(`.dependency-cruiser.cjs:422-428`, `:414-419`, `:389-397`, `:443-448`,
`:487-492`). The current bin carve-out is explicit:
`runtime/src/bin/**` is a process-composition tier, not runtime substrate
importing the CLI (`.dependency-cruiser.cjs:346-354`). New transports
(REST/gRPC/JSON-RPC) join as router-shaped host/transport edges: their catalog
projection imports protocol; their ingress handler delegates to the
runtime/host execution router. They never clone schemas or import a peer
binding.

Note: there is no separate `@firegrid/agent-tools` package. The agent-tool
*schemas* live in `@firegrid/protocol/agent-tools`; the *binding* lives in the
host runtime (`runtime/src/unified/mcp-host`). The invariant that matters is the
import direction (projection ← protocol schemas; execution via the router /
`ToolDispatch` facade), not the package count or folder layout.

---

## Boundary rules

- Protocol schema/observation/channel catalog is the source of truth.
- Agent tools and client APIs are **bindings**, not the programmer contract.
- A pure projection imports protocol only. A router-shaped host/transport edge
  may import the execution router/facade; it still must not clone schemas,
  import peer bindings, or perform substrate execution outside the router.
- A binding validates and **delegates** (`router.dispatch` / channel `binding` /
  `ToolDispatch.call`); it never invents a second executor and never clones a
  schema.
- Client snapshots/waits return normalized protocol observations; the client does
  not write runtime-owned state, and its caller-facing read projection goes
  through protocol views, not table-shaped logic.
- `cliName` is reserved. Do not generate a CLI route table or describe CLI as a
  router projection unless a future SDD reactivates that metadata for a concrete
  non-router launcher use.
- Common execution is the unified host; introduce shared execution helpers only
  where bindings share identical substrate semantics.
- Do not split `@firegrid/client-sdk` into many packages; do not publish one
  package mixing browser client, Node CLI, MCP/Effect-AI tooling, and runtime.
- Do not (re)introduce a `defineFiregridOperation` / `FiregridOperationEntry`
  descriptor, nor a `Binding<T>` base class, as the contract source of truth —
  annotations + plain groupings only. Document the pattern; don't frameworkize it.

---

## Open slices (the gap between this contract and the tree)

1. Decide whether the client row-source wiring should stay as protocol table Tags
   (`packages/client-sdk/src/firegrid.ts:935-936`, `:1548-1579`) or move to a
   narrower browser-safe row-source capability. The caller-facing projection leak
   is closed by protocol views (`packages/protocol/src/launch/views.ts:22-46`);
   this remaining item is composition/source ownership, not route projection.
2. Express any remaining row→observation and id conversions as
   `Schema.transform` projections where still hand-written. The main
   agent-output path is already schema-backed via
   `RuntimeAgentOutputObservationFromRowSchema`
   (`packages/protocol/src/session-facade/schema.ts:540-551`).
3. Tidy the historical `signal.ts` vocabulary still in comments
   (`SignalTable` / `writeSessionInputSignal` / `readSignalsFor` mentions in
   `packages/runtime/src/unified/channel-bindings.ts:99`, `:226`, `:450`;
   `packages/runtime/src/unified/subscribers/runtime-context.ts:4`;
   `packages/runtime/src/unified/observers.ts:30`) so a reader doesn't mistake
   retired names for live primitives. (`signal.ts` itself is already deleted;
   this is comment hygiene, not code.)

Each is independently shippable; none requires a "transactional, all bindings at
once" cutover, because the binding/execution split already exists.

**Resolved since the prior revision:** the `defineFiregridOperation` /
`FiregridOperationEntry` removal (`packages/protocol/src/operations/index.ts:1`),
the caller-facing client read projection now using protocol views
(`packages/client-sdk/src/firegrid.ts:956-966`, `:993-1019`, `:1034-1040`,
`:1063-1064`), the `cliName` route-projection framing, and the
`RuntimeIngressTable` deletion. `DurableDeferred` is no longer a residual to GC —
it is the await-once relay primitive of the per-event design.
