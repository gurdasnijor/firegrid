# Typed Boundaries: Statically Visible Dataflow Graph

Doc-Class: dispatchable
Status: active
Date: 2026-05-22
Owner: Firegrid Architecture

Extends:

- `docs/cannon/architecture/runtime-design-constraints.md`
- `docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`
- `docs/sdds/SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/`

This is the type-boundary companion to
`docs/cannon/architecture/runtime-design-constraints.md`. The constraints doc
states the canonical runtime shape:

```text
events -> DurableTable(events) -> transforms(rows) -> keyed subscribers(rows)
```

This document maps that shape onto current Firegrid Effect services. The goal
is that a host configuration's pipeline is a value whose Effect requirements
channel (`R`) makes the topology visible at compile time. Incorrect shapes
should either fail to typecheck, or show up as explicit review-visible
topology changes.

Almost no new types are introduced. The work is naming what already exists and
adopting conventions that make polarity, ownership, and workflow machinery
visible in type signatures.

## The Existing Types

| Concern | Existing type | Where it lives |
|---|---|---|
| Durable state of record | `DurableTable("name", { schemas })` | `effect-durable-operators` |
| Runtime output rows | `RuntimeEventRow` | `@firegrid/protocol/launch` |
| Runtime input rows | `RuntimeIngressInputRow` | `@firegrid/protocol/runtime-ingress` |
| Typed output observation | `RuntimeAgentOutputAfterEvents` (`initial` / `after` / `forContext`) | `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts` |
| Live agent boundary | `AgentSession` (`send`, `outputs`) | `packages/runtime/src/agent-event-pipeline/codecs/contract.ts` |
| Live byte boundary | `AgentByteStream` | `packages/runtime/src/agent-event-pipeline/sources/byte-stream.ts` |
| RuntimeContext state store | `RuntimeContextStateStore` (`load` / `save` / `nextOutput`) | `packages/runtime/src/tables/runtime-context-state.ts` |
| Pure RuntimeContext transitions | `transitionInputEvent`, `transitionOutputEvent` | `packages/runtime/src/workflow-engine/workflows/runtime-context.ts` |
| Pure wait trigger | `evaluateFieldEquals`, `FieldEqualsTrigger` | `packages/runtime/src/workflow-engine/workflows/field-equals.ts` |
| Pure input decode | `agentInputEventFromRuntimeIngressRow` | `packages/runtime/src/workflow-engine/workflows/runtime-ingress-transform.ts` |
| Workflow machinery | `Workflow.make`, `Activity.make`, `DurableDeferred`, `DurableClock` | `@effect/workflow` |
| Workflow surfaces | `RuntimeContextWorkflowNative`, `ToolCallWorkflow`, `WaitForWorkflow`, `ScheduledPromptWorkflow` | `packages/runtime/src/workflow-engine/workflows/` |
| Channel capability contracts | `IngressChannel`, `EgressChannel`, `CallableChannel`, `BidirectionalChannel` | `packages/protocol/src/channels/core.ts` |
| Channel target identity | `ChannelTarget` | `packages/protocol/src/channels/core.ts` |
| Channel service handles | per-channel `Context.Tag` services, for example `SessionAgentOutputChannel` | `packages/protocol/src/channels/*.ts` |
| Wire-edge dispatch | `HostPlaneChannelRouter`, `RuntimeChannelRouter` | `packages/runtime/src/channels/router.ts` |
| Completion contract | `ChannelRouteCompletion` | `packages/protocol/src/channels/core.ts` |
| Capability tags | `Context.Tag` | Effect |

The graph is expressed with these types and ordinary Effect composition:
`Effect`, `Stream`, `Layer`, requirements channels, `Context.Tag`, and
`DurableTable` rows.

## The Pipeline With Concrete Edges

