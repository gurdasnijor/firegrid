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
- `RuntimeOutputJournal`, `RuntimeIngressAppender`, and the wait/tool
  authorities make session progress replayable and observable.
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
directly. Each durable table family has exactly one authority module, and that
module is the only code allowed to commit rows for that family.
```

Concrete authority modules:

- `RuntimeOutputJournal`
  - owns `RuntimeOutputTable.events`;
  - owns `RuntimeOutputTable.logs`;
  - exposes stream-terminal sinks for `AgentOutputEvent` and stderr/log rows.
- `RuntimeIngressAppender`
  - owns sequenced `RuntimeIngressTable.inputs` writes;
  - exposes command-handler methods such as `append(...)`.
- `RuntimeIngressDeliveryTracker`
  - owns `RuntimeIngressTable.deliveries`;
  - exposes claim/record methods used by delivery subscribers.
- `RuntimeControlPlaneRecorder`
  - owns `RuntimeControlPlaneTable.contexts`;
  - owns `RuntimeControlPlaneTable.runs`;
  - exposes context create/load and run lifecycle record methods.
- `DurableWaitStore`
  - owns durable wait rows and completions.
- App-owned `DurableTable` facades
  - owned by their app modules;
  - may expose their own app-level write authority if needed.

Some authorities expose `Sink` values because they terminate streams. Some
authorities expose `Effect`-returning command handlers because they handle
discrete commands. Both are write authorities.

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
  pipeline/
    compose.ts
    stage.ts
    README.md

  events/
    input.ts
    output.ts
    capabilities.ts

  sources/
    byte-stream.ts
    sandbox/
      index.ts
    README.md

  codecs/
    contract.ts
    runtime.ts
    acp/
      index.ts
      mapping.ts
    stdio-jsonl/
      index.ts
    README.md

  transforms/
    sequence.ts
    buffer.ts
    terminal.ts
    README.md

  authorities/
    runtime-output-journal.ts
    runtime-ingress-appender.ts
    runtime-ingress-delivery-tracker.ts
    runtime-control-plane-recorder.ts
    durable-wait-store.ts
    registry.ts
    README.md

  subscribers/
    ingress-delivery.ts
    tool-router.ts
    stderr-journal.ts
    substrate/
      subscription-router.ts
    README.md

  projections/
    from-codec-session.ts
    language-model/
      index.ts
      acp.ts
    README.md

  tools/
    schema/
      toolkit.ts
      tools.ts
    lowering/
      tool-use-to-effect.ts
      tool-host.ts

  waits/
    wait-for.ts
    source-collections.ts

  host/
    workflow-handler.ts
    authority-context.ts
    observation-sources.ts
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
- Authority writes are the durable commit points. Some are stream-terminal
  `Sink`s, such as `RuntimeOutputJournal.agentOutputSink`; others are command
  methods, such as `RuntimeIngressAppender.append(...)`.
- Authority read/observation surfaces are `SourceCollectionHandle`s over rows
  already committed by that authority. These are observation streams for
  `wait_for`, subscribers, metrics, and UI read models. They are not pipeline
  byte sources and they are not durable write sinks.
- Host observation wiring only registers authority read surfaces with
  `SourceCollections`. It does not own writes and should not introduce a
  second name for the same pipeline role.

The counterpart to a `RuntimeOutputJournal.sources(...).agentOutputEvents`
handle is therefore not another module under host wiring. Its write counterpart
is `RuntimeOutputJournal.writeEvent(...)` or
`RuntimeOutputJournal.agentOutputSink`. Likewise, the counterpart to
`RuntimeIngressAppender.sources(...).inputs` is
`RuntimeIngressAppender.append(...)`.

Use local names that keep this directionality visible, for example
`runtimeOutputObservationSources` or `runtimeOutputReadSources`, not generic
names like `outputSources` that can be confused with process/byte sources.

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
- authorities expose only their write APIs (`Sink` or command `Effect` methods)
  and typed read/observation `SourceCollectionHandle` surfaces;
- subscribers accept read/observation `SourceCollectionHandle` surfaces plus
  authority APIs, not raw `DurableTable` collection facades;
- pipeline/host composition accepts these stage contracts and wires them
  together, but does not construct protocol rows or mutate table collections
  directly.

Use `Schema` brands for identities that cross stage boundaries when the value
is otherwise just a string or number: runtime context ids, activity attempts,
tool-use ids, subscriber ids, runtime authority source names, and idempotency
keys. The goal is not elaborate nominal typing everywhere; it is to make
cross-stage routing bugs visible at compile time before semgrep has to catch
them.

`Stream`, `Sink`, and `Effect` types should encode directionality:

```ts
type RuntimeTransform<A, B, E = never, R = never> =
  (input: Stream.Stream<A, E, R>) => Stream.Stream<B, E, R>

