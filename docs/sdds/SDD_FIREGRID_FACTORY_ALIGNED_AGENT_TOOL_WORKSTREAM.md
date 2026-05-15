# SDD: Factory-Aligned Agent Tool Workstream

Status: Draft for dispatch

## Problem

The dark factory process is a product proof point for agent choreography:
one planning agent should be able to take a ticket, delegate specialized work,
wait for human or system facts, and decide the next step by using durable
Firegrid tools.

Firegrid should not encode the factory sequence as a platform workflow, a
Flamecast-specific orchestration runtime, or a new top-level factory product.
The platform work is to make the ordinary `FiregridAgentToolkit` powerful
enough that the central planning agent can choreograph the run itself.

The dark factory PRD is written from the Flamecast product plane, so it says
Flamecast owns durable sessions, permission gates, child work, callbacks, and
observation. In this Firegrid workstream, that means:

- product-facing Flamecast sessions may name and display those concepts;
- execution-facing durability should be supplied by Firegrid runtime contexts,
  runtime ingress, durable tool calls, wait facts, and runtime output;
- only product/API projection work should stay in Flamecast.

The code-grounded factory requirements confirm the same split. The current
hook.new implementation already depends on a durable parent run, child work
linkage, ordered history, source-event dedupe, permission waits, external event
append, and runtime-owned policy. Firegrid should provide the execution
substrate pieces that let a planning agent use those primitives; Flamecast can
project them as product sessions/events.

This follows the Fireline choreography lesson:

- durable primitives belong in the substrate;
- the agent owns sequencing, branching, and parallelism;
- observability makes dynamic scheduling legible;
- product shells such as Flamecast project and route events, but do not own the
  execution graph.

## Source Inputs

- `/Users/gnijor/smithery/flamecast-agents/DARK_FACTORY_PROCESS_PRD.md`
- `/Users/gnijor/smithery/flamecast-agents/DARK_FACTORY_CODE_GROUNDED_REQUIREMENTS.md`
- `/Users/gnijor/gurdasnijor/fireline/vault/canon/concepts/choreography-vs-orchestration.md`
- `packages/runtime/src/agent-tools/tools.ts`
- `packages/runtime/src/agent-tools/tool-use-to-effect.ts`
- `packages/runtime/src/agent-io/contract.ts`
- `packages/runtime/src/agent-io/codec.ts`
- `packages/runtime/src/agent-codecs/acp/index.ts`
- `packages/runtime/src/agent-codecs/stdio-jsonl/index.ts`
- `packages/runtime/src/runtime-host/index.ts`
- `features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`

## Current Firegrid State

Firegrid already exposes most of the right capability surface:

- `sleep`
- `wait_for`
- `schedule_me`
- `execute`

It also currently exposes `spawn` and `spawn_all`. Those names are useful as
the current host-lowering seam, but they are not the target agent-facing
abstraction for factory work. The public semantics should be session-plane:
create or resume a child session, prompt it, cancel or close it, and observe
durable updates. Internally, a `session_new` tool can still lower through
`AgentToolHost.spawnChildContext`.

This aligns with ACP's split:

- `initialize` negotiates protocol and capabilities before session work;
- `session/new`, `session/load`, and `session/resume` establish conversation
  state;
- `session/prompt`, `session/cancel`, and `session/close` operate by
  `sessionId`.

It also aligns with the current Flamecast SDK surface:

- `sessions.create` creates a session with agent config, input, metadata,
  permission mode, and async behavior;
- `sessions.sendMessage` sends another turn to the same session;
- `sessions.events` / `eventsLive` expose durable ordered observation;
- `SessionState.status` projects lifecycle as `created`, `running`,
  `input_required`, `done`, `failed`, `aborted`, or `idle`;
- `sessions.cancel` and `sessions.abort` exist, but they can be deferred behind
  session creation, prompting, and observation for the first factory slice.

The tool definitions and lowering should remain schema-owned and flow through
Effect AI `Tool` / `Toolkit`.

Firegrid also already has the protocol-neutral event contract for agent I/O:
`AgentCodec` maps ACP, stdio-jsonl, and future wire formats into
`AgentOutputEvent` / `AgentInputEvent`. `AcpCodec` can emit
`PermissionRequest` events and accept `PermissionResponse` input; the
stdio-jsonl codec can emit text, tool, status, error, completion, and
termination events.

