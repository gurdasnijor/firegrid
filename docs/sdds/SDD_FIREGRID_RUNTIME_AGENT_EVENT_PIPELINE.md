> **HISTORICAL (pre-#765).** References paths deleted in #765 (packages/substrate, packages/host-sdk/src/host, and legacy packages/runtime/src/{subscribers,durable-tools,workflow-engine,agent-event-pipeline,agent-tools,runtime-host,composition}); kept for provenance. Current architecture: docs/cannon/.

# SDD: Firegrid Runtime Agent Event Pipeline

Status: draft target-state specification

Related specs:

- `firegrid-runtime-agent-event-pipeline`
- `firegrid-runtime-host-modularity`
- `firegrid-workflow-driven-runtime`
- `firegrid-factory-aligned-agent-tools`
- `firegrid-schema-projection-contract`

## Problem

Firegrid has proven the runtime primitives needed for autonomous agent work:

- `RuntimeContext` owns durable session intent;
- `RuntimeIngressTable` owns prompts/control inputs;
- `RuntimeOutputTable` owns runtime output observations;
- `AgentCodec` implementations normalize wire protocols into agent events;
- `toolUseToEffect` lowers agent tool calls into Firegrid primitives;
- `DurableTable.rows()` and `SourceCollections` let `wait_for` observe durable
  row streams.

The implementation is still shaped like an aggregate root. In particular,
`packages/runtime/src/runtime-host/index.ts` mixes resource acquisition,
protocol decoding, durable output materialization, tool dispatch, ingress
delivery, runtime lifecycle writes, host topology, and public exports.

That shape obscures the actual pipeline and makes downstream cleanup harder.
The target architecture should express the runtime as named stages with
explicit write authorities.

## Core Model

The runtime agent path is a bidirectional event pipeline:

```txt
RuntimeIngress rows
  -> AgentInputEvent
  -> codec session send
  -> agent process/protocol

agent process/protocol
  -> codec session outputs
  -> AgentOutputEvent stream
  -> RuntimeOutput rows
  -> durable subscribers
  -> authorized follow-up writes
```

`RuntimeIngress` and `RuntimeOutput` are durable materialization points around
`agent-io` events. They are not additional agent protocols and they are not
downstream of `agent-adapters`.

`agent-adapters` are sibling projections of codec sessions. They may expose a
codec-backed agent as an Effect AI `LanguageModel.Service`, but they do not sit
inside the durable runtime-host path.

### Managed-Agent Vocabulary Alignment

This SDD aligns with the managed-agent primitive vocabulary without copying an
older Fireline implementation model:

- `RuntimeContext`, `RuntimeIngress`, and `RuntimeOutput` describe the durable
  session/event identity surface.
- `Codecs.runtime.attach(...)` plus the active process/protocol loop is the
  harness boundary that turns protocol effects into normalized events.
- `Sources.sandbox(...)` acquires the live process/sandbox resource used by the
  harness.
- durable Effect capability tags and their providing layers make session
  progress replayable and observable.
- `toolUseToEffect` and MCP/session tool exposure remain the Tools surface.

The key RFC lesson carried into this SDD is identity vs. live ownership: a
durable row may describe a session, context, sandbox, or resource, but it does
not prove the current host owns a live handle. Runtime code must reacquire,
reattach, reprovision, or terminalize at live boundaries according to explicit
codec/provider semantics.

## Write Authority Principle

The earlier "only sinks write rows" framing is too broad and too narrow.
Firegrid intentionally has multiple durable table families. The smell is not
multiple tables. The smell is scattered direct writes to those tables.

The target principle is:

```txt
Transforms, subscribers, codecs, and projections never write durable rows
directly. Each durable table family has exactly one provider layer for the
capability tags that commit rows for that family.
```

Concrete authority layers:

- `RuntimeOutputJournalLive`
  - owns `RuntimeOutputTable.events`;
  - owns `RuntimeOutputTable.logs`;
  - provides event/log `Queue.Enqueue`, `Sink`, and `Stream` capabilities.
- `RuntimeIngressAppenderLive`
  - owns sequenced `RuntimeIngressTable.inputs` writes;
  - provides append/lookup `Effect` capabilities and input observation streams.
- `RuntimeIngressDeliveryTrackerLive`
  - owns `RuntimeIngressTable.deliveries`;
  - provides claim/complete `Effect` capabilities.
- `RuntimeControlPlaneRecorderLive`
  - owns `RuntimeControlPlaneTable.contexts`;
  - owns `RuntimeControlPlaneTable.runs`;
  - provides context insert and run lifecycle `Effect` capabilities.
- `DurableWaitStoreLive`
  - owns durable wait rows and completions.
- App-owned `DurableTable` facades
  - owned by their app modules;
  - may expose their own app-level write authority if needed.

Some capability tags expose `Sink` values because they terminate streams. Some
expose `Effect`-returning functions because they handle discrete commands.
Append-only fire-and-forget paths should use `Queue.Enqueue` where it fits.

## Transactional Cutover

This SDD specifies a target-state rewrite, not a phased migration plan.

The usual production instinct is to split behavior-preserving extraction,
semantic change, and directory rename into separate PRs. That is not the right
calibration here. Firegrid is still converging on its durable runtime substrate,
and intermediate architecture states have already shown a specific failure
mode: partial refactors become load-bearing patterns before the next phase
lands. The team then starts treating the compromise as the design.

For this pipeline work, the target shape is the artifact. Review should be
top-down over the new `packages/runtime/src` tree, not line-by-line over
intermediate diff history.

The implementation PR should therefore land as one transactional cutover:

1. introduce the stage-disciplined directory tree;
2. introduce authority modules per durable table family;
3. move codec runtime execution into the pipeline composition;
4. move tool dispatch behind a durable subscriber;
5. rebuild language-model adapters as codec/session projections;
6. update imports/tests in the same cut.

If implementation exposes a contract weakness, update the SDD/spec before
continuing. Do not ship a half-shape whose purpose is only to make a later
architecture easier.

## Stage Model

The runtime tree is organized by stage role before domain:

```txt
packages/runtime/src/
  agent-event-pipeline/
    session-runtime.ts
    README.md
    events/
      contract.ts
      output.ts
      stage-contracts.ts
      README.md
    sources/
      byte-stream.ts
      sandbox/
        index.ts
      README.md
    codecs/
      contract.ts
      acp/
        index.ts
        mapping.ts
      stdio-jsonl/
        index.ts
      README.md
    transforms/
      ingress-to-agent-input.ts
      README.md
    authorities/
      runtime-output-journal.ts
      runtime-ingress-appender.ts
      runtime-ingress-delivery-tracker.ts
    subscribers/
      ingress-delivery.ts
      tool-router.ts
      stderr-journal.ts
      README.md

  authorities/
    runtime-control-plane-recorder.ts
    source-names.ts
    README.md

  agent-tools/
  agent-adapters/
  waits/
    internal/
      wait-for.ts
      wait-router.ts
      durable-wait-store.ts
      source-collections.ts

  source-registration/
    runtime-control-plane.ts
    runtime-ingress.ts
    runtime-output.ts

  host/
    workflow-handler.ts
    authority-context.ts
    config.ts
    errors.ts
    sync-run.ts

  workflow-engine/
```

The names can be refined during implementation, but the target tree must
preserve the stage roles:

- sources acquire resources and produce bytes;
- codecs convert protocol bytes/actions into normalized agent events;
- transforms are pure stream operators;
- authorities are the only durable row writers for their table family;
- subscribers read durable seams and dispatch follow-up work;
- projections expose sibling views of codec sessions;
- host wires the pipeline into workflow execution and host authority.

### Pipeline Vocabulary

The target model keeps the dataflow vocabulary small. The same word should not
hide different directions of travel.

- Pipeline sources are live byte/process acquisition stages under `sources/`.
  They acquire resources and emit bytes into codecs.
- Durable writes are commit capabilities. They are exposed through stock Effect
  shapes: `Queue.Enqueue` for append-only fire-and-forget writes, `Sink` for
  stream-terminal commits, and narrow `Effect` functions when the caller needs
  a committed row, lookup, claim, or lifecycle transition.
- Durable observations are static `Stream` capability tags over rows already
  committed by the owning layer. They are not pipeline byte sources and they
  are not durable write sinks.
- Dynamic `wait_for` lookup uses `SourceCollectionHandle` as a named
  registration handle that resolves to a durable stream at replay/runtime. It
  is not the static read-side abstraction.
- Host observation wiring only registers dynamic source handles with
  `SourceCollections`. It does not own writes and should not introduce a
  second name for the same pipeline role.

The runtime therefore has two read paths over the same durable rows. Static
subscribers, such as the tool router and permission-wait bridge, consume
`Stream` capability tags through the Effect requirement channel because they
are wired at compose time. Dynamic `wait_for` lookup consumes
`SourceCollectionHandle`s because workflows reference source collections by
name at replay time.

Use local names that keep directionality visible, for example
`runtimeAgentOutputEvents` for a static observation stream and
`runtimeAgentOutputEventsRegistration` for a dynamic wait source registration,
not generic names like `outputSources` that can be confused with process/byte
sources.

### Type-Level Stage Contracts

The directory layout is not enough by itself. Each stage boundary should expose
a small typed contract that makes the allowed direction of travel difficult to
violate during parallel work.

The cutover should prefer these enforceable shapes:

- sources expose `Stream`-producing acquisition functions and do not expose
  durable table facades;
- codecs expose `AgentSession` and `AgentCodec` contracts over
  `AgentInputEvent` / `AgentOutputEvent`, including the per-session
  `toolUseMode`;
- transforms expose pure `Stream -> Stream` operators and cannot require
  authority services;
- durable table authorities are provided as Effect capability tags: static
  write capabilities use `Queue.Enqueue`, `Sink`, or narrow `Effect` methods;
  static observation capabilities use `Stream`;
- subscribers consume static `Stream`/write capability tags through the Effect
  requirement channel, not raw `DurableTable` collection facades;
- dynamic `wait_for` source lookup uses `SourceCollectionHandle` as the named
  registration handle, not as the universal read-side abstraction;
- pipeline/host composition accepts these stage contracts and wires them
  together, but does not construct protocol rows or mutate table collections
  directly.

Use `Schema` brands for identities that cross stage boundaries when the value
is otherwise just a string or number: runtime context ids, activity attempts,
tool-use ids, subscriber ids, runtime authority source names, and idempotency
keys. The goal is not elaborate nominal typing everywhere; it is to make
cross-stage routing bugs visible at compile time before semgrep has to catch
them.

The cutover should define at least these branded identities where they cross
stage boundaries: `RuntimeContextId`, `RuntimeActivityAttempt`, `ToolUseId`,
`PermissionRequestId`, `RuntimeSubscriberId`, `RuntimeAuthoritySourceName`, and
`RuntimeIdempotencyKey`. Idempotency-key builders should decode/encode through
schema-owned constructors rather than free-form string concatenation at call
sites.

`Stream`, `Sink`, `Queue.Enqueue`, `Effect`, `Layer`, and `Context.Tag` should
encode directionality directly. Do not add Firegrid-specific aliases for
shapes that Effect already names. Durability is an invariant carried by the
tag and layer that provide the capability, not by inventing a parallel
capability vocabulary.

```ts
const sequenceAndStamp = (
  input: Stream.Stream<AgentOutputEvent, CodecError, CodecSession>,
): Stream.Stream<RuntimeEventRow, RuntimeEventError, CodecSession> =>
  input.pipe(Stream.mapEffect(/* ... */))

export class RuntimeIngressAppendAndGet extends Context.Tag(
  "@firegrid/runtime/RuntimeIngressAppendAndGet",
)<RuntimeIngressAppendAndGet, {
  readonly append: (
    request: RuntimeIngressRequest,
  ) => Effect.Effect<RuntimeIngressInputRow, RuntimeIngressAppendError>
}>() {}

export class RuntimeAgentOutputEvents extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputEvents",
)<RuntimeAgentOutputEvents, {
  readonly stream:
    Stream.Stream<RuntimeAgentOutputObservation, DurableTableError>
}>() {}
```

The public shape must preserve the distinction: a process/source stage is not a
durable observation stream, an observation stream is not a journal sink, and a
subscriber cannot become a hidden durable writer by accepting a table facade.
If a transform is just a function from `Stream` to `Stream`, leave it as a
function. If it needs to be a first-class pipeline value, use Effect's
`Channel` rather than inventing a parallel transform abstraction.

### Substrate vs. Composition

The pipeline distinguishes two layers.

Durable capability tags, their providing layers, dynamic source-collection
registration, and the codec runtime are substrate. They define which Effect
capabilities durably write rows, which capabilities replay committed rows, how
dynamic `wait_for` lookup resolves named sources, and how protocol sessions
become normalized event streams. Substrate is change-controlled,
semgrep-enforced, and registered in the authority registry. Adding or modifying
substrate requires SDD/spec revision.

Subscribers, codec attachments, and routing components are composition. They
are pluggable wiring on top of substrate and can be added, removed, or
reconfigured without changing the authority registry. The permission-wait
bridge, the tool router, the ingress-delivery subscriber, and the stderr journal
are composition: they consume durable `Stream` capabilities, route through
chosen logic, and append through durable write capabilities.

Composition is static, strongly typed pipeline wiring in this cutover. The
invariant is narrow: when a component affects durable behavior, it must do so
through durable capability tags or dynamic `SourceCollectionHandle` lookup so
its externally visible effects are durable, observable, and replay-safe. This
SDD does not introduce dynamic middleware, a serializable topology
specification, or user-authored runtime closures.

`tools/lowering/tool-host.ts` contains the service tag/interface only. The
host-coupled live implementation belongs under
`host/agent-tool-host-live.ts`, because it fans out to
runtime control-plane, runtime ingress, workflow execution, and other durable
capability tags.

## Lifecycle Discipline

Each stage has a lifecycle contract.

### Sources

Sources acquire external resources and expose byte streams.

Use `Stream.acquireRelease` or scoped Effects so resource lifetime is coupled
to the stream/session lifetime. Release must have `Exit` visibility when the
release action differs for success, failure, or interruption.

### Codecs

Codecs own protocol session state, not Firegrid durable writes.

A codec session may be effectful at the protocol boundary, but it must not
write `RuntimeIngressTable`, `RuntimeOutputTable`, `RuntimeControlPlaneTable`,
or durable wait rows directly.

The shared codec runtime owns common session mechanics:

- bounded output queue;
- runtime-bound `emit`;
- fallback id generation;
- terminal event merge;
- send-side input dispatch;
- common error mapping.

All six mechanics move into `codecs/runtime.ts` in the cutover. Individual
codecs may own protocol-specific parsing and connection actions, but they must
not construct their own output queues, ad hoc runtime emit bridges, fallback id
generators, terminal merges, send-side dispatch loops, or duplicate error
mapping scaffolds.

The codec contract exposes per-session capability flags used by pipeline
routing. The load-bearing flag for tool-shaped output is:

```ts
readonly toolUseMode:
  | "observation_only"
  | "client_result_roundtrip"
  | "control_channel_request_response"
```

This is per active session, not a static property of a codec class. The active
codec session reports `toolUseMode` after protocol negotiation completes; the
runtime does not infer it from codec class. For codecs with no negotiation
phase, such as `stdio-jsonl`, the value is fixed at session construction. For
codecs with negotiation, such as ACP, the value is set when capabilities
exchange completes and remains stable for the session lifetime. The tool router
reads it at subscription time and claims durable `ToolUse` rows only for
sessions whose active mode is `client_result_roundtrip`; it does not claim rows
from other modes and then fail later during send.

Mode definitions:

- `observation_only`: tool-shaped events are durable telemetry. The router must
  not claim them. Examples include ACP `sessionUpdate.tool_call`,
  `codex exec --json`, and basic `claude -p --output-format stream-json`.
- `client_result_roundtrip`: the active session has an explicit path from
  normalized `ToolUse` output to host-produced `ToolResult` input. The v1
  confirmed instance is Firegrid `stdio-jsonl`, where `tool_use` appears on
  stdout and `tool_result` is sent on stdin.
- `control_channel_request_response`: the protocol has request/response
  methods with their own ids, responses, and capability negotiation. Examples
  include ACP `session/request_permission`, ACP file/terminal Client
  capabilities, and Codex app-server style control methods. These are not
  modeled as subscriber-produced `ToolResult` ingress.

Claude Code needs a hedge. `claude -p --output-format stream-json` is
`observation_only`. Anthropic also documents streaming input surfaces, and
community tooling has explored bidirectional stream-json/control paths, but the
CLI stdin `tool_result` shape is not treated here as a stable Firegrid contract.
When Anthropic documents a stable bidirectional protocol, a Claude Code codec
can advertise whichever modes its launch flags support without changing this
SDD.

### Transforms

Transforms are pure stream operators over normalized events. They own no
resources and commit no rows.

Examples:

- sequence/stamp events;
- buffer event streams with explicit backpressure policy;
- detect terminal events;
- coalesce text deltas if needed.

### Durable Effect Capabilities

Authorities are ownership rules and live layers, not a new type family. The
typed runtime surface should be ordinary Effect capabilities behind
`Context.Tag`s whose identity carries the durability promise.

A durable table authority is the only live layer that may provide the capability
tags for its table family. For example, the runtime output layer owns the
`RuntimeOutputTable.events/logs` storage and provides event/log append,
observation, and sink capabilities. The word "journal" may remain as informal
terminology for that layer, but there is no separate `Journal` or `Authority`
type that callers depend on.

The target shape is stock Effect interfaces:

```ts
export class RuntimeEventLog extends Context.Tag(
  "@firegrid/runtime/RuntimeEventLog",
)<RuntimeEventLog, Queue.Enqueue<RuntimeEventRow>>() {}

export class RuntimeEventAppendAndGet extends Context.Tag(
  "@firegrid/runtime/RuntimeEventAppendAndGet",
)<RuntimeEventAppendAndGet, {
  readonly append: (
    row: RuntimeEventRow,
  ) => Effect.Effect<RuntimeEventRow, RuntimeOutputError>
}>() {}

export class RuntimeEventStream extends Context.Tag(
  "@firegrid/runtime/RuntimeEventStream",
)<RuntimeEventStream, Stream.Stream<RuntimeEventRow, DurableTableError>>() {}

export class RuntimeLogLog extends Context.Tag(
  "@firegrid/runtime/RuntimeLogLog",
)<RuntimeLogLog, Queue.Enqueue<RuntimeLogLineRow>>() {}

export class RuntimeLogStream extends Context.Tag(
  "@firegrid/runtime/RuntimeLogStream",
)<RuntimeLogStream, Stream.Stream<RuntimeLogLineRow, DurableTableError>>() {}

export class RuntimeAgentOutputEvents extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputEvents",
)<RuntimeAgentOutputEvents, Stream.Stream<
  RuntimeAgentOutputObservation,
  DurableTableError
>>() {}

export class RuntimeAgentOutputRowSink extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentOutputRowSink",
)<RuntimeAgentOutputRowSink, Sink.Sink<
  void,
  RuntimeEventRow,
  never,
  RuntimeOutputError
>>() {}

export const RuntimeOutputJournalLive: Layer.Layer<
  | RuntimeEventLog
  | RuntimeEventAppendAndGet
  | RuntimeEventStream
  | RuntimeAgentOutputEvents
  | RuntimeLogLog
  | RuntimeAgentOutputRowSink
  | RuntimeLogStream,
  never,
  RuntimeOutputTable
> = /* constructs all tags from RuntimeOutputTable */
```

This mirrors Effect's own least-privilege interfaces. `Queue.Queue<A>` extends
both `Queue.Enqueue<A>` and `Queue.Dequeue<A>`, while producers can depend only
on `Enqueue` and consumers can depend only on `Dequeue`. Runtime durability is
orthogonal: `RuntimeEventLog` is still an `Enqueue`, but its tag/layer contract
says `Queue.offer` commits durably.

Most write paths should use stock capabilities:

- append-only fire-and-forget writes use `Queue.Enqueue<Row>`;
- stream-terminal writes use `Sink.Sink<Out, In, L, E, R>`;
- observation/replay uses `Stream.Stream<Row, E, R>`;
- lookups use plain functions returning `Effect<Option<Row>, E, R>`.

When callers need the committed row back after id assignment, timestamping, or
canonical encoding, expose an explicit sibling capability such as
`RuntimeEventAppendAndGet`. Do not stretch `Queue.Enqueue.offer` away from its
standard `Effect<boolean>` shape.

Narrow `Effect` capability services use object-with-method services rather than
function-as-service values. For example, callers use
`(yield* RuntimeEventAppendAndGet).append(row)`. This follows the common Effect
service convention and leaves room to add a sibling operation without changing
the service value shape.

Dynamic `wait_for` registration is the one place that needs a named handle.
`SourceCollectionHandle` is the runtime lookup record for "find this durable
stream later by source name." Static subscribers should consume `Stream`
capabilities directly; `wait_for` and source registration use
`SourceCollectionHandle` because they cross a dynamic name boundary:

```ts
export class RuntimeIngressInputStream extends Context.Tag(
  "@firegrid/runtime/RuntimeIngressInputStream",
)<RuntimeIngressInputStream, Stream.Stream<
  RuntimeIngressInputRow,
  DurableTableError
>>() {}

export const runtimeIngressInputSourceRegistration = (
  stream: Stream.Stream<RuntimeIngressInputRow, DurableTableError>,
): SourceCollectionHandle => ({
  name: RuntimeAuthoritySourceNames.runtimeIngressInputs,
  subscribe: () => stream,
})
```

The same provider layer that supplies a static `Stream` capability also
constructs the corresponding `SourceCollectionHandle` from that stream. Static
subscribers and dynamic `wait_for` lookup must resolve to the same underlying
durable rows through one subscription mechanism per row family.

Subscribers are functions that take session-specific parameters and return an
`Effect` whose requirement channel declares durable capability tags:

```ts
export const runToolRouter = (options): Effect.Effect<
  void,
  ToolRouterError,
  | RuntimeAgentOutputEvents
  | RuntimeIngressAppendAndGet
  | DurableWaitRowUpsert
> => Effect.gen(function*() {
  const outputEvents = yield* RuntimeAgentOutputEvents
  const appendIngress = yield* RuntimeIngressAppendAndGet
  const appendWait = yield* DurableWaitRowUpsert
  // ...
})
```

Do not pass runtime-owned `DurableTable` facades to subscribers. Do not pass a
module-shaped service when a stock Effect capability tag is enough. Do not
introduce Firegrid-specific aliases such as `DurableAppend`,
`DurableObservation`, `RuntimeAuthorityCommand`, `RuntimeAuthoritySink`, or
`RuntimeAuthorityObservation`; use `Queue.Enqueue`, `Stream`, `Sink`, `Effect`,
and `SourceCollectionHandle` directly.

Examples:

```txt
AgentOutputEvent stream -> RuntimeAgentOutputRowSink
RuntimeIngressRequest   -> RuntimeIngressAppendAndGet
run lifecycle transition -> RuntimeRunAppendAndGet
wait_for tool call -> DurableWaitRowUpsert
```

This does not replace `DurableTable`. `DurableTable` remains the storage and
live-row primitive. Authorities encode Firegrid runtime policy over that
primitive: sequencing, idempotency, claim keys, output envelopes, lifecycle
state, and read/observation handles. If an authority starts exposing generic
`insert`, `upsert`, `delete`, or `rows` methods, it has become a disguised table
facade and violates this SDD.

### Subscribers

Subscribers read from durable seams and dispatch follow-up effects.

Subscribers consume static durable observations through `Stream` capability
tags and dynamic wait sources through `SourceCollectionHandle` lookup. They
should not call `DurableTable.rows()` directly and should not reach into table
collections owned by other authorities.

Authority layers own both the write capabilities and the static/dynamic read
capabilities for their table family. For example, the runtime output layer owns
writes to `RuntimeOutputTable.events/logs`, provides `RuntimeEventStream` and
`RuntimeAgentOutputEvents` stream tags, and registers the corresponding
`SourceCollectionHandle`s for `wait_for` lookup.

Per-dispatch tasks use `Stream.acquireRelease` or equivalent scoped resource
lifetime so interruption, success, and failure are handled distinctly.

### Projections

Projections are sibling views over codec sessions.

The primary projection is a codec-backed Effect AI `LanguageModel.Service`.
It reuses codec/session mechanics and terminates into LanguageModel response
aggregation instead of the runtime durable output journal.

Projections do not read from or write to runtime-host durable tables.

## Runtime Composition

The pipeline composition root should read structurally:

```txt
source bytes
  -> codec session
  -> subscribers for ingress/stderr/tool routing
  -> output transforms
  -> RuntimeAgentOutputRowSink
```

Sketch:

```ts
const runAgentSession = (options) =>
  Effect.scoped(
    Effect.gen(function*() {
      const bytes = yield* Sources.sandbox(options.context)
      const session = yield* Codecs.runtime.attach(options.codec, bytes, setup)

      yield* Subscribers.ingressDelivery({
        contextId: options.context.contextId,
        send: session.send,
      }).pipe(Effect.forkScoped)

      yield* Subscribers.permissionWaitBridge({
        contextId: options.context.contextId,
      }).pipe(Effect.forkScoped)

      yield* Subscribers.toolRouter({
        contextId: options.context.contextId,
      }).pipe(Effect.forkScoped)

      const outputSink = yield* RuntimeAgentOutputRowSink

      return yield* session.outputs.pipe(
        Transforms.codecOutputBuffer,
        Transforms.sequenceAndStamp(options.context, options.activityAttempt),
        Stream.ensuring(commitSessionCheckpoint(options.context)),
        Stream.run(outputSink),
      )
    }),
  )
```

`host/workflow-handler.ts` provides host authority, runtime config, and the
authority layers. It should be short enough that reviewers can see the runtime
execution topology without reading protocol details.

## Subscriber-Based Tool Dispatch

Moving tool dispatch from the live codec stream to a durable subscriber is a
behavioral change. The target behavior is:

```txt
Agent emits ToolUse
  -> RuntimeAgentOutputRowSink commits ToolUse row
  -> ToolRouter subscriber observes durable ToolUse row
  -> toolUseToEffect runs under workflow/tool authority
  -> RuntimeIngressAppendAndGet appends ToolResult control/input row
  -> IngressDelivery subscriber sends ToolResult back to codec if session alive
```

This decouples durable observation from side-effect dispatch. A crash after
the `ToolUse` row commits but before dispatch no longer loses the tool call:
on restart, the subscriber replays durable rows and dispatches missing results.

The tool router must prove:

- dedupe by durable tool-use identity;
- no duplicate result row for already-completed tool uses;
- deterministic result idempotency key;
- explicit interrupted/error result shape;
- bounded concurrency/backpressure policy.

The v1 tool router is single-flight per `(contextId, activityAttempt)`. It
must not dispatch a second tool use for the same running attempt until the
first dispatch has produced a terminal result row. This preserves turn
causality and avoids ambiguous `RuntimeIngress` sequencing. Later concurrency
requires a new ACID that defines ordering and interleaving semantics.

The router watches only the current running activity attempt for a context. It
does not redispatch ToolUse rows from prior terminal attempts when a later
attempt starts. Restart/reconstruction of the same attempt may replay committed
ToolUse rows and dispatch any missing results.

### ToolUse Envelope Decode

`RuntimeAgentOutputRowSink` writes `RuntimeEventRow.raw` as the schema-encoded
Firegrid agent-output envelope:

```json
{
  "type": "firegrid.agent-output",
  "event": { "_tag": "ToolUse" }
}
```

The encode/decode pair lives in `events/output.ts`:

```txt
encodeRuntimeAgentOutputEnvelope(event)
decodeRuntimeAgentOutputEnvelope(raw)
runtimeAgentOutputObservationFromRow(row)
```

The output capability layer uses the encoder for writes and provides decoded
static `RuntimeAgentOutputEvents` stream capability tags for subscribers.
Subscribers do not parse raw JSON themselves.

### ToolResult Idempotency

Subscriber-produced tool results append through `RuntimeIngressAppendAndGet`
with this idempotency key:

```txt
agent-tool-result:<contextId>:<activityAttempt>:<toolUseId>
```

The corresponding `inputId` is:

```txt
agent-tool-result:<contextId>:<activityAttempt>:<toolUseId>:result
```

`toolUseId` is the durable tool-use identity projected from the committed
`RuntimeOutput` row. `activityAttempt` is included because the same context may
run again after a terminal attempt; a tool use emitted by a later attempt must
not collide with an earlier attempt's result. The appender's normal idempotent
insert semantics fence duplicate subscriber dispatch.

If the tool dispatch result is an interruption or error, the same identity
shape is used. The payload differs; the durable result identity does not.

### ACP Tool Calls And Client Capabilities

The v1 transactional cutover implements durable subscriber tool dispatch for
`stdio-jsonl` agent sessions only.

ACP remains fully supported for:

- session setup;
- Prompt delivery;
- TextChunk/Status/TurnComplete/Terminated output journaling;
- PermissionRequest durable observation;
- PermissionResponse ingress resume.

ACP `sessionUpdate.tool_call` and `tool_call_update` rows are progress/result
observations from the Agent to the Client. This is a deliberate ACP
directionality contract, not a missing Firegrid dispatch path. They are not
dispatch candidates. The tool router does not claim them, and no runtime-side
subscriber is required to consume them in v1. They remain queryable through the
`RuntimeAgentOutputEvents` stream capability and its dynamic wait/source
registration for UI, metrics, tracing, and future observation-consuming
subscribers.

ACP tool execution may flow through MCP servers supplied during ACP session
setup, where MCP owns the request/result exchange. Agent-owned tools may also
execute inside the ACP agent process against the cwd/sandbox Firegrid used to
launch that process. Firegrid must not reinterpret ACP `tool_call`
observations as client-executed tool requests.

This is not an implicit half-shape. It is the ACP directionality contract:

```txt
ACP newSession.mcpServers
  -> ACP agent invokes MCP tool
  -> MCP returns result to ACP agent
  -> ACP emits tool_call/tool_call_update observations
  -> Firegrid journals those observations
```

ACP Client capabilities are a `control_channel_request_response` pattern:
Agent-to-Client JSON-RPC methods with their own ids, responses, and capability
negotiation. Firegrid supports the permission capability because it maps
directly to Firegrid's durable wait/resume model:
`session/request_permission` becomes durable `PermissionRequest` output and
resumes through `PermissionResponse` ingress.

ACP file-system and terminal Client capabilities are different. They can be
used by editor-style Clients whose buffer state, diff UI, terminal panels, or
workspace view may differ from the OS filesystem visible to the Agent process.
They can also become useful in a managed-agent runtime where the resource plane
is intentionally separated from the Agent execution plane: the Agent process may
not directly own every hand/resource it needs to operate, and Firegrid may
mediate those hands through durable resource authorities.

That managed resource-plane direction is compatible with Firegrid, but it is
not part of this runtime event-pipeline cutover. This SDD only defines how
Agent session events flow through codec runtime, durable journals, authorities,
and subscribers. It does not define mounted resources, remote sandboxes,
terminal panels, filesystem overlays, secrets proxies, audit middleware, or
approval/budget middleware.

In v1, Firegrid launches an Agent process with a cwd/sandbox, journals ACP
updates, mediates permission, and supplies MCP server declarations. Normal
filesystem and shell operations remain agent-owned inside that launched
environment, and Firegrid observes the resulting ACP updates. If Firegrid later
backs ACP `fs/read_text_file`, `fs/write_text_file`, `terminal/create`,
`terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, or
`terminal/release`, that is a resource-plane/middleware feature with separate
SDD/spec ACIDs for resource identity, durable IO policy, audit/journaling,
idempotency, secrets isolation, and sandbox authority. It must not be modeled as
subscriber-produced `ToolResult` injection.

The pipeline may not advertise ACP tool execution through subscriber-produced
`ToolResult` ingress.

### Permission Wait And Resume

Permission waits are not a separate protocol-specific loop and they are not
handled by the tool router.

The durable path is:

```txt
ACP Agent calls session/request_permission
  -> AcpCodec emits AgentOutputEvent.PermissionRequest
  -> RuntimeAgentOutputRowSink commits the PermissionRequest row
  -> RuntimeAgentOutputEvents exposes a decoded permission observation stream
  -> wait_for / session.wait.forPermissionRequest matches that stream or its dynamic source registration
  -> human/product/runtime writes a PermissionResponse through RuntimeIngressAppendAndGet
  -> IngressDelivery subscriber sends PermissionResponse to the active codec
  -> AcpCodec resolves the pending ACP requestPermission promise
  -> ACP Agent continues or rejects based on the selected decision
```

`PermissionRequest` is durable because it is first committed to
`RuntimeOutputTable.events`. Static subscribers observe it through the
`RuntimeAgentOutputEvents` stream capability. Dynamic `wait_for` observes the
same rows through the `SourceCollectionHandle` registered by the output
capability layer. Neither path parses raw output rows or subscribes to codec
internals.

`PermissionResponse` is durable because it is appended through
`RuntimeIngressAppendAndGet` as a control input row. The ingress delivery
subscriber is responsible for delivering that row to the active codec session
and recording delivery evidence through the runtime ingress delivery claim/
completion capabilities.

This keeps permission semantics aligned with the rest of the pipeline:

- observation is a durable output stream capability;
- waiting is the durable wait capability over a dynamic source registration;
- response is the runtime ingress append capability;
- delivery is the runtime ingress claim/completion capability;
- codec-specific ACP promise resolution remains inside `AcpCodec`.

The permission bridge can be an ordinary pipeline subscriber in a later slice:
it will consume `RuntimeAgentOutputEvents`, wait for or delegate to a
human/product decision source through the existing durable-tools `WaitFor.match`
and `SourceCollections` surface, then append the response through
`RuntimeIngressAppendAndGet`. This cutover does not add a speculative static
matching capability tag; `firegrid-runtime-agent-event-pipeline.AUTHORITIES.6-1`
is intentionally deferred until a production bridge needs one.

The ingress-delivery subscriber shown in the runtime composition sketch is what
later reads that `PermissionResponse` row and calls `session.send(...)`. For ACP
sessions, `AcpCodec.send(PermissionResponse)` resolves the pending
`session/request_permission` promise. For other codecs, permission input support
is codec-specific, but the durable wait and ingress authority shape stays the
same.

The permission-wait bridge is the v1 instance of the general
`control_channel_request_response` capability pattern. Each such capability is
a subscriber that consumes a durable output stream capability, routes through a
durable wait or backend source, and appends evidence through the runtime ingress
append capability. The active codec resolves the protocol-specific
request from the delivered response. Future capability bridges, such as ACP
file/terminal handlers or Codex app-server dynamic tool methods, do not require
new substrate authorities by default; they compose on the substrate this SDD
defines. The substrate guarantee for capability bridges is: a static durable
output stream capability, durable wait capability, runtime ingress append
capability, and ingress delivery to the active codec. A capability that fits
this shape composes; a capability that does not fit this shape requires
substrate revision through a new SDD.

If the Agent process dies after the `PermissionRequest` row is committed but
before the response is delivered, the committed request remains observable. A
later runtime attempt may resume only if the codec/session can recreate or
re-associate the pending protocol request; otherwise the response remains
durable ingress evidence for the terminated attempt. The event-pipeline cutover
does not invent protocol-level rewind semantics for ACP.

## Authority Provider Map And Enforcement

The capability-to-provider mapping must use Effect's existing layer and tag
surfaces. It must not re-create a parallel registry as strings such as
`capabilityTag: "RuntimeEventLog"` or `providerLayer:
"RuntimeOutputJournalLive"`. Those string registries are less safe than the
actual `Context.Tag` and `Layer` values, drift from the layer graph, and repeat
the role already modeled by Effect's `Layer`/`Context.Tag` APIs.

For the static runtime host composition, the canonical artifact is the Effect
layer graph itself: one provider layer per table family, each providing the
durable capability tags it owns. Runtime source files must not introduce or
export a registry that exists only for review or documentation. If a provider
map is not needed by production runtime behavior, it belongs in tests or docs
only and must be derived from actual Effect tag/layer values rather than
duplicated strings.

If runtime code needs keyed lookup of provider layers, it should use Effect's
`LayerMap` surface from `effect` instead of implementing a custom string map.
`LayerMap` is for dynamic keyed layer lookup/caching; it is not required for
ordinary static host composition. The important invariant is that the provider
map is expressed in terms of existing Effect values, not a one-off Firegrid
registry abstraction.

The provider map documents which durable capability tags are provided by which
layer and which table family backs each capability:

```txt
RuntimeEventLog -> RuntimeOutputJournalLive -> RuntimeOutputTable.events
RuntimeEventAppendAndGet -> RuntimeOutputJournalLive -> RuntimeOutputTable.events
RuntimeEventStream -> RuntimeOutputJournalLive -> RuntimeOutputTable.events
RuntimeAgentOutputEvents -> RuntimeOutputJournalLive -> RuntimeOutputTable.events
RuntimeAgentOutputRowSink -> RuntimeOutputJournalLive -> RuntimeOutputTable.events
RuntimeLogLog -> RuntimeOutputJournalLive -> RuntimeOutputTable.logs
RuntimeLogStream -> RuntimeOutputJournalLive -> RuntimeOutputTable.logs
RuntimeIngressAppendAndGet -> RuntimeIngressAppenderLive -> RuntimeIngressTable.inputs
RuntimeIngressInputStream -> RuntimeIngressAppenderLive -> RuntimeIngressTable.inputs
RuntimeIngressClaim -> RuntimeIngressDeliveryTrackerLive -> RuntimeIngressTable.deliveries
RuntimeIngressDeliveryComplete -> RuntimeIngressDeliveryTrackerLive -> RuntimeIngressTable.deliveries
RuntimeContextInsert -> RuntimeControlPlaneRecorderLive -> RuntimeControlPlaneTable.contexts
RuntimeRunAppendAndGet -> RuntimeControlPlaneRecorderLive -> RuntimeControlPlaneTable.runs
DurableWaitRowUpsert -> DurableWaitStoreLive -> DurableTools wait rows
DurableWaitCompletionRowUpsert -> DurableWaitStoreLive -> DurableTools wait rows
```

One layer constructor per table family may provide multiple tags. That grouping
keeps composition readable while preserving least-privilege consumer types. The
review artifact is not a new bundled service API; it is the list of tags each
layer provides and the table collections backing them.

The runtime ingress delivery claim/complete capabilities share one provider
layer for all `RuntimeIngressTable.deliveries` rows. Raw stdin delivery and each
codec delivery path share the same underlying tracker; `subscriberId` is the
namespace dimension.
Subscriber ids use:

```txt
runtime-ingress:<protocol>:<role>
```

Examples:

```txt
runtime-ingress:raw:stdin
runtime-ingress:stdio-jsonl:codec
runtime-ingress:acp:codec
```

The delivery dedupe key remains `(subscriberId, inputId)`.

The runtime control-plane capability layer owns both context insertion and run
lifecycle rows. Runtime host-facing local `RuntimeContext` insertion moves under
this provider. Host-context authority remains the read/validation surface
for `CurrentHostSession`, `CurrentRuntimeContext`, `requireLocalContext`, and
stream URL derivation; runtime must not re-export its legacy context write
helper.

The protocol-level `insertLocalRuntimeContext` helper remains a deprecated
browser-safe compatibility path during the cutover for callers that cannot
import `@firegrid/runtime`. It is not a runtime capability provider and is
tracked by `firegrid-runtime-agent-event-pipeline.TRANSACTIONAL_CUTOVER.3-2`
until a browser-safe command authority replaces it.

The file currently named `host-context-authority.ts` is renamed to
`host/authority-context.ts` in the cutover so the name reflects its read and
validation role rather than implying control-plane write ownership.

Enforcement has two levels:

1. Semgrep rejects direct `.insert`, `.upsert`, and `.delete` calls against
   runtime-owned DurableTable collection facades outside the layer that owns the
   corresponding capability tags, tests, and explicit app-owned table modules.
2. Tests verify a canonical durable capability tag list against actual Effect
   `Context.Tag` and `Layer` values, while Semgrep blocks production registry
   APIs and direct table-facade bypasses. A production registry file whose only
   consumer is tests/review is not allowed. If this later becomes a static lint,
   the Effect layer graph remains the source of truth.

Calls to durable capability tags such as `RuntimeIngressAppendAndGet` or
`RuntimeEventLog` are allowed. Test harness allowlists must be explicit;
harnesses that are exercising production behavior should use the durable
capability tags instead of direct table writes.

The rule is not directory-name theater. It prevents transforms, codecs,
projections, and subscribers from silently becoming durable write owners.

## Relationship To DurableTable

This design does not invent a new storage primitive over `DurableTable`.

`DurableTable` remains the substrate for durable row storage, current/live row
observation through `rows()`, idempotent `insertOrGet`, and UI/query bindings.

The pipeline adds ownership discipline around who may write each table family.
It does not add a new "fact" abstraction or provider-specific table.

App-owned tables remain app-owned. If an app wants planner-visible events,
decisions, or evidence, it defines a DurableTable collection and registers that
collection as a wait source:

```ts
yield* sources.register(
  sourceCollectionStreamHandle("darkFactory.events", table.events.rows()),
)
```

Firegrid may provide helpers for this pattern later, but the primitive remains
`DurableTable`.

## Relationship To Existing Runtime Directories

The target tree replaces role-ambiguous names with stage names:

- `agent-io` becomes `events`;
- `agent-codecs` becomes `codecs`;
- `providers/sandboxes` becomes `sources/sandbox`;
- `agent-adapters` becomes `projections/language-model`;
- `agent-tools/tools.ts` becomes `tools/schema`;
- `agent-tools/tool-use-to-effect.ts` becomes `tools/lowering`;
- `durable-tools` becomes `waits` plus subscriber substrate;
- `runtime-host` becomes `host`, `pipeline`, `authorities`, and subscribers.

There is no compatibility alias surface to protect for the prototype cutover.
Existing package-internal imports should be updated to the new stage paths in
the same transaction. If a temporary export bridge is unavoidable during the
cutover, it must be tracked by an ACID in
`firegrid-runtime-agent-event-pipeline` and removed before this feature is
considered complete. This SDD does not authorize open-ended compatibility
barrels.

## Review Guidance

The implementing PR should be reviewed as a new target tree, not as a sequence
of partial diffs. Reviewers should start from:

1. `packages/runtime/src/agent-event-pipeline/README.md`;
2. `packages/runtime/src/agent-event-pipeline/session-runtime.ts`;
3. the canonical runtime-host layer composition and authority provider tests;
4. the stage README files;
5. the ACID-linked tests.

The PR description should include:

- the full target tree;
- every satisfied ACID from `firegrid-runtime-agent-event-pipeline`;
- the durable capability registry table: tag, providing layer, and backing
  table family;
- the dynamic `SourceCollectionHandle` registrations exposed for `wait_for`
  lookup;
- validation commands;
- confirmation that the SDD prose, feature ACIDs, and codec contract type use
  the identical mode names `observation_only`, `client_result_roundtrip`, and
  `control_channel_request_response`;
- confirmation that no temporary compatibility export bridge remains, or the
  deletion ACID that gates completion.

## What Does Not Change

- `@firegrid/protocol` row schemas remain the durable contract.
- `RuntimeContext` remains the durable session intent record.
- `RuntimeIngressTable` remains the durable input/control queue.
- `RuntimeOutputTable` remains the durable runtime output journal.
- `RuntimeContextWorkflow` remains the workflow-backed `startRuntime` entry.
- `toolUseToEffect` remains the host-side lowering implementation.
- `FiregridAgentToolkit` remains the schema/tool projection.
- `DurableTable` remains the storage and live row observation primitive.
- App-owned provider semantics remain outside Firegrid runtime.

## Terminal Events And Exit Evidence

`RuntimeAgentOutputRowSink` is the row-commit sink only. It commits each
`RuntimeEventRow` before any subscriber side effect depends on that row.
The codec runtime owns terminal detection over the same output stream: it
writes every row through `RuntimeAgentOutputRowSink`, observes the
`Terminated` event after the write effect completes, and only then returns
terminal exit evidence to `RuntimeRunAppendAndGet`.

If the codec output stream ends without a `Terminated` event, codec runtime
fails with the named `agent-codec.outputs` runtime output error and host
workflow handling records a failed run through the runtime run append
capability. Keeping terminal aggregation in codec runtime avoids making a
row sink parse protocol envelopes while preserving journal-first ordering.

## Outside V1

The runtime event pipeline does not define the resource plane the Agent process
executes against. In v1 the resource plane is degenerate: the OS cwd/sandbox
Firegrid launched the process with, with no pre-launch source materialization
and no ACP file/terminal interception.

Future Firegrid resource-plane work has two complementary halves:

1. Pre-launch resource materialization. Sources such as local paths, git refs,
   object-store refs, or secrets are made available at chosen paths before
   runtime launch. Shell-based agent tools read these through normal OS calls.
   This half is launch-spec substrate: it changes what the Agent process can
   see at start, not how the pipeline observes events. It composes with this SDD
   by changing `RuntimeContext` launch parameters, not by adding pipeline
   stages. Durable resource records describe what should be mounted or was made
   available; they are not the live filesystem, container, VM, or provider
   handle.
2. Runtime-time Client capability interception. ACP `fs/*` and `terminal/*`
   requests, and future analogous capability methods, route through pluggable
   backend components that durably journal operations as evidence. This half is
   composition over the existing pipeline: each capability bridge consumes a
   durable output stream capability, routes through a chosen backend, and
   appends evidence through the appropriate durable write capability. It does
   not require new substrate authorities by default; the output stream and
   ingress append capability layers are the journaling targets.

Both halves are orthogonal to this event-pipeline cutover. The pipeline's
durable capability tags and dynamic source-registration contract are the
substrate those features will compose on top of. The future resource-plane SDD
can decide whether it needs serializable middleware/topology specs, stable component
identity, ordering, credential references, or other authoring constraints.

This is distinct from stdio-jsonl, which remains the v1 protocol for Firegrid
client-executed `ToolUse -> ToolResult` round-trip.
