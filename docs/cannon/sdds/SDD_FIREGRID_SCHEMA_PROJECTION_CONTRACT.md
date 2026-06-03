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

## Mental model (unchanged — this is the durable part)

```txt
protocol operation/observation/channel catalog        ← the product contract
  → bindings  (project the same contract to each surface)
       → agent-tool binding   (Effect AI Tool/Toolkit over MCP)
       → client-sdk binding   (browser/app-safe TypeScript)
       → CLI binding          (@effect/cli)
       → future REST / gRPC / JSON-RPC
  → dispatch seam  (RuntimeChannelRouter / HostPlaneChannelRouter / ToolDispatch)
  → execution      (channel-binding Lives → per-event RuntimeContext handler)
```

The schema/channel catalog in `@firegrid/protocol` is the source of truth.
Tools, client APIs, the CLI, and future transports are **bindings** of that
catalog. Bindings may differ in names and transport; they must not define
different contracts. Execution is owned by the unified host, not by any binding.

This is deliberately **not** "agent tools → client API", "client API → agent
tools", or "a new service layer → everything." Every user-facing operation has
**one** schema-owned definition; each binding projects from it.

---

## What a binding is

> **A binding is a projection of the protocol catalog onto one transport: it
> reads the operation/observation/channel schemas (and their projection
> metadata) and exposes them as that transport's surface — and nothing else.**

The contract a binding must satisfy:

- **Imports `@firegrid/protocol` only.** Never a peer binding, never runtime
  internals (waits/host/engine/durable tables).
- **Never executes.** It validates against the schema and *delegates* through the
  dispatch seam (`router.dispatch({ target, verb, payload })`, a channel Tag's
  `binding.call`/`binding.append`, or `ToolDispatch.call`). It does not perform
  substrate effects.
- **Never clones a schema.** Names/help/examples come from the schema's
  annotations (`getFiregridProjectionMetadata`, `packages/protocol/src/projection/schema.ts:21`);
  request/response shapes come from the schema itself. A binding never redefines
  a contract field.
- **Projects responses back through the schema.** Rows → public observations are
  `Schema.transform`/decoders owned by protocol (e.g.
  `runtimeAgentOutputObservationFromRow`, `packages/protocol/src/session-facade/schema.ts:455`),
  never `JSON.parse(row.raw)` in the binding.

**The invariant that matters is IMPORT DIRECTION, not a folder taxonomy.**
binding ← protocol schemas; execution ← the router/`ToolDispatch`. There is no
`Binding<T>` base class, no `defineBinding` descriptor, and no required package
layout. A file is a binding iff it depends only on protocol schemas and
delegates; it is execution iff it performs effects. (The same rule forbids a
`defineFiregridOperation` descriptor as the contract source of truth — see
Boundary rules.)

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
   ┌─────────────────────────────  BINDINGS (project; import protocol only)  ──────────────────┐
   │  agent-tool  toolkit.ts      client  firegrid.ts      CLI  (per CLI SDD)   gRPC/REST (TODO) │
   └───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                │  delegate (never execute)
                                                ▼
   ┌──────────────────────────  DISPATCH SEAM (runtime)  ──────────────────────────────────────┐
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
| **`firegridProjection` metadata** | The one Firegrid custom annotation carrying per-surface names: `{ operationId, toolName?, clientName?, cliName? }`. Read with `getFiregridProjectionMetadata`. | `protocol/src/projection/schema.ts:4` (type), `:15` (`firegridProjection`), `:21` (`getFiregridProjectionMetadata`); applied via `toolAnnotations` `agent-tools/schema.ts:79` | Only **input** schemas carry it (`agent-tools/schema.ts:79`). A binding reads it; never invents one. |
| **Channel TARGET** | A typed, branded string address for a route (e.g. `host.prompt`, `session.prompt`, `session.cancel`). | `protocol/src/channels/core.ts:24` (`makeChannelTarget`); e.g. `host-control.ts:64/73/84/106/115/137` | Stable address. The dispatch key. |
| **Channel VERB** | The action over a target: `send` \| `wait_for` \| `call`. Verbs are derived from direction. | `protocol/src/channels/router.ts:11` (`ChannelRouteVerbSchema`), `:20` (`channelRouteVerbsForDirection`) | egress→`send`, ingress→`wait_for`, call→`call`, bidirectional→`send`+`wait_for`. |
| **Channel KIND** | The shape of a route (see table below). | `protocol/src/channels/core.ts:99/110/121/139/303` | Determines the binding (stream/append/call) and the legal verbs. |
| **`RuntimeChannelRouter` / `HostPlaneChannelRouter`** | The dispatch seam: `Context.Tag`s exposing `dispatch({ target, verb, payload })`. Decode-then-invoke a registered route. | `runtime/src/channels/router.ts:79` / `:87` (Tags), `:70` (`dispatch`), `:126` (`makeRuntimeChannelRouter`), `:224` (`runtimeRouteFromChannel`) | Runtime-owned. The single place a validated call becomes a route invocation. |
| **Channel-binding Lives** | The execution-side `Layer`s backing each target. Post-#863 they EXECUTE a fresh per-event RuntimeContext handler — no `signal.ts`. | `runtime/src/unified/channel-bindings.ts:103` (`executeSessionInput`), `:307`/`:333`/`:361` (Signaling Lives), `:452` (`UnifiedSignalingChannelBindingsLive`) | Runtime-owned execution. Bindings never import these. |
| **`ToolDispatch`** | The agent-tool facade: `ToolDispatch.call({contextId, toolUseId, toolName, input})` → the MCP dispatch workflow. | `runtime/src/unified/mcp-host/tool-dispatch.ts:789` (Tag), `:777` (`call` sig), `:817` (`call`→`McpToolDispatchWorkflow.execute`) | The agent-tool binding's only execution dependency. |

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