The important runtime gap is not the lack of a durable journal. The runtime
host already writes `ProcessOutputChunk` rows to `RuntimeOutputTable`. The gap
is that the host does not yet select a codec, open the agent byte stream, and
materialize decoded `AgentOutputEvent` values as structured durable output.
Until that bridge exists, ACP permission requests are modeled in the codec
surface but are not yet durable session-plane observations that a planner or
product shell can wait on.

The live host implementation is the gap:

- `schedule_me` is wired through host-owned prompt ingress.
- session-plane child creation is still unsupported in
  `RuntimeHostAgentToolHostLive`; the existing internal host seam is
  `spawnChildContext`.
- session-plane fanout is still unsupported in `RuntimeHostAgentToolHostLive`;
  the existing internal host seam is `spawnChildContexts`.
- session-bound capability execution is still unsupported in
  `RuntimeHostAgentToolHostLive`; the current bridge seam is
  `executeSandboxTool`.

Therefore the factory-aligned workstream is not "build factory orchestration".
It is "wire the generic tool primitives the planning agent needs."

## Product-To-Tool Mapping

| Dark factory process need | Firegrid primitive |
| --- | --- |
| One Linear ticket is one durable parent run | Parent session/context metadata on the planning `RuntimeContext` |
| Planner studies ticket and repository context | Initial prompt plus session-bound filesystem/terminal/external facts |
| Planner starts implementation/review/QA work | `session_new` / batch session creation, backed by host child-context launch |
| Planner sends follow-up work | `session_prompt` or host/client prompt dispatch |
| Planner waits for delegated work | session terminal result, session updates, or `wait_for` when work is event-driven |
| Planner asks for human approval or clarification | `wait_for` over a durable decision/event source |
| Linear/GitHub/user webhook redelivery | source-event ids on external facts for dedupe |
| Planner resumes later | `schedule_me` |
| Planner reads/writes repo files or runs commands | session-bound filesystem / terminal capabilities |
| Planner checks CI, PR status, or external system state | `wait_for` over verified webhook facts, or explicitly bound session capability |
| Flamecast displays progress | Projection of Firegrid runtime output/tool events |

Flamecast may create sessions, store external identifiers, route Linear/user
events into Firegrid, and project results. It should not own the choreography.

## Ordered Requirements

The ordering below is by load-bearing value for the dark factory use case.

### 1. ACP Adapter Proof

ACID: `firegrid-factory-aligned-agent-tools.ADAPTER.1`

The planning agent must be able to run through an agent adapter path that is
aligned with Effect AI and ACP. Without this, later tool improvements are hard
to validate against real long-running agents.

This is already active as the ACP Adapter Proof lane from
`docs/proposals/effect-ai-native-agents.md` Slice 2.

Expected outcome:

- ACP can present a `LanguageModel.Service` view.
- Existing `AcpCodec` remains exported.
- Runtime-host integration is still deferred.

### 1A. Runtime Codec Event Plane

ACID: `firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1`

The factory path needs real agent protocol events to become durable session
observations. This is especially important for permissions: `AcpCodec` already
knows how to turn ACP `requestPermission` into an `AgentOutputEvent`, but the
runtime host currently journals raw process output rather than decoded codec
events.

This slice connects existing primitives instead of introducing a new event
system:

- the launch contract selects the agent protocol or codec separately from the
  process/sandbox backend;
- runtime host starts the process through `SandboxProvider` as it does today;
- for codec-backed launches, runtime host opens the selected `AgentCodec`
  against the process byte stream;
- prompt ingress, tool results, permission responses, cancellation, and
  termination flow into `codec.send`;
- decoded `AgentOutputEvent` values are journaled as structured durable runtime
  output rows;
- `ToolUse` events lower through the existing agent-tool path and write
  `ToolResult` input back to the codec only for codecs that support
  `ToolResult` input; ACP tool calls are journaled as observations until a real
  ACP tool-result seam exists;
- `PermissionRequest` events become durable observable state that products,
  humans, or agents can resolve by writing `PermissionResponse` ingress;
- raw process-output journaling remains available for plain local-process
  compatibility.

Expected outcome:

- ACP permissions, tool calls, completion, and status updates are observable
  through the same durable runtime/session history as local process output.
- A planning agent can use `wait_for` over durable observations rather than
  relying on hidden callback markers or protocol-specific side channels.
- No Flamecast-specific permission table, custom ACP protocol, or new factory
  orchestrator is introduced.

Implementation boundary for the first slice:

- add the minimal launch/runtime discriminator needed to choose raw process,
  stdio-jsonl codec, or ACP codec execution;
- keep the existing raw `streamSandboxProcess` path for raw local-process
  commands;