type RuntimeAuthorityReadSurface<A> = SourceCollectionHandle

type RuntimeAuthorityCommand<A, E, R> = (input: A) => Effect.Effect<unknown, E, R>
```

The concrete implementation can choose better local names, but the public shape
must preserve the distinction: a read surface is not a source stage, a source
stage is not a journal sink, and a subscriber cannot become a hidden durable
writer by accepting a table facade.

### Substrate vs. Composition

The pipeline distinguishes two layers.

Authorities, source-collection contracts, and the codec runtime are substrate.
They define what writes a durable row, what reads a journal, and how protocol
sessions become normalized event streams. Substrate is change-controlled,
semgrep-enforced, and registered in the authority registry. Adding or modifying
substrate requires SDD/spec revision.

Subscribers, codec attachments, and routing components are composition. They
are pluggable wiring on top of substrate and can be added, removed, or
reconfigured without changing the authority registry. The permission-wait
bridge, the tool router, the ingress-delivery subscriber, and the stderr journal
are composition: they consume read/observation `SourceCollectionHandle`
surfaces, route through chosen logic, and append through authorities.

Composition is static, strongly typed pipeline wiring in this cutover. The
invariant is narrow: when a component affects durable behavior, it must do so
through read/observation `SourceCollectionHandle` surfaces and authority APIs so
its externally visible effects are durable, observable, and replay-safe. This
SDD does not introduce dynamic
middleware, a serializable topology specification, or user-authored runtime
closures.

`tools/lowering/tool-host.ts` contains the service tag/interface only. The
host-coupled live implementation belongs under
`host/agent-tool-host-live.ts`, because it fans out to
`RuntimeControlPlaneRecorder`, `RuntimeIngressAppender`, workflow execution,
and other host authorities.

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

### Authorities

Authorities are the only modules that write durable rows for their table
family.

Authority modules are one concept, not five unrelated concepts named
recorder/appender/tracker/journal/store. The implementation names may remain
domain-specific, but the exported shape should follow Effect's service and
capability pattern directly:

```ts
export class RuntimeOutputJournal extends Context.Tag(
  "@firegrid/runtime/RuntimeOutputJournal",
)<RuntimeOutputJournal, RuntimeOutputJournal.Service>() {}

export namespace RuntimeOutputJournal {
  export interface Service extends Write, Read {}
}
```

The table-backed implementation is a `Layer` that constructs the service from
the underlying `DurableTable` services. Runtime code depends on the service
through the Effect requirement channel or on a narrow structural capability
interface passed as a typed parameter. It does not depend on module-global
authority singletons and does not receive table facades.

This mirrors Effect's own least-privilege interfaces. `Queue.Queue<A>` extends
both `Queue.Enqueue<A>` and `Queue.Dequeue<A>`, while producers can depend only
on `Enqueue` and consumers can depend only on `Dequeue`. Runtime authorities
follow the same pattern: the full service composes write and read capabilities,
while subscribers and transforms receive only the capability they need.

The shared vocabulary is intentionally thin and expressed in Effect types:

```ts
type RuntimeAuthorityCommand<Input, Output, Error, Requirements = never> =
  (input: Input) => Effect.Effect<Output, Error, Requirements>

type RuntimeAuthoritySink<Input, Output, Error, Requirements = never> =
  Sink.Sink<Output, Input, never, Error, Requirements>