```text
AgentSession.outputs
  :: Stream.Stream<AgentOutputEvent, AgentCodecError>

    appendAgentEvent
      (RuntimeContext, attempt, seq, AgentOutputEvent)
      -> Effect.Effect<RuntimeEventRow, unknown, RuntimeOutputTable>

RuntimeOutputTable.events
  :: durable rows of RuntimeEventRow

RuntimeAgentOutputAfterEvents
  :: initial(src) -> Effect.Effect<Option<RuntimeAgentOutputObservation>, unknown>
  :: after(src)   -> Stream.Stream<RuntimeAgentOutputObservation, unknown>

pure transforms
  :: row -> decoded row / trigger match / transition result

per-event subscriber
  :: Effect.Effect<A, E, R>
     where R names exactly which capabilities the subscriber needs

side effects
  :: DurableTable upsert
  :: EgressChannel.binding.append
  :: CallableChannel.binding.call
  :: AgentSession.send
  :: Workflow.execute / Activity.make, when workflow machinery is justified
```

Every arrow above is an existing Effect type. Every node is an existing
service, table, channel, transform, or workflow surface.

## Static Enforcement Boundary

The `R` channel is the type-system signature of the boundary:

- if `R` only contains a typed observation source, the component is a consumer
  or projection;
- if `R` contains a durable state store, the component owns state for a key;
- if `R` contains `WorkflowEngine` / `WorkflowInstance`, the component is a
  workflow-shaped subscriber and must justify which workflow capability is
  load-bearing;
- if `R` contains only transport/session capabilities, the component is at the
  codec or edge boundary;
- if `R` contains channel tags, it declares which wire-edge substrate
  capabilities the component touches.

The type system catches missing capability wiring. For example, a plain
subscriber that calls `Activity.make` grows a `WorkflowEngine` requirement in
`R`; if its layer does not provide workflow machinery, the composition fails to
typecheck. A component that reads a channel tag not in scope also fails to
typecheck.

The type system does not fully prove single-writer ownership or feedback-cycle
safety today. Those are review-enforced by the checklist below and can become
future drift guards.

## Four Subscriber Shapes

A subscriber's `R` channel declares what kind of subscriber it is.

### Shape A: Codec-Bound

```ts
R = IdGenerator | Scope | transport/session tags
```

Scoped and live. No durable plane, no owned runtime state. Used for
byte/protocol work.

Existing examples:

- `AcpSessionLive`
- `StdioJsonlSessionLive`
- `LocalProcessSandboxProvider.layer()`

Current boundary types:

```ts
interface AgentByteStream {
  readonly stdin: WritableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exit: Effect.Effect<
    { readonly exitCode?: number; readonly signal?: string },
    unknown
  >
}

interface SandboxProviderService {
  readonly openBytePipe: (
    sandbox: Sandbox,
    command: SandboxCommand,
  ) => Effect.Effect<AgentByteStream, SandboxProviderError, Scope.Scope>
}

interface AgentSessionService {
  readonly meta: AgentCodecMeta
  readonly toolUseMode: AgentToolUseMode
  readonly send: (event: AgentInputEvent) => Effect.Effect<void, AgentCodecError>
  readonly outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>
}

const AcpSessionLive:
  (bytes: AgentByteStream, options?: AcpSessionOptions) =>
    Layer.Layer<AgentSession, AgentCodecError, IdGenerator.IdGenerator>
```

If a codec-only fixture requires `DurableTable`, RuntimeContext state, workflow
machinery, or output-journal services, it has crossed the Shape A boundary.

### Shape B: Projection

```ts
R = typed source tags | IngressChannel-shaped tags
```

Read-only consumer of durable rows. Owns no state and writes nothing. Used for
projections, UI reads, and typed observation consumers.

Existing examples:

- Consumers of `RuntimeAgentOutputAfterEvents`
- Consumers of `SessionAgentOutputChannel.forContext(...).binding.stream`

Current boundary types:

```ts
interface RuntimeAgentOutputAfterEventsService {
  readonly initial: (
    source: AgentOutputAfterSource,
  ) => Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown>

  readonly after: (
    source: AgentOutputAfterSource,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>

  readonly forContext: (
    contextId: string,
  ) => Stream.Stream<RuntimeAgentOutputObservation, unknown>
}

const projectionConsumer:
  Effect.Effect<void, unknown, RuntimeAgentOutputAfterEvents>
```

`initial(source)` is the snapshot read at the source cursor.
`after(source)` is the tail subscription strictly after that cursor. Together
they are the C6 boundary: typed source + cursor + optional match.