- add a codec-backed runtime path that opens process bytes, opens the selected
  `AgentCodec`, forwards runtime ingress into `codec.send`, and journals
  decoded `AgentOutputEvent` values;
- route `ToolUse` through the existing agent-tool lowering only for codecs that
  support `ToolResult` input; ACP `ToolUse` must not claim round-trip support
  unless `AcpCodec.send(ToolResult)` is implemented;
- do not delete `agent-adapters/acp`, remove `RuntimeContextWorkflow`, or
  refactor host layer topology in this slice.

### 2. Session Creation Tool

ACID: `firegrid-factory-aligned-agent-tools.SESSION.1`

The planner must be able to create one child session and receive a durable
session handle. This is the most load-bearing choreography primitive for the
factory: implementation, review, QA, and council work all reduce to child
session work.

The exposed semantics should stay close to ACP session setup, not host
spawning. The exact tool name can be revisited, but the target shape is
`session_new` or equivalent rather than `spawn`. Flamecast SDK's
`sessions.create` is the closest product-facing reference shape: agent
selector/config, initial input, metadata, permission policy, and async session
start.

Required behavior:

- The tool creates a child `RuntimeContext` as Firegrid's current durable
  session backing identity.
- The child carries parent/correlation metadata from session metadata,
  including fields such as `parentSessionId`, `role`, and `correlationId`
  when supplied by the planning agent or product shell.
- Child context identity is deterministic enough for workflow replay safety.
- The tool returns a session-shaped handle containing at least `sessionId` and
  `contextId`, current status, and metadata needed for projection.
- Awaiting terminal completion is modeled through durable session events,
  projections, or `wait_for` after `session_new` returns; `session_new` itself
  is not a hidden synchronous child-run primitive.
- No Flamecast-specific role enum is introduced; roles are metadata.
- `RuntimeHostAgentToolHostLive` may implement this by lowering to the existing
  `spawnChildContext` host seam.

Expected outcome:

- A planning agent can call a session creation tool with an agent selector,
  prompt, and metadata, then receive a durable child session handle. Terminal
  completion is observed later through durable observations or `wait_for`.

### 2A. Parent Session Identity

ACID: `firegrid-factory-aligned-agent-tools.SESSION.3`

The factory run needs one durable parent session/context identity. In the
current hook.new implementation, Linear `AgentSession` accidentally acts as
that identity. Firegrid should make the parent identity explicit enough that
child sessions, wait facts, external events, and product projections can attach
to it without encoding ids in comments or callback markers.

Required behavior:

- The planning `RuntimeContext` can carry parent-run metadata such as external
  ticket id, product session id, and correlation id.
- Child session creation copies or references the parent identity explicitly.
- The parent identity is queryable from runtime output/facts enough for
  product projection.
- No additional context placement table or workflow product is introduced for
  this purpose.

Expected outcome:

- One Linear ticket or equivalent external trigger maps to one durable
  Firegrid-backed parent run identity, with child work attached by metadata
  rather than hidden strings.

### 2B. Idempotent Parent Run Create/Load

ACID: `firegrid-factory-aligned-agent-tools.SESSION.5`

External triggers for factory work are at-least-once. A Linear issue update,
ticket event, webhook delivery, or product callback may be redelivered while
the parent planning run already exists. Firegrid should create or load the
same parent run from the external source key instead of creating competing
parent contexts.

Required behavior:

- Parent run create/load accepts or derives an external source key containing
  the provider or source identity plus an external id such as Linear issue id,
  ticket id, or correlation id.
- Duplicate external triggers with the same external source key resolve to the
  same parent `RuntimeContext` and product session identity.
- Child sessions, permission facts, wait facts, runtime output, and product
  projection attach to that loaded parent identity.
- A conflicting trigger for the same external source key does not overwrite the
  existing parent run metadata silently.
- No factory workflow product, hidden callback marker, or Flamecast-specific
  role enum is introduced to enforce this idempotency.

Expected outcome:

- At-least-once external delivery for one ticket or correlation id resumes the
  same Firegrid-backed parent run instead of splitting planner state across
  duplicate parent sessions.

### 3. Session-Bound Client Capabilities

ACID: `firegrid-factory-aligned-agent-tools.CAPABILITY.1`

The planner needs access to files, shell commands, and other bounded resources
inside the active session environment. This is not a separate host-plane
"execute arbitrary external action" concept. It is the agent using capabilities
declared for the session.

ACP is the reference shape:

- clients advertise filesystem support during `initialize`;
- agents call `fs/read_text_file` and `fs/write_text_file` with a `sessionId`;
- clients advertise terminal support during `initialize`;
- agents call `terminal/create`, `terminal/output`, `terminal/wait_for_exit`,
  `terminal/kill`, and `terminal/release` with a `sessionId`.

Firegrid can keep the existing `execute` tool as an implementation bridge, but
the semantics should be "use a bound session capability" rather than "ask the
host to run a generic external command".

Required behavior:

- Session creation records or resolves the bounded capabilities available to
  that session.
- Filesystem/terminal access is scoped by session identity and host authority.
- Capability availability is declarative and discoverable by the agent or
  adapter before use.
- Credentials and ambient authority stay host-side.
- Unsupported capability calls fail as tool results, not by silently no-oping.

Expected outcome:

- A planning agent can inspect repository state and run bounded commands using
  capabilities attached to its session, without learning host provisioning
  details.

### 4. Decision/Event Fact Source For `wait_for`

ACID: `firegrid-factory-aligned-agent-tools.WAIT_FOR.1`

Human approvals, Linear replies, CI updates, and webhook deliveries should
arrive as durable facts that `wait_for` can match. Firegrid should not add a
Flamecast-native wait loop for those decisions.

The code-grounded factory requirements make this load-bearing: today's system
uses parked hook.new RPCs, hidden callback markers, and Linear/GitHub ad hoc
dedupe. The Firegrid-aligned replacement is explicit fact/event append with
source ids and ordered observation.

Required behavior:

- There is a host-owned source collection suitable for app/user/external facts.
- Facts have stable identifiers so duplicate webhook/input delivery is
  idempotent.
- Facts carry source identity such as provider, delivery id, runtime source id,
  external id, and parent/session correlation where available.
- Fact append preserves a durable order visible to the planning agent and
  product projection.
- `wait_for` can match scalar fields such as `contextId`, `kind`,
  `correlationId`, and external ids.
- Permission waits are represented as explicit facts/events such as
  `permission_requested`, `permission_resolved`, and cancellation/rejection
  variants, not hidden callback comments.
- `permission_requested` records at least `permissionId`, `parentSessionId` or
  `contextId`, `kind`, `prompt`, `choices`, `correlationId`, `requestedBy`, and
  expiry or status when needed.
- `permission_resolved` matches the request by `permissionId` and records the
  selected choice, rejection, cancellation, or expiry.
- Flamecast or another product shell can append/project facts without becoming
  the orchestrator or the execution wait substrate.

Expected outcome:

- A planning agent can request a decision in ordinary language, then call
  `wait_for` against a durable fact query and continue from the result.

### 4A. Permission Fact Shape

ACID: `firegrid-factory-aligned-agent-tools.WAIT_FOR.3`

Human gates should be ordinary durable facts, not a private callback protocol.
The fact shape only needs enough structure for a planner, product shell, and
human responder to correlate the request and resolution.

Required behavior:

- `permission_requested` includes `permissionId`, `parentSessionId` or
  `contextId`, `kind`, `prompt`, `choices`, `correlationId`, `requestedBy`, and
  expiry or status when needed.
- `permission_resolved` matches the request by `permissionId`.
- Resolution records the selected choice, rejection, cancellation, or expiry.
- The permission facts remain source-neutral and product-projectable; they do
  not introduce hidden callback markers or a factory workflow product.

Expected outcome:

- A planning agent can ask for a human decision, wait on `permissionId` or
  correlation fields, and continue from the durable resolved fact.

### 5. Prompt Dispatch To Existing Contexts

ACID: `firegrid-factory-aligned-agent-tools.PROMPT_DISPATCH.1`

Some child work is not a one-shot run. The planner may need to send a follow-up
prompt to an existing child session or route a human reply into the active
parent session. If existing ingress APIs are enough, this can remain a
host/client API. If agents need to do it directly, expose `session_prompt` or a
small equivalent toolkit primitive after session creation is live.

Flamecast SDK's `sessions.sendMessage(sessionId, { message, async })` is the
closest product-facing reference shape.

Required behavior:

- Prompt dispatch uses host-owned runtime ingress, not a private path.
- Dispatch requires explicit context authority.
- It carries correlation metadata where available.
- Duplicate dispatch is idempotent by input id.

Expected outcome:

- The factory can support clarification/revision loops without restarting
  child sessions unnecessarily.

### 5A. Session Status And Observation

ACID: `firegrid-factory-aligned-agent-tools.OBSERVATION.2`

The planner needs a stable status projection for durable session observation.
The Flamecast SDK status vocabulary is the most useful reference:
`created`, `running`, `input_required`, `done`, `failed`, `aborted`, and
`idle`.