interface RuntimeAuthorityObservation<Row = unknown> {
  readonly name: RuntimeAuthoritySourceName
  readonly subscribe: () => Stream.Stream<Row, DurableTableError>
}
```

Write capabilities expose domain commands as `Effect` methods and, when the
authority terminates a stream, `Sink` values. Read capabilities expose named
read/observation `SourceCollectionHandle`-like surfaces. Neither side exposes
generic `DurableTable` CRUD.

Concrete authorities specialize the capability pattern:

```ts
export class RuntimeOutputJournal extends Context.Tag(
  "@firegrid/runtime/RuntimeOutputJournal",
)<RuntimeOutputJournal, RuntimeOutputJournal.Service>() {}

export namespace RuntimeOutputJournal {
  export interface Service extends Write, Read {}

  export interface Write {
    readonly writeEvent: RuntimeAuthorityCommand<
      RuntimeEventRow,
      RuntimeEventRow,
      RuntimeOutputError
    >
    readonly writeLog: RuntimeAuthorityCommand<
      RuntimeLogLineRow,
      RuntimeLogLineRow,
      RuntimeOutputError
    >
    readonly agentOutputSink: RuntimeAuthoritySink<
      RuntimeEventRow,
      RuntimeTerminalEvidence,
      RuntimeOutputError
    >
    readonly logSink: RuntimeAuthoritySink<
      RuntimeLogLineRow,
      void,
      RuntimeOutputError
    >
  }

  export interface Read {
    readonly events: RuntimeAuthorityObservation<RuntimeEventRow>
    readonly logs: RuntimeAuthorityObservation<RuntimeLogLineRow>
    readonly agentOutputEvents:
      RuntimeAuthorityObservation<RuntimeAgentOutputObservation>
  }
}

export class RuntimeIngressAppender extends Context.Tag(
  "@firegrid/runtime/RuntimeIngressAppender",
)<RuntimeIngressAppender, RuntimeIngressAppender.Service>() {}

export namespace RuntimeIngressAppender {
  export interface Service extends Write, Read {}

  export interface Write {
    readonly append: RuntimeAuthorityCommand<
      RuntimeIngressRequest,
      RuntimeIngressInputRow,
      RuntimeIngressAppendError
    >
    readonly findInput: RuntimeAuthorityCommand<
      RuntimeIngressInputId,
      Option.Option<RuntimeIngressInputRow>,
      RuntimeIngressReadError
    >
  }

  export interface Read {
    readonly inputs: RuntimeAuthorityObservation<RuntimeIngressInputRow>
  }
}
```

Other authorities follow the same service/capability shape:

```ts
export namespace RuntimeIngressDeliveryTracker {
  export interface Service extends Write, Read {}

  export interface Write {
    readonly claimInput: (
      row: RuntimeIngressInputRow,
      options: { readonly subscriberId: RuntimeSubscriberId },
    ) => Effect.Effect<
      Option.Option<RuntimeIngressDeliveryRow>,
      RuntimeIngressDeliveryError
    >
    readonly recordCompleted: RuntimeAuthorityCommand<
      RuntimeIngressDeliveryRow,
      RuntimeIngressDeliveryRow,
      RuntimeIngressDeliveryError
    >
  }

  export interface Read {
    readonly deliveries:
      RuntimeAuthorityObservation<RuntimeIngressDeliveryRow>
  }
}

export namespace RuntimeControlPlaneRecorder {
  export interface Service extends Write, Read {}

  export interface Write {
    readonly insertLocalContext: RuntimeAuthorityCommand<
      RuntimeContextIntent,
      RuntimeContext,
      RuntimeControlPlaneError
    >
    readonly recordStarted: RuntimeAuthorityCommand<
      RuntimeRunStart,
      RuntimeRunRow,
      RuntimeControlPlaneError
    >
    readonly recordExited: RuntimeAuthorityCommand<
      RuntimeRunExit,
      RuntimeRunRow,
      RuntimeControlPlaneError
    >
    readonly recordFailed: RuntimeAuthorityCommand<
      RuntimeRunFailure,
      RuntimeRunRow,
      RuntimeControlPlaneError
    >
  }

  export interface Read {
    readonly contexts: RuntimeAuthorityObservation<RuntimeContext>
    readonly runs: RuntimeAuthorityObservation<RuntimeRunRow>
  }
}

export namespace DurableWaitStore {
  export interface Service extends Write, Read {}