## How to create a binding to ANY platform

The recipe is identical for MCP, CLI, TS-API, gRPC, and REST. Only step (iii)
differs in surface idiom.

1. **Depend on `@firegrid/protocol` only.** No runtime, no host-sdk, no peer
   binding. (Enforced by dep-cruiser — see Package-boundary graph.)

2. **For each operation, read its schema + projection metadata.** Get the
   input/output (or request/response) schema from the catalog, and call
   `getFiregridProjectionMetadata(schema)` (`projection/schema.ts:21`) for the
   transport-specific name. Use `toolName` for MCP, `clientName` for the client,
   `cliName` for the CLI, `operationId` as the stable fallback. *Only* add a new
   projection field (e.g. `grpcName`) to `FiregridProjectionMetadata`
   (`projection/schema.ts:4`) if a distinct name is genuinely needed — otherwise
   reuse `operationId`.

3. **Project the schema onto the transport surface.** Map the input schema to the
   transport's parameter shape and the output schema to its result shape:
   - MCP: `Tool.make(name, ...).setParameters(input).setSuccess(output)`
   - client: a typed method whose args/return are `Schema.Type<input/output>`
   - CLI: an `@effect/cli` `Command`/`Options` decoded against the input schema
   - gRPC/REST: a service method / route whose body decodes to the input schema

4. **On a validated call, DELEGATE through the dispatch seam.** Never execute.
   - generic routes: `router.dispatch({ target, verb, payload })`
     (`runtime/src/channels/router.ts:70`) — `verb` is `send`/`wait_for`/`call`
     per the channel kind.
   - agent tools: `ToolDispatch.call({ contextId, toolUseId, toolName, input })`
     (`mcp-host/tool-dispatch.ts:777`).
   - client: resolve the protocol channel `Tag` at composition time and invoke
     its `binding.append(...)` / `binding.call(...)`.

5. **Project the response/observation back through the schema.** Decode the
   dispatch result against the route's response schema; express row → observation
   as a `Schema.transform`/protocol decoder
   (`runtimeAgentOutputObservationFromRow`, `session-facade/schema.ts:455`).
   Never `JSON.parse(row.raw)` and never decode `AgentOutputEventSchema` inside a
   binding.

### Worked example — MCP (realized)

`runtime/src/unified/mcp-host/toolkit.ts` realizes the recipe verbatim:

- step 2: `const metadata = Option.getOrThrow(getFiregridProjectionMetadata(group.input))`
  (`toolkit.ts:169`); `const toolName = metadata.toolName ?? metadata.operationId`
  (`toolkit.ts:170`).
- step 3: `Tool.make(toolName, ...).setParameters(group.input).setSuccess(group.output).setFailure(...)`
  (`toolkit.ts:171`); collected into `FiregridAgentToolkit = Toolkit.make(...)`
  (`toolkit.ts:259`).