### Shape C: Stateful Keyed Subscriber, No Workflow Machinery

```ts
R =
  | state store tag
  | read-side channel / typed source tags
  | write-side channel tags
  | narrow live-dispatch capability tags
```

Owns durable state for one key kind. Pure transition functions operate over
events. Action dispatch goes through channel tags or narrow capability tags.
No `WorkflowEngine` appears in `R`.

Target RuntimeContext shape for `tf-tvg1`: a per-event subscriber keyed by
`contextId`, with durable state in `RuntimeContextStateStore`.

Current boundary types:

```ts
interface RuntimeContextStateStoreService {
  readonly load: (
    context: RuntimeContext,
    activityAttempt: number,
  ) => Effect.Effect<RuntimeContextEventState, unknown>

  readonly save: (
    context: RuntimeContext,
    activityAttempt: number,
    state: RuntimeContextEventState,
  ) => Effect.Effect<void, unknown>

  readonly nextOutput: (
    context: RuntimeContext,
    activityAttempt: number,
    afterSequence: number,
  ) => Effect.Effect<Option.Option<RuntimeAgentOutputObservation>, unknown>
}

const transitionInputEvent:
  (
    state: RuntimeContextEventState,
    row: RuntimeIngressInputRow,
    event: AgentInputEvent,
  ) => RuntimeContextTransitionResult

const transitionOutputEvent:
  (
    context: RuntimeContext,
    state: RuntimeContextEventState,
    output: RuntimeAgentOutputObservation,
  ) => RuntimeContextTransitionResult

type RuntimeContextTargetEvent =
  | { readonly _tag: "Input"; readonly event: RuntimeIngressInputRow }
  | { readonly _tag: "Output"; readonly event: RuntimeAgentOutputObservation }
  | { readonly _tag: "ToolResult"; readonly event: Extract<AgentInputEvent, { _tag: "ToolResult" }> }

const handleRuntimeContextEvent:
  (
    context: RuntimeContext,
    event: RuntimeContextTargetEvent,
  ) => Effect.Effect<
    void,
    RuntimeContextError,
    | RuntimeContextStateStore
    | AgentSession
    | RuntimeToolUseExecutor
  >
```

The transition functions are pure. The handler is not required to be pure; it
performs load/save and action dispatch. The target rule is that the handler's
lifetime is one event. It must not be a body that spans the RuntimeContext
entity lifetime, waits for the next unrelated event, or reconstructs progress
by scanning history.

### Shape D: Workflow-Shaped Subscriber

```ts
R =
  | state store / executor tags
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
```

Earns workflow execution machinery: `Activity.make`, `DurableDeferred`,
`DurableClock`, or workflow execution identity. The presence of
`WorkflowEngine` in `R` is the visible signal. The SDD gate in
`runtime-design-constraints.md` requires a workflow-machinery justification.

Existing examples:

- `ToolCallWorkflow`
- `WaitForWorkflow`
- `ScheduledPromptWorkflow`

Current tool-call boundary:

```ts
const ToolCallWorkflowPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  toolUseId: Schema.String,
  toolName: Schema.String,
  input: Schema.Unknown,
})

const ToolCallWorkflow = Workflow.make({
  name: "firegrid.agent-tool-call",
  payload: ToolCallWorkflowPayloadSchema,
  success: ToolResultEventSchema,
  idempotencyKey: ({ toolUseId }) => toolUseId,
})

const RuntimeToolCallWorkflowLayer =
  ToolCallWorkflow.toLayer(({ contextId, toolUseId, toolName, input }) =>
    Effect.Effect<
      Extract<AgentInputEvent, { _tag: "ToolResult" }>,
      never,
      RuntimeToolUseExecutor
    >
  )
```

The workflow machinery is justified by the `toolUseId` result identity and the
need to avoid re-running the external tool effect after a crash. The payload is
one tool call, not the lifetime of a RuntimeContext.

## Channels As The Wire-Edge Capability Boundary

Channels are typed capability contracts between Firegrid's durable substrate
and the wire boundary: ACP, MCP, CLI, HTTP, and agent-tool projections. The
existing types already encode this; this section names how they fit in the
dataflow graph.