  export interface Write {
    readonly upsertWait: RuntimeAuthorityCommand<
      DurableWaitRow,
      DurableWaitRow,
      RuntimeWaitError
    >
    readonly upsertCompletion: RuntimeAuthorityCommand<
      DurableWaitCompletionRow,
      DurableWaitCompletionRow,
      RuntimeWaitError
    >
  }

  export interface Read {
    readonly waits: RuntimeAuthorityObservation<DurableWaitRow>
    readonly completions:
      RuntimeAuthorityObservation<DurableWaitCompletionRow>
  }
}
```

The concrete code should not introduce a shared runtime object API that every
authority must implement before there is a real generic operation to call.
`RuntimeAuthorityCommand`, `RuntimeAuthoritySink`, and
`RuntimeAuthorityObservation` are naming aids for the SDD and optional local
type aliases; the load-bearing contract is the Effect service tag plus
capability interfaces.

Subscriber dependencies should be least-privilege. For example, a tool router
that only observes output and appends ingress should be typed roughly as:

```ts
const runToolRouter = (
  options: {
    readonly output: RuntimeOutputJournal.Read
    readonly ingress: RuntimeIngressAppender.Write
    readonly waitStore: DurableWaitStore.Write
  },
) => Stream.runDrain(/* ... */)
```

or equivalently as an `Effect` requiring narrow service tags if the
implementation defines separate read/write tags. It should not accept
`RuntimeOutputTable`, `RuntimeIngressTable`, or the full
`RuntimeOutputJournal.Service` unless it truly needs the entire service.

The old generic shape below is not the target:

```ts
interface RuntimeAuthority<Write, Read> {
  readonly write: Write
  readonly read: Read
}

type RuntimeOutputAuthority =
  RuntimeAuthority<RuntimeOutputWrites, RuntimeOutputReads>

interface RuntimeOutputWrites {
  readonly writeEvent: RuntimeAuthorityCommand<RuntimeEventRow, RuntimeEventRow, RuntimeOutputError>
  readonly writeLog: RuntimeAuthorityCommand<RuntimeLogLineRow, RuntimeLogLineRow, RuntimeOutputError>
  readonly agentOutputSink: RuntimeAuthoritySink<RuntimeEventRow, RuntimeTerminalEvidence, RuntimeOutputError>
  readonly logSink: RuntimeAuthoritySink<RuntimeLogLineRow, void, RuntimeOutputError>
}

interface RuntimeOutputReads {
  readonly events: RuntimeAuthorityRead<RuntimeEventRow>
  readonly logs: RuntimeAuthorityRead<RuntimeLogLineRow>
  readonly agentOutputEvents: RuntimeAuthorityRead<RuntimeAgentOutputObservation>
}

type RuntimeOutputAuthority =
  RuntimeAuthority<RuntimeOutputWrites, RuntimeOutputReads>

interface RuntimeIngressWrites {
  readonly append: RuntimeAuthorityCommand<RuntimeIngressRequest, RuntimeIngressInputRow, RuntimeIngressAppendError>
  readonly findInput: RuntimeAuthorityCommand<RuntimeIngressInputId, Option.Option<RuntimeIngressInputRow>, RuntimeIngressReadError>
}

interface RuntimeIngressReads {
  readonly inputs: RuntimeAuthorityRead<RuntimeIngressInputRow>
}

type RuntimeIngressAuthority =
  RuntimeAuthority<RuntimeIngressWrites, RuntimeIngressReads>

interface RuntimeIngressDeliveryWrites {
  readonly claimInput: (
    row: RuntimeIngressInputRow,
    options: { readonly subscriberId: RuntimeSubscriberId },
  ) => Effect.Effect<Option.Option<RuntimeIngressDeliveryRow>, RuntimeIngressDeliveryError>
  readonly recordCompleted: RuntimeAuthorityCommand<RuntimeIngressDeliveryRow, RuntimeIngressDeliveryRow, RuntimeIngressDeliveryError>
}

interface RuntimeIngressDeliveryReads {
  readonly deliveries: RuntimeAuthorityRead<RuntimeIngressDeliveryRow>
}