- step 4: the toolkit handler resolves `ToolDispatch` and calls
  `dispatch.call({ contextId, toolUseId, toolName, input })`
  (`toolkit-layer.ts:72`); `ToolDispatch.call` runs `McpToolDispatchWorkflow.execute(...)`
  (`tool-dispatch.ts:817`), whose body dispatches each tool through
  `router.dispatch({ target, verb, payload })` (`tool-dispatch.ts:174`).

The `Tool`/`Toolkit` values import only protocol schemas + the `ToolDispatch`
tag — no waits, host, or engine (verified: `toolkit.ts`/`toolkit-layer.ts` import
nothing from `/engine`/`/host`).

### Worked example — client (realized)

`client-sdk/src/firegrid.ts` projects the session-facade catalog into the client
facade. It is browser-safe (protocol-only imports, enforced by
`client-sdk-no-runtime`).

- step 2: `const metadata = Option.getOrThrow(getFiregridProjectionMetadata(operation.input))`
  (`firegrid.ts:432`), reading `operationId`/`clientName` (`:434`).
- step 3/4: writes resolve a protocol channel `Tag` and invoke its binding —
  e.g. `session.start()` → `hostSessionsStartChannel.binding.append({ sessionId })`
  (`firegrid.ts:1359`); `session.prompt` → `sessionPromptChannel.forSession(sessionId).binding.append(...)`
  (`firegrid.ts:1189`); `sessions.cancel` → `sessionCancelChannel.binding.append(...)`
  (`firegrid.ts:1209`); `permissions.respond` → `hostPermissionRespondChannel.binding.append(...)`
  (`firegrid.ts:1503`).
- step 5: reads project rows → observations via
  `runtimeAgentOutputObservationFromRow` (`firegrid.ts:909`, `:1044`).

> **Open boundary gap (tf-ll90.8.3):** the read path still resolves
> `RuntimeControlPlaneTable` + `RuntimeOutputTable` directly
> (`firegrid.ts:933-934`). That is a durable-table *facade* used as the caller
> path, which this contract forbids. Writes already dispatch through
> protocol-owned channels; the read path should likewise route through a
> protocol-owned read capability/observation source rather than the table tags.
> (`runtimeAgentOutputObservationFromRow` is also a hand-written `_tag` switch at
> `session-facade/schema.ts:455`; express it as a `Schema.transform`.)

### Worked example — CLI (per the CLI SDD)

The CLI launchers were deleted in #765 and are being rebuilt — see
`docs/sdds/SDD_FIREGRID_CLI_LAUNCHERS.md`. This contract adds one rule: the CLI's
*binding* half (`@effect/cli` `Command`/`Options`, help, examples, defaults,
validation) projects from the schema catalog and the `cliName` projection field
(already present on the agent-tool input schemas, e.g.
`agent-tools/schema.ts:480` `SessionNewToolInputSchema` carries
`cliName: "sessions create"`); the *execution* half (Node, embedded
durable-streams, host composition, MCP startup) stays runtime-side and delegates
through the router. A binding file serializes schemas; an execution file performs
effects; no file does both.

### Worked example — gRPC / REST (the same recipe, sketched)

A new transport joins as a projection package importing **protocol only**:

1. depend on `@firegrid/protocol`.
2. for each service method, read its schema and (if a distinct name is needed)
   add `grpcName?`/`restName?` to `FiregridProjectionMetadata`
   (`projection/schema.ts:4`); otherwise reuse `operationId`.
3. generate the `.proto` service / OpenAPI route from the encoded schema
   (`Schema.encodedSchema`) — the wire shape is the schema's encoded form.
4. on a validated request, call `router.dispatch({ target, verb, payload })`
   (`runtime/src/channels/router.ts:70`) with the channel's target + the verb its
   kind permits (`send` for a `DurableEventChannel`, `wait_for` for ingress,
   `call` for a `CallableChannel`).
5. encode the dispatch result/observation back through the response schema.

No new dispatch machinery is required — the router already decodes the payload
against the route's `inputSchema` (`router.ts:170`) and rejects unsupported verbs
(`router.ts:163`), so a transport gets validation + routing for free.

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
> `protocol/src/operations/schema.ts` is now a 6-line re-export of
> `projection/schema.ts` (`operations/schema.ts:1-6`); zero callers of the
> wrapper remain. The good path (annotation + `getFiregridProjectionMetadata`) is
> what `toolkit.ts`/`firegrid.ts` use.

---

## Realized bindings