From `packages/protocol/src/channels/core.ts`:

```ts
type ChannelRegistration =
  | IngressChannel<S>
  | EgressChannel<S, Receipt>
  | CallableChannel<Req, Res>
  | BidirectionalChannel<S>
```

Each registration carries:

- a branded `ChannelTarget`;
- direction-specific schema(s);
- optional `ChannelRouteCompletion`;
- a binding that is the concrete Effect capability.

The four directions map to the four router verbs:

| Direction | Binding | Verb |
|---|---|---|
| `ingress` | `TypedStreamBinding` (`Stream`) | `wait_for` |
| `egress` | `AppendTargetBinding` (`append` Effect) | `send` |
| `call` | `CallTargetBinding` (`call` Effect) | `call` |
| `bidirectional` | stream + append | `send` + `wait_for` |

Invalid direction/verb pairs are rejected by the router with
`ChannelRouteVerbNotSupported`, and the typed binding shape prevents in-process
code from reading an egress-only channel or appending to an ingress-only
channel.

Channels are not a fifth subscriber shape. They are the typed handles
subscribers use to interact with wire-edge substrate capabilities:

| Subscriber `R` mentions | Direction | Meaning |
|---|---|---|
| `IngressChannel` service | `ingress` | read-side source; Shape B or read side of Shape C |
| `EgressChannel` service | `egress` | write-side action dispatch; producer side of Shape C |
| `CallableChannel` service | `call` | durable handshake; often backed by Shape D |
| `BidirectionalChannel` service | both | read/write through one channel; use sparingly |

`HostPlaneChannelRouter` and `RuntimeChannelRouter` own the wire edge. They
decode untyped wire payloads, resolve `(target, verb)` to a route, check
direction/verb compatibility, invoke the binding, and emit consistent
`firegrid.channel.dispatch` spans.

The router does not own substrate behavior. It is the projection of typed
channel registrations into a string-keyed dispatch surface. In-process code
uses typed channel `Context.Tag`s directly; ACP/MCP/CLI/HTTP edges go through
`router.dispatch`.

`ChannelRouteCompletion` is where C3/C4 become route metadata:

- `acknowledgement`: the dispatch result is an immediate append/identity
  receipt;
- `terminal`: the dispatch result is terminal completion evidence, decoded by
  the route's `receiptSchema`.

Completion mode is route-owned, not caller-flagged. If a `CallableChannel`
declares `terminal`, the SDD must name the durable evidence that backs that
terminal completion.

Factory-keyed channels are the per-key channel shape. For example,
`SessionAgentOutputChannel.forContext(contextId)` returns the per-context
`IngressChannel`, and `runtimeRouteFromFactoryIngressChannel` projects that
factory into a router route whose input schema carries the key.

## Layer Composition Is The Topology Declaration

The host's dataflow graph is the `Layer` composition that produces the root
effect. The layer graph is the topology declaration.

```ts
const HostLive = Layer.mergeAll(
  // Shape A: live/scoped producer boundary
  LocalProcessSandboxProvider.layer(),
  AcpSessionLive(bytes, opts),

  // Durable substrate
  RuntimeOutputTable.layer(config),
  RuntimeControlPlaneTable.layer(config),
  RuntimeContextStateStoreLive,

  // Channel capability handles and wire-edge router
  RuntimeHostControlChannelsLive,
  SessionAgentOutputChannelLive,
  SessionPermissionChannelLive,
  HostPlaneChannelRouterLive(routes),

  // Shape D subscribers
  RuntimeToolCallWorkflowLayer,
  WaitForWorkflowLayer,
  ScheduledPromptWorkflowLayer,

  // Shape C target subscriber
  RuntimeContextSubscriberLive,

  // Workflow substrate, only because Shape D subscribers exist
  DurableStreamsWorkflowEngineLayer,
)
```

This composition statically catches missing requirements. If
`RuntimeContextSubscriberLive` needs `RuntimeContextStateStore` and no layer
provides it, the composition fails. If a Shape C subscriber accidentally uses
`Activity.make`, its `R` grows to include workflow machinery; that is a visible
scope change at the layer boundary.