type RuntimeIngressDeliveryAuthority =
  RuntimeAuthority<RuntimeIngressDeliveryWrites, RuntimeIngressDeliveryReads>

interface RuntimeControlPlaneWrites {
  readonly insertLocalContext: RuntimeAuthorityCommand<RuntimeContextIntent, RuntimeContext, RuntimeControlPlaneError>
  readonly recordStarted: RuntimeAuthorityCommand<RuntimeRunStart, RuntimeRunRow, RuntimeControlPlaneError>
  readonly recordExited: RuntimeAuthorityCommand<RuntimeRunExit, RuntimeRunRow, RuntimeControlPlaneError>
  readonly recordFailed: RuntimeAuthorityCommand<RuntimeRunFailure, RuntimeRunRow, RuntimeControlPlaneError>
}

interface RuntimeControlPlaneReads {
  readonly contexts: RuntimeAuthorityRead<RuntimeContext>
  readonly runs: RuntimeAuthorityRead<RuntimeRunRow>
}

type RuntimeControlPlaneAuthority =
  RuntimeAuthority<RuntimeControlPlaneWrites, RuntimeControlPlaneReads>

interface RuntimeWaitWrites {
  readonly upsertWait: RuntimeAuthorityCommand<DurableWaitRow, DurableWaitRow, RuntimeWaitError>
  readonly upsertCompletion: RuntimeAuthorityCommand<DurableWaitCompletionRow, DurableWaitCompletionRow, RuntimeWaitError>
}

interface RuntimeWaitReads {
  readonly waits: RuntimeAuthorityRead<DurableWaitRow>
  readonly completions: RuntimeAuthorityRead<DurableWaitCompletionRow>
}

type RuntimeWaitAuthority =
  RuntimeAuthority<RuntimeWaitWrites, RuntimeWaitReads>
```

That generic wrapper adds vocabulary without adding capability isolation. The
target is closer to Effect's existing `Context.Tag` services and
`Queue.Enqueue`/`Queue.Dequeue` split: domain service tags with narrow
capability interfaces.

Examples:

```txt
AgentOutputEvent stream -> RuntimeOutputJournal.agentOutputSink
RuntimeIngressRequest   -> RuntimeIngressAppender.append(...)
run lifecycle transition -> RuntimeControlPlaneRecorder.recordStarted(...)
wait_for tool call -> DurableWaitStore.register(...)
```

This does not replace `DurableTable`. `DurableTable` remains the storage and
live-row primitive. Authorities encode Firegrid runtime policy over that
primitive: sequencing, idempotency, claim keys, output envelopes, lifecycle
state, and read/observation handles. If an authority starts exposing generic
`insert`, `upsert`, `delete`, or `rows` methods, it has become a disguised table
facade and violates this SDD.

### Subscribers

Subscribers read from durable seams and dispatch follow-up effects.

Subscribers consume only through read/observation `SourceCollectionHandle`
surfaces exposed by authority modules. They should not call
`DurableTable.rows()` directly and should not reach into table collections owned
by other authorities.

Authority modules own both their write surface and their subscriber read
surface. For example, `RuntimeOutputJournal` owns writes to
`RuntimeOutputTable.events/logs` and exposes read/observation
`SourceCollectionHandle` surfaces for runtime output observations. Host
composition registers those handles with `SourceCollections`; subscribers await
and consume the handles by name.

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
  -> RuntimeOutputJournal sink
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

      return yield* session.outputs.pipe(
        Transforms.codecOutputBuffer,
        Transforms.sequenceAndStamp(options.context, options.activityAttempt),
        Stream.ensuring(commitSessionCheckpoint(options.context)),
        Stream.run(RuntimeOutputJournal.agentOutputSink),
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
  -> RuntimeOutputJournal commits ToolUse row
  -> ToolRouter subscriber observes durable ToolUse row
  -> toolUseToEffect runs under workflow/tool authority
  -> RuntimeIngressAppender appends ToolResult control/input row
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

`RuntimeOutputJournal` writes `RuntimeEventRow.raw` as the schema-encoded
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

`RuntimeOutputJournal` uses the encoder for writes and exposes decoded
read/observation `SourceCollectionHandle` surfaces for subscribers. Subscribers
do not parse raw JSON themselves.

### ToolResult Idempotency

Subscriber-produced tool results append through `RuntimeIngressAppender` with
this idempotency key:

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
`RuntimeOutputJournal` read/observation `SourceCollectionHandle` surface for UI,
metrics, tracing, and future observation-consuming subscribers.

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
  -> RuntimeOutputJournal commits the PermissionRequest row
  -> RuntimeOutputJournal exposes a decoded permission observation source
  -> wait_for / session.wait.forPermissionRequest matches that source
  -> human/product/runtime writes a PermissionResponse through RuntimeIngressAppender
  -> IngressDelivery subscriber sends PermissionResponse to the active codec
  -> AcpCodec resolves the pending ACP requestPermission promise
  -> ACP Agent continues or rejects based on the selected decision
```