| Binding | Lives in | State |
| --- | --- | --- |
| Agent-tool (MCP) | `runtime/src/unified/mcp-host/toolkit.ts` (`Tool.make`/`Toolkit.make` → `ToolDispatch.call`) | realized ✓ |
| Client | `client-sdk/src/firegrid.ts` | realized; one read-path leak open (above) |
| Read-side observations | `protocol/src/session-facade/schema.ts:276` (`RuntimeAgentOutputObservationSchema`, a `Schema.Union`) | realized ✓ |
| CLI | rebuilding — `docs/sdds/SDD_FIREGRID_CLI_LAUNCHERS.md` | pending |

The agent-tool binding already follows the target shape: a tool is **(a)** a
schema in `@firegrid/protocol/agent-tools`, **(b)** a `Tool.make(...)` in
`toolkit.ts` reading its name from the schema's projection annotation
(`toolkit.ts:169-171`), **(c)** an entry in `Toolkit.make(...)`
(`toolkit.ts:259`), and **(d)** a handler that routes through `ToolDispatch.call`
(`toolkit-layer.ts:72`) — so the binding never imports waits, host, or the
workflow engine directly.

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
@firegrid/runtime            → execution substrate; not a binding
@firegrid/cli                → thin tsx launcher (see CLI SDD)
```

These are not review conventions — they are dep-cruiser rules today:
`client-sdk-no-runtime-scan`, `runtime-no-host-sdk-scan`,
`host-sdk-public-composition-surface-only-unified`, `protocol-no-client-or-runtime`,
`client-sdk-no-broad-durable-streams-root` (`.dependency-cruiser.cjs`). New
transports (REST/gRPC/JSON-RPC) join as projection packages that import
**protocol only** and delegate execution to host/runtime composition — they never
clone schemas or import a peer binding.

Note: there is no separate `@firegrid/agent-tools` package. The agent-tool
*schemas* live in `@firegrid/protocol/agent-tools`; the *binding* lives in the
host runtime (`runtime/src/unified/mcp-host`). The invariant that matters is the
import direction (binding ← protocol schemas; execution via the router /
`ToolDispatch`), not the package count or folder layout.

---

## Boundary rules

- Protocol schema/observation/channel catalog is the source of truth.
- Agent tools and client APIs are **bindings**, not the programmer contract.
- A binding imports protocol only — not runtime, not a peer binding (dep-cruiser).
- A binding validates and **delegates** (`router.dispatch` / channel `binding` /
  `ToolDispatch.call`); it never performs substrate effects and never clones a
  schema.
- Client snapshots/waits return normalized protocol observations; the client does
  not write runtime-owned state, nor read durable-table facades, as its
  caller-facing path.
- Common execution is the unified host; introduce shared execution helpers only
  where bindings share identical substrate semantics.
- Do not split `@firegrid/client-sdk` into many packages; do not publish one
  package mixing browser client, Node CLI, MCP/Effect-AI tooling, and runtime.
- Do not (re)introduce a `defineFiregridOperation` / `FiregridOperationEntry`
  descriptor, nor a `Binding<T>` base class, as the contract source of truth —
  annotations + plain groupings only. Document the pattern; don't frameworkize it.

---

## Open slices (the gap between this contract and the tree)

1. Close the client read-path leak (tf-ll90.8.3): route reads through a
   protocol-owned read capability/observation source, not `RuntimeControlPlaneTable`
   / `RuntimeOutputTable` (`client-sdk/src/firegrid.ts:933-934`).
2. Rebuild the CLI binding per the CLI SDD, projecting flags/help from the
   `cliName` projection metadata.
3. Express row→observation and id conversions as `Schema.transform` projections
   where hand-written (e.g. `runtimeAgentOutputObservationFromRow`,
   `protocol/src/session-facade/schema.ts:455`).
4. Tidy the historical `signal.ts` vocabulary still in comments
   (`SignalTable` / `writeSessionInputSignal` / `readSignalsFor` mentions in
   `unified/channel-bindings.ts`, `unified/subscribers/runtime-context.ts`,
   `unified/observers.ts`) so a reader doesn't mistake retired names for live
   primitives. (`signal.ts` itself is already deleted; this is comment hygiene,
   not code.)

Each is independently shippable; none requires a "transactional, all bindings at
once" cutover, because the binding/execution split already exists.

**Resolved since the prior revision:** the `defineFiregridOperation` /
`FiregridOperationEntry` removal (now a re-export shim, `operations/schema.ts`)
and the `RuntimeIngressTable` deletion. `DurableDeferred` is no longer a residual
to GC — it is the await-once relay primitive of the per-event design.