Required behavior:

- Session handles and/or event projections expose a status compatible with the
  above vocabulary or a clearly mapped subset.
- `wait_for` can observe status changes or terminal-state facts by `sessionId`
  / `contextId`.
- Awaiting a child session means waiting on these durable observations, not
  blocking inside session creation.
- `input_required` can represent human/app input needed to continue a turn.

Expected outcome:

- A planning agent can create a child session, continue other work, then wait
  for `done`, `failed`, `aborted`, or `input_required` when that state matters.

### 5B. Session Cancel And Abort

ACID: `firegrid-factory-aligned-agent-tools.SESSION.4`

Cancellation and abort semantics are useful but not first-slice load-bearing.
They should be deferred unless the first factory path needs them immediately.

Required behavior when implemented:

- `session_cancel` cancels current in-flight turn work without necessarily
  deleting the session.
- `session_abort` marks the session/run as aborted and stops further work.
- Both operations route through host/runtime authority and emit durable facts.
- If exposed before real support exists, they fail explicitly rather than
  silently no-oping.

Expected outcome:

- The tool layer can later distinguish "stop this turn" from "abort this
  session" without overloading `session_close`.

### 6. Batch Session Creation

ACID: `firegrid-factory-aligned-agent-tools.SESSION.2`

Batch/fanout session creation is useful, but it is not load-bearing for the
first factory-aligned path. It is a generalized convenience over repeated
single-session creation, not a separate orchestration concept.

Required behavior:

- Batch session creation lowers each task through the same child launch path as
  single session creation.
- Each child identity is deterministic from parent context, tool use id, and
  task key/index.
- Results preserve task keys.
- Failure of one child is represented in that child's terminal state, not by
  failing the entire tool workflow unless the launch machinery itself failed.

Expected outcome:

- A planning agent can create reviewer or QA child sessions in one call and
  inspect all session handles or terminal results when fanout ergonomics become
  worth adding.

### 7. Observation And Introspection

ACID: `firegrid-factory-aligned-agent-tools.OBSERVATION.1`

Choreography trades static DAG determinism for runtime decisions. The planning
agent and operator need durable observation of those decisions.

Required behavior:

- Tool calls and results are visible in runtime output/events.
- Child session/context ids are returned and projectable.
- Parent/child/correlation metadata is queryable enough for product projection.
- Runtime output/facts provide ordered history sufficient for a planning agent
  to decide the next action from prior state.
- The agent can read enough prior context/output through existing tools or
  client APIs to avoid repeating work.
- Flamecast can present product states such as `planning`,
  `waiting_for_plan_decision`, or `reviewing`, but those states are projections
  over durable runtime events rather than a hard-coded workflow definition.

Expected outcome:

- A human can answer which child sessions the planning agent created, what
  completed, what is waiting, and why the run stopped.

## Non-Goals

- No factory-specific runtime or workflow product.
- No Flamecast-owned choreography engine.
- No hidden callback marker protocol.
- No `rpc.next()`-style wait primitive as a product API.
- No broad operator UI.
- No generic webhook marketplace.
- No hard-coded planner/implementer/QA/council sequence in TypeScript.
- No hidden callback markers or string-encoded child session ids as a new
  convention.
- No broad Linear/GitHub webhook product before the first factory path; the
  needed primitive is source-deduped event/fact append.

## Tonight-Oriented Dispatch Order

1. Continue ACP Adapter Proof.
2. Wire live session creation backed by `spawnChildContext`.
3. Add or designate a durable fact source for approvals/replies/CI updates so
   `wait_for` can be used for human and external gates.
4. If tonight includes human gates, wire permission facts and `wait_for`
   observation in parallel with `session_new` rather than after capability or
   prompt-dispatch work.
5. Wire minimal session-bound capabilities needed by the demo.
6. Wire `session_prompt` only if the demo needs follow-up turns.
7. Defer batch session creation until repeated `session_new` calls are
   insufficient.
8. Defer `session_cancel` / `session_abort` unless the demo has a direct stop
   requirement.

## Review Questions

- Which concrete child agent selectors must session creation support tonight?
- Can role/correlation stay in session metadata for the demo?
- Which session-bound capabilities are required tonight: filesystem read/write,
  terminal commands, GitHub/Linear facts, or CI status?
- Is the approval path expressible as `wait_for` over a fact source tonight, or
  do we need a dedicated `request_input` convenience tool?
- Do child agents need long-lived prompt dispatch tonight, or can session
  terminal results cover the factory loop?