`PermissionRequest` is durable because it is first committed to
`RuntimeOutputTable.events`. `wait_for` observes it through the same
`SourceCollections` read surface exposed by `RuntimeOutputJournal`; it must not
parse raw output rows or subscribe to codec internals.

`PermissionResponse` is durable because it is appended through
`RuntimeIngressAppender` as a control input row. The ingress delivery subscriber
is responsible for delivering that row to the active codec session and recording
delivery evidence through `RuntimeIngressDeliveryTracker`.

This keeps permission semantics aligned with the rest of the pipeline:

- observation is output-journal authority;
- waiting is durable wait authority over a source collection;
- response is ingress-appender authority;
- delivery is ingress-delivery authority;
- codec-specific ACP promise resolution remains inside `AcpCodec`.

The permission bridge is an ordinary pipeline subscriber. It consumes the
`RuntimeOutputJournal` permission observation source, waits for or delegates to
a human/product decision source, and appends the response through
`RuntimeIngressAppender`. It does not talk to `AcpCodec` directly:

```ts
const permissionWaitBridge = (options) =>
  SourceCollections.stream(
    RuntimeOutputJournal.sources.agentOutputEvents,
    {
      whereFields: {
        contextId: options.contextId,
        _tag: "PermissionRequest",
      },
    },
  ).pipe(
    Stream.mapEffect(permission =>
      DurableWaitStore.waitFor({
        source: options.permissionDecisionSource,
        whereFields: {
          contextId: options.contextId,
          permissionRequestId: permission.permissionRequestId,
        },
      }).pipe(
        Effect.flatMap(decision =>
          RuntimeIngressAppender.append({
            contextId: options.contextId,
            kind: "control",
            payload: {
              _tag: "PermissionResponse",
              permissionRequestId: permission.permissionRequestId,
              decision,
            },
            idempotencyKey:
              `permission-response:${options.contextId}:${permission.permissionRequestId}`,
          }),
        ),
      )
    ),
    Stream.runDrain,
  )
```

The ingress-delivery subscriber shown in the runtime composition sketch is what
later reads that `PermissionResponse` row and calls `session.send(...)`. For ACP
sessions, `AcpCodec.send(PermissionResponse)` resolves the pending
`session/request_permission` promise. For other codecs, permission input support
is codec-specific, but the durable wait and ingress authority shape stays the
same.

The permission-wait bridge is the v1 instance of the general
`control_channel_request_response` capability pattern. Each such capability is
a subscriber that consumes an observation source from `RuntimeOutputJournal`,
routes through a durable wait or backend source, and appends evidence through
`RuntimeIngressAppender`. The active codec resolves the protocol-specific
request from the delivered response. Future capability bridges, such as ACP
file/terminal handlers or Codex app-server dynamic tool methods, do not require
new substrate authorities by default; they compose on the substrate this SDD
defines. The substrate guarantee for capability bridges is: an observation
source on `RuntimeOutputJournal`, durable wait through `DurableWaitStore`,
evidence append through `RuntimeIngressAppender`, and ingress delivery to the
active codec. A capability that fits this shape composes; a capability that does
not fit this shape requires substrate revision through a new SDD.

If the Agent process dies after the `PermissionRequest` row is committed but
before the response is delivered, the committed request remains observable. A
later runtime attempt may resume only if the codec/session can recreate or
re-associate the pending protocol request; otherwise the response remains
durable ingress evidence for the terminated attempt. The event-pipeline cutover
does not invent protocol-level rewind semantics for ACP.