Single-owner and cycle constraints are not fully typechecked today. They are
review-enforced by the checklist below and are good future CI drift-guard
candidates.

## Polarity Rule

Channel types already encode polarity:

- `IngressChannel` means read;
- `EgressChannel` means write;
- `CallableChannel` means handshake;
- `BidirectionalChannel` means both.

For non-channel capability tags that wrap `DurableTable` reads and writes, use
the same polarity convention in names:

```ts
export class RuntimeAgentOutputRead extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputRead",
)<RuntimeAgentOutputRead, RuntimeAgentOutputAfterEventsService>() {}

export class RuntimeAgentOutputWrite extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputWrite",
)<RuntimeAgentOutputWrite, PerContextRuntimeOutputWriterService>() {}
```

This is already roughly how `RuntimeAgentOutputAfterEvents` and
`PerContextRuntimeOutputWriterService` split today. The convention makes the
split explicit: if a subscriber's `R` mentions a `*Write` tag or an
`EgressChannel`, it is an authority for that table or edge. If it only mentions
`*Read` or `IngressChannel`, it is an observer.

Channel tags do not need suffixes; their direction is in the type.

## Current Code Mapping

| Current code | Shape | Why |
|---|---|---|
| `AcpSessionLive`, `StdioJsonlSessionLive` | A | scoped live transport |
| `LocalProcessSandboxProvider.layer()` | A | scoped live process |
| `PerContextRuntimeOutputWriter` | producer / write side | appends rows to `RuntimeOutputTable.events` |
| `RuntimeAgentOutputAfterEvents` consumer | B | read-only typed source |
| `RuntimeContextWorkflowNative` today | D, wrong shape | workflow body is entity-lifetime, not per-event |
| `RuntimeContextWorkflowNative` target | C | per-event handler, state in `RuntimeContextStateStore`, no `WorkflowEngine` requirement unless `tf-tvg1` proves one load-bearing |
| `ToolCallWorkflow` | D, correct shape | per-`toolUseId`, at-most-once tool execution |
| `WaitForWorkflow` | D, correct shape | per-wait-key, Activity races sources |
| `ScheduledPromptWorkflow` | D, correct shape | per-schedule-id, durable clock |
| `transitionInputEvent`, `transitionOutputEvent` | transform | pure RuntimeContext transitions |
| `evaluateFieldEquals` | transform | pure trigger evaluation |
| `agentInputEventFromRuntimeIngressRow` | transform | pure decode |
| `RuntimeContextStateStore` | Shape C state store | durable keyed RuntimeContext state |
| `SessionAgentOutputChannel` | ingress channel factory | per-context typed output observation |
| `HostPromptChannel` | egress channel | write-side prompt dispatch |
| `HostPermissionRespondChannel` | callable channel | durable request/response |
| `HostPlaneChannelRouter`, `RuntimeChannelRouter` | wire-edge projection | string-keyed dispatch over typed routes |
| `ChannelRouteCompletion` | C3/C4 route metadata | acknowledgement vs terminal evidence |

The runtime shrink is small in role terms: one wrong-shape D
(`RuntimeContextWorkflowNative` as a context-lifetime body) becomes a Shape C
subscriber. Correctly-shaped D subscribers stay. Transforms, projection
consumers, channels, and routers already match this document's shape.

## Physical Tree Guidance

The runtime directory tree should make the dataflow readable without opening
implementation files. Target-shaped production code should converge toward
role-named folders:

```text
packages/runtime/src/
  events/        runtime-facing event vocabulary and protocol re-exports
  tables/        durable table/state-store bindings owned by runtime
  producers/     codec-bound sources and authority-owned event writers
  transforms/    pure row/event transforms; no Effect environment
  channels/      runtime channel implementations, routes, and routers
  subscribers/   Shape B/C/D subscribers, with the shape visible in the path
  composition/   root Layer composition and topology checks
  legacy/        temporary wrong-shape code awaiting deletion
```

The protocol package remains the schema and channel-contract source of truth:
`packages/protocol/src/channels` and protocol row schemas should not be moved
into runtime. Runtime folders may re-export or implement those contracts, but
they do not own them.

