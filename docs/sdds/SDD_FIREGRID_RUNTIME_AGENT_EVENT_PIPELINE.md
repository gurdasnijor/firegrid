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

The codec contract exposes capability flags used by pipeline routing. In v1 the
load-bearing flag is:

```ts
readonly toolUseMode: "client_result_roundtrip" | "observation_only"
```

This flag is read by the tool router at subscription time. The router claims
`ToolUse` rows only for contexts whose active codec advertises
`toolUseMode: "client_result_roundtrip"`; it does not claim rows from
observation-only codecs and then fail later during send.

`stdio-jsonl` uses `client_result_roundtrip` because Firegrid owns that wire
format and defines `tool_use` output followed by `tool_result` input. `acp`
uses `observation_only` because ACP `sessionUpdate.tool_call` is an
observation of agent-side or MCP tool activity, not a request for Firegrid to
execute a tool and inject a `ToolResult`.

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

Authorities can expose either:

- `Sink` values for stream-terminal writes; or
- `Effect` methods for command-handler writes.

Examples:

```txt
AgentOutputEvent stream -> RuntimeOutputJournal.eventSink
RuntimeIngressRequest   -> RuntimeIngressAppender.append(...)
run lifecycle transition -> RuntimeControlPlaneRecorder.recordStarted(...)
wait_for tool call -> DurableWaitStore.register(...)
```

### Subscribers

Subscribers read from durable seams and dispatch follow-up effects.

Subscribers consume only through `SourceCollections` handles exposed by
authority modules. They should not call `DurableTable.rows()` directly and
should not reach into table collections owned by other authorities.

Authority modules own both their write surface and their subscriber read
surface. For example, `RuntimeOutputJournal` owns writes to
`RuntimeOutputTable.events/logs` and exposes the source-collection handles for
runtime output observations. Host composition registers those handles with
`SourceCollections`; subscribers await and consume the handles by name.

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
source-collection handles for subscribers. Subscribers do not parse raw JSON
themselves.

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

ACP `sessionUpdate.tool_call` rows are modeled as durable observations in v1.
They are not dispatch candidates. The tool router does not claim them, and no
runtime-side subscriber is required to consume them in v1. They remain queryable
through the `RuntimeOutputJournal` read/source-collection surface for UI,
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

ACP Client capabilities are another Agent-to-Client JSON-RPC pattern. Firegrid
supports the permission capability because it maps directly to Firegrid's
durable wait/resume model: `session/request_permission` becomes durable
`PermissionRequest` output and resumes through `PermissionResponse` ingress.

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
- its `SourceCollectionHandle` read API, when subscribers or `wait_for` need to
  observe its rows.

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
rows. Code currently living in host-context authority that inserts local
`RuntimeContext` rows moves under this recorder authority. Host-context
authority remains the read/validation surface for `CurrentHostSession`,
`CurrentRuntimeContext`, `requireLocalContext`, and stream URL derivation; it
does not commit control-plane rows directly after the cutover.

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
- the source-collection handles each authority exposes;
- validation commands;
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

The v1 cutover does not implement ACP file-system or terminal Client
capability handlers. That is a scope decision for this pipeline SDD, not a
rejection of Firegrid's managed-agent direction. Firegrid is expected to grow a
resource plane for mounted resources, remote hands, secrets mediation, audit,
approval, and budget concerns. Those are orthogonal pipeline components and
authorities, not part of the Agent event-journal cutover.

Until that resource-plane SDD exists, the launched Agent process owns normal
filesystem and shell access inside its cwd/sandbox.

This is distinct from stdio-jsonl, which remains the v1 protocol for Firegrid
client-executed `ToolUse -> ToolResult` round-trip.