## Authority Registry And Enforcement

The table-to-authority mapping should live in one canonical file, for example:

```txt
packages/runtime/src/authorities/registry.ts
```

The registry documents which module owns writes for each table family:

```txt
RuntimeOutputTable.events/logs -> authorities/runtime-output-journal.ts
RuntimeIngressTable.inputs -> authorities/runtime-ingress-appender.ts
RuntimeIngressTable.deliveries -> authorities/runtime-ingress-delivery-tracker.ts
RuntimeControlPlaneTable.contexts/runs -> authorities/runtime-control-plane-recorder.ts
DurableTools wait rows -> authorities/durable-wait-store.ts
```

Each authority declares both:

- its write API; and
- its read/observation `SourceCollectionHandle` API, when subscribers or
  `wait_for` need to observe its rows.

`RuntimeIngressDeliveryTracker` is a single authority for all
`RuntimeIngressTable.deliveries` rows. Raw stdin delivery and each codec
delivery path share the tracker; `subscriberId` is the namespace dimension.
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

`RuntimeControlPlaneRecorder` owns both context insertion and run lifecycle
rows. Runtime host-facing local `RuntimeContext` insertion moves under this
recorder authority. Host-context authority remains the read/validation surface
for `CurrentHostSession`, `CurrentRuntimeContext`, `requireLocalContext`, and
stream URL derivation; runtime must not re-export its legacy context write
helper.

The protocol-level `insertLocalRuntimeContext` helper remains a deprecated
browser-safe compatibility path during the cutover for callers that cannot
import `@firegrid/runtime`. It is not a runtime write authority and is tracked
by `firegrid-runtime-agent-event-pipeline.TRANSACTIONAL_CUTOVER.3-2` until a
browser-safe command authority replaces it.

The file currently named `host-context-authority.ts` is renamed to
`host/authority-context.ts` in the cutover so the name reflects its read and
validation role rather than implying control-plane write ownership.

Semgrep should reject direct `.insert`, `.upsert`, and `.delete` calls against
DurableTable collection facades outside the owning authority module, tests, and
explicit app-owned table modules.

The semgrep rule fires on direct collection-facade mutation calls. Calls to
authority methods such as `RuntimeIngressAppender.append(...)` or
`RuntimeOutputJournal.writeEvent(...)` are allowed. Test harness allowlists must
be explicit; harnesses that are exercising production behavior should use the
authority APIs instead of direct table writes.

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
yield* sources.register(sourceCollectionHandle("darkFactory.events", table.events))
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

1. `packages/runtime/src/pipeline/README.md`;
2. `packages/runtime/src/pipeline/compose.ts`;
3. `packages/runtime/src/authorities/registry.ts`;
4. the stage README files;
5. the ACID-linked tests.

The PR description should include:

- the full target tree;
- every satisfied ACID from `firegrid-runtime-agent-event-pipeline`;
- the authority registry table;
- the read/observation `SourceCollectionHandle` surfaces each authority exposes;
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

`RuntimeOutputJournal.agentOutputSink` returns a result that includes the
decoded terminal event. It commits the `Terminated` event row before returning
that result. `host/workflow-handler.ts` uses the sink result to call
`RuntimeControlPlaneRecorder.recordExited(...)` or
`recordFailed(...)`.

The committed journal row remains the durable source of truth. The returned
sink result is the in-process handoff that avoids re-reading the same row in
the hot path while preserving journal-first ordering.

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
   journal source, routes through a chosen backend, and appends evidence through
   the appropriate authority. It does not require new substrate authorities by
   default; `RuntimeOutputJournal` and `RuntimeIngressAppender` are the
   journaling targets.

Both halves are orthogonal to this event-pipeline cutover. The pipeline's
authority pattern and source-collection contract are the substrate those
features will compose on top of. The future resource-plane SDD can decide
whether it needs serializable middleware/topology specs, stable component
identity, ordering, credential references, or other authoring constraints.

This is distinct from stdio-jsonl, which remains the v1 protocol for Firegrid
client-executed `ToolUse -> ToolResult` round-trip.