Inside `subscribers/`, shape prefixes are part of the contract:

```text
subscribers/
  B-projections/
  C-runtime-context/
  D-tool-dispatch/
  D-wait-router/
  D-scheduled-prompt/
```

A `D-*` folder requires a workflow-machinery justification. A `C-*` folder
must not grow a `WorkflowEngine` requirement without changing shape and going
back through the SDD gate.

In greenfield mode, do not create long-lived compatibility folders. If a
target-shaped replacement is proven in firelab, move production code
directly to the target path and delete the old path in the same wave. A
temporary `legacy/` path is allowed only when the bead names the deletion point
and CI blocks new imports from it.

## Enforcement Checklist

A subscriber PR is dispatchable when:

1. Its `R` channel matches one of the four shapes.
2. If `R` mentions `WorkflowEngine` / `WorkflowInstance`, the SDD includes the
   workflow-machinery justification required by
   `runtime-design-constraints.md`.
3. If it owns durable state, the PR names the state store tag and the key kind
   it owns.
4. If it writes to an event table or channel, `R` includes the `*Write` tag,
   `EgressChannel`, or `CallableChannel` capability that authorizes the write.
5. If it reads from a source, `R` includes the typed source, `*Read` tag, or
   `IngressChannel` capability.
6. If the same subscriber both reads and writes the same logical table family,
   the PR calls out the feedback loop and why it is not a topology error.
7. Its transition logic, if any, is a pure function. Reviewer test: callable in
   a unit test with no Effect environment.
8. If it backs a `CallableChannel` with `completion: terminal`, the SDD names
   the durable fact that resolves the terminal handshake.

Checks 1, 2, 4, and 5 are partly statically visible through `R`. Checks 3, 6,
7, and 8 are review-enforced today and should become drift guards when the
runtime shrink stabilizes.

## Net

Nothing new needs to be built to express the graph. Firegrid already has:

- `DurableTable` for durable facts and state;
- `Context.Tag` for capability boundaries;
- `Layer` for topology composition;
- `Stream` and `Effect` for source consumption and actions;
- `IngressChannel`, `EgressChannel`, `CallableChannel`, and
  `BidirectionalChannel` as polarity-typed wire-edge handles;
- `HostPlaneChannelRouter` and `RuntimeChannelRouter` for wire-edge dispatch;
- `ChannelRouteCompletion` for acknowledgement vs terminal completion metadata;
- `@effect/workflow` for Shape D subscribers that can justify it.

This document names the edges so future PRs land subscribers whose shape is
visible in their type signatures. Ambiguity about "what kind of thing is this"
should be answerable by reading `R`.

## Greenfield Execution Rule

Because Firegrid has no production user state to preserve, this document is an
execution guide, not a migration-compatibility guide. The fastest safe path is
to prove the target edge in `packages/firelab`, then build that target
shape in production and delete the wrong shape. Do not spend production effort
shrinking a known-wrong edge unless that bridge demonstrably accelerates
deletion of the edge.

Tiny-firegrid simulations should fan out by topology question:

1. **Shape C RuntimeContext:** Can a per-event keyed subscriber over
   `RuntimeContextStateStore` replace the context-lifetime
   `RuntimeContextWorkflowNative` body?
2. **Typed event routing:** Can RuntimeContext input, output, tool-result, and
   terminal facts route through the same per-key event boundary without dense
   scans or cross-event `DurableDeferred` mailboxes?
3. **Shape D admission:** Which subscribers truly need workflow machinery, and
   what capability justifies it: activity memoization, durable timer, or bounded
   cross-execution handoff?
4. **Directory topology:** Can target-shaped code live under folders that match
   the pipeline roles without circular imports or ambiguous ownership?

Each simulation should return `GREEN`, `YELLOW`, or `RED`:

- `GREEN`: build the production replacement.
- `YELLOW`: build the named target-shaped helper first.
- `RED`: revise the architecture before production work.

This keeps the design phase from becoming another bridge phase. The runtime
tree should converge by replacing wrong-shaped code with target-shaped code,
not by making the wrong-shaped code easier to live with.
