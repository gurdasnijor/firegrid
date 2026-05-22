# Runtime Design Constraints

Doc-Class: dispatchable
Status: active
Date: 2026-05-22
Owner: Firegrid Architecture

This document is the runtime architecture stop-condition for Firegrid's current
runtime-shrink work. It applies the Stream-First Agent Substrate RFC under
`docs/rfc/external/durable-stream-agent-plaform-rfc/` to the specific
RuntimeContext, channel, tool, output, and host-control surfaces currently being
changed.

The RFC is the architectural source. This document is its runtime-layer
constraint expression: it names the Firegrid bridge code that violates the RFC
today, prevents future SDDs from elaborating those bridges, and requires any
temporary exception to carry a dispatched RFC-conforming deletion path.

It is not a proposal to adopt Restate, Temporal, or any other product. External
systems are useful prior art only; Firegrid's own stream-first RFC is the
anchor.

Why this exists alongside the RFC:

- the RFC defines neutral substrate semantics;
- this document applies those semantics to concrete Firegrid runtime surfaces;
- the RFC says what the target architecture is;
- this document says when a proposed Firegrid patch is bridge debt and must
  stop.

The local evidence that forced this constraint document:

- `RuntimeContextWorkflow` already concentrates the load-bearing logic in
  reducer-shaped functions such as `transitionInputEvent` and
  `transitionOutputEvent`.
- The dense output replay problem came from forcing that reducer to scan raw
  agent output, where most rows are no-op transitions for the body.
- The input deferred mailbox and dispatcher exist to wake a long-lived body,
  not because input identity or permission/tool correlation requires them.
- The S1/write-arm investigations showed that recovering parked workflow bodies
  safely requires controller ownership, and that the generic engine cannot
  infer semantic wait kinds.
- The host-plane channel router SDD already makes channels the typed edge
  dispatch surface; protocol additions that bypass it add parallel surface.

The constraints below make the RFC discipline operational for runtime-shrink
review.

If a proposed primitive solves a problem created by violating one of these
constraints, the primitive is bridge debt. The preferred fix is to restore the
constraint, not to elaborate the bridge.

## Review Rule

Before accepting a runtime SDD, protocol addition, workflow identity, channel
route, or agent-tool surface, answer these questions:

1. What is this solving?
2. Is the problem unique to Firegrid's domain, or self-inflicted by today's
   replaying workflow body, mailbox, string channel, or edge-local protocol
   shape?
3. Does an existing primitive already own it: keyed durable state, channel
   router, typed source observation, or a durable completion/event result row?
4. Does the proposed change comply with all seven constraints below?

If the answer to 2 is "self-inflicted" or the answer to 4 is "no", stop and
rewrite the work around the constraint. Do not land another parallel protocol,
cursor, mailbox, request/claim/completion table, or operation-shaped workflow to
make the current shape cheaper.

## What The RFC Already Says

The Stream-First Agent Substrate RFC defines the architecture these constraints
apply:

- Durable ordered facts are the source of truth; everything else is a
  projection, live resource, adapter, or operator
  (`concepts/core-principle.md`).
- Durable identity is distinct from live ownership
  (`reference/identity-model.md` §9; `internals/runtime-and-operators.md`
  §12.1).
- Side-effecting work uses claimed-work operators that replay to a live
  boundary before executing (`internals/runtime-and-operators.md` §13.2).
- Durable completions / externally resolved waits are reconstructed from
  durable wait and completion records, not from in-memory waiters
  (`internals/durable-state-awaitables-approvals-timers.md` §20).
- Projection-backed waits are snapshot-first, then subscribe-after-cursor
  (`internals/projections-and-channels.md` §10.4).
- Cursors are observation coordinates, not business identifiers
  (`internals/durable-log.md` §7.1).
- The application layer is choreography-first: the model owns sequencing,
  branching, parallelism, and recovery through durable tools; a workflow
  orchestration SDK must not be the primary progress model
  (`concepts/choreography-and-combinators.md` §6.3).

The constraints below apply those RFC claims to the Firegrid runtime surfaces
being shrunk.

## Source Pages

Primary local RFC pages:

- `docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/core-principle.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/choreography-and-combinators.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/internals/durable-log.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/internals/projections-and-channels.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/internals/runtime-and-operators.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/internals/durable-state-awaitables-approvals-timers.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/reference/identity-model.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/reference/idempotency.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/operating/restart-semantics.md`

External prior art can help explain the shape, but it is not authoritative for
Firegrid. Restate's keyed services / handlers / event-processing docs are one
comparison point:

- <https://docs.restate.dev/foundations/key-concepts>
- <https://docs.restate.dev/foundations/handlers>
- <https://docs.restate.dev/use-cases/event-processing>

## Constraints

### C1. Sessions Are Keyed Durable State Containers

RFC source: `reference/identity-model.md` §9 and
`internals/runtime-and-operators.md` §12.1.

A runtime context is a durable entity keyed by identity. For RuntimeContext this
key is `contextId`. The state is durable, and all mutations for the same key are
serialized by the runtime owner. There is no higher-level object model above the
keyed durable state container.

Durable identity does not prove live ownership. A durable context/session row
means the entity exists; it does not mean the current process owns a promptable
agent connection, stdio pipe, provider handle, or running fiber. Any operation
that needs a live resource must prove or reacquire that ownership before
dispatch.

Anti-pattern: adding a per-operation workflow, dispatcher, request/claim table,
or synthetic control object to represent "what the entity is." Those are
operation wrappers. They are migration debt unless they are the actual durable
owner for a keyed resource.

### C2. Handlers Are State/Event Reducers, Not Long-Lived Bodies

RFC source: `concepts/choreography-and-combinators.md` §6.3,
`internals/runtime-and-operators.md` §13, and
`operating/restart-semantics.md` §25.

The target runtime handler is a function of:

```text
(state, event) -> (newState, actions)
```

It materializes for an event, applies the transition, emits durable actions,
and returns. There is no long-lived body that "is" the entity between events.
Between events, the entity is durable state.

In this codebase, `RuntimeContextWorkflowNative`'s event loop is a long-lived
replaying body. It exists for current engine compatibility; the structural
target moves transition logic into handler-shaped invocations on keyed
RuntimeContext state. Bridge mechanisms that elaborate the long-lived body are
forbidden unless they satisfy the bridge-exception gate below.

Anti-pattern: adding a replay cursor, replay memo table, durable deferred
mailbox, or restart sweep to make a long-lived body cheaper. Those mechanisms
may be necessary bridges while production still runs on the workflow engine,
but they are not target architecture.

### C3. Side Effects Complete By Durable Result Identity

RFC source: `internals/runtime-and-operators.md` §13.2 and
`reference/idempotency.md` §24.

A side effect is complete when its durable result row exists under its
idempotency key. If the result exists, the effect happened. If it does not
exist, retrying the handler must be safe.

At-most-once semantics come from the durable result identity, not from replay
memoization inside a workflow body.

Idempotency keys are domain identities, not stream cursors. The keyspace must
define the operation kind, logical subject, producer/client identity when
relevant, dedupe window, and payload conflict rule. Duplicate same-payload
attempts observe the existing operation or terminal result; conflicting payloads
surface a conflict instead of creating another operation.

Anti-pattern: using activity replay logs or workflow-local memo state as the
semantic authority that an external effect happened. Replay logs are an engine
implementation detail; the durable result row is the system fact.

### C4. Async Waits Are Durable Completions

RFC source: `internals/durable-state-awaitables-approvals-timers.md` §20 and
`internals/projections-and-channels.md` §10.4.

An async wait is a durable completion or externally resolved wait keyed by
stable identity:

```text
waiter session -> waiting on fact id X
producer -> resolves/rejects/cancels fact id X
substrate -> routes the arrival to the waiting session handler
```

Inputs, tool results, permission responses, child-session completions, scheduled
prompts, webhook responses, and external approvals should all fit this shape
when they suspend progress.

Completion keys are domain-specific, for example `tool:<contextId>:<toolUseId>`
or `permission:<permissionRequestId>`. Resolution follows
first-valid-terminal-wins: later identical terminals are idempotent duplicates,
later conflicting terminals are conflicts/audit facts, and invalid completions
do not resolve the wait. Reconstruction after restart reads durable wait and
completion records; it must not require an in-memory waiter to have survived.

Firegrid has adjacent vocabulary that this constraint does not adopt as the
target: `DurableDeferred` is the workflow-engine bridge primitive,
`wait_for`/channel observation is the agent-surface observation primitive, and
"awakeable" appears in some feature specs as a durable-wait synonym. The
canonical runtime term for this constraint is durable completion / externally
resolved wait.

Anti-pattern: creating a new mailbox, per-sequence deferred, polling workflow,
request/claim/completion family, or bespoke result channel for each wait kind.
Those patterns reimplement durable completions with more surface area.

### C5. The Runtime Does Not Park Entity Bodies Between Events

RFC source: `operating/restart-semantics.md` §25.2-§25.6 and
`internals/runtime-and-operators.md` §12.

The target model has no parked entity body that needs to be armed after a write.
Writing an event or resolving a durable completion is sufficient; the runtime
routes it to the keyed handler.

The current production workflow engine does park bodies, so bridge work may need
controller-owned write+arm to remain correct during migration. That bridge is
load-bearing only because of the current engine model. It must not become a
new permanent abstraction.

Anti-pattern: making the generic workflow engine infer semantic wait kinds, or
adding a blanket suspended-workflow recovery sweep. If the engine does not know
why a body is parked, only the controller that issued the command can safely
recover it. In the target model, the parked-body problem disappears.

### C6. Observations Are Typed Source, Cursor, Match

RFC source: `internals/projections-and-channels.md` §10.4 and
`internals/durable-log.md` §7.1.

Every external observation has this shape:

```text
source identity + cursor + optional match
```

The source identity is typed. The cursor belongs to the source. The match is a
projection concern. Agents and edge adapters must not guess dynamic channel
strings, and new observation use cases must not define parallel event
taxonomies when an existing channel schema already owns the event type.

Cursors are source coordinates, not business identifiers. They may be dense
integers, byte offsets, record ids, or opaque tokens depending on the source.
They prove where observation resumes; they do not identify sessions, prompts,
tool calls, permissions, or resources.

Projection-backed waits are snapshot-first: read a snapshot at a known cursor,
evaluate the predicate, then subscribe strictly after that cursor. This prevents
both missed terminal rows and stale replay. A source that cannot provide a
stable snapshot/subscription boundary is not sufficient for restart-safe waits
without an explicit equivalent proof.

For delegated child output, the existing primitive is the typed
`SessionAgentOutputChannel` routed through the channel router. A tool or MCP
adapter may wrap that route, but it must not invent a standalone
`session_read`/`ChildOutput*` protocol stack.

Anti-pattern: `wait_for({ channel: string })` as an ambient lookup, dynamically
invented channel names, per-use-case cursor schemas, duplicated event-tag
enums, or protocol additions that bypass the channel router.

### C7. State, Event, Identity, And Result Schemas Are First-Class

RFC source: `reference/record-model.md`, `internals/projections-and-channels.md`
§10.3, and `reference/idempotency.md` §24.1.

State schemas, event schemas, identity schemas, and result schemas are explicit,
versioned contracts. Replay or recovery means "read durable state and process
the next event," not "re-run a body and trust memoized side effects."

Projections are derived views, not alternate truth. A projection family must
declare source records, fold version, schema version, retention assumptions,
ordering assumptions, and snapshot cursor semantics. If retained durable facts
cannot rebuild the projection, the projection must say so; it must not silently
become the authority.

Anti-pattern: edge-local result synthesis, schema duplication across protocol
and runtime, hidden substrate fields escaping to agents, or completion semantics
that depend on route metadata when the real terminal fact belongs in durable
runtime state.

## Consequences For Current Shrink Work

### Dense Output Cursor

Bridge: the dense raw-output cursor prevents O(resumes x history) failure while
production still has a replaying body consuming raw agent output.

Gate result: `SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE` as originally written fails
the bridge-exception gate because it introduces new primitive surface
(module/schema/API) rather than only modifying existing violating code. The
live P0 hotfix path was the existing-code patch (`tf-7kq8`), and the structural
target is the sparse transition/result log (`tf-w6qj`). The SDD must be treated
as bridge reference or rewritten under `tf-c22a`; it must not ship as target
architecture.

RFC-conforming target: a sparse, workflow-owned transition/result log or event
route that invokes the handler only for state-relevant facts. The body should
not read hundreds of `TextChunk` rows to discover a small number of transition
events. This follows typed durable channel observation
(`internals/projections-and-channels.md` §10.4/§10.6) and durable completion
semantics (`internals/durable-state-awaitables-approvals-timers.md` §20).

The existing `SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE` is therefore a bridge
reference, not target architecture. Structural output work must move to the
sparse transition/result log path.

Constraint source: C2, C5, C7.

### Runtime Input Mailbox

The per-sequence `DurableDeferred` input mailbox, dispatcher, and sequence
allocator are bridge debt. Input arrival is an event or durable completion keyed
by input identity and routed to the session handler. The kernel/controller must
not allocate arrival-order sequences as durable authority.

Gate result: controller-owned write+arm can be an admissible bridge when it
modifies the existing parked-body input/output path, names the structural
deletion target, and exists only to retire the mailbox/dispatcher/replay-body
shape. `tf-5cn1` is the bridge implementation bead; `tf-vrz6` and `tf-w6qj` are
the structural deletion targets it unblocks. A write+arm design that becomes a
new permanent primitive fails C5.

RFC-conforming target: durable identity plus externally resolved completion or
event delivery keyed by domain input identity, not a sequence-scanning deferred
mailbox (`reference/identity-model.md` §9; `internals/durable-state-awaitables-approvals-timers.md`
§20).

Constraint source: C1, C2, C4.

### Controller-Owned Write+Arm

Controller-owned write+arm is a migration safety primitive for the current
parked-body engine. It is not the target abstraction. It remains necessary only
where production still needs to atomically persist a fact and wake an existing
workflow execution. Do not generalize it into a new runtime philosophy.

RFC-conforming target: no parked entity body between events. Runtime recovery
replays durable facts, reconstructs pending waits, and makes durable recovery
decisions (`operating/restart-semantics.md` §25.6).

Constraint source: C5.

### Tool Calls

Firegrid-executed tool calls and provider-executed tool calls share the same
semantic wait: the session is waiting on `toolUseId`. They differ only in who
writes the result row. The owning session handler records the wait; the result
arrival resolves it. This deletes the need for an operation-shaped
`ToolCallWorkflow`.

RFC-conforming target: tool result identity is a durable completion key with
first-valid-terminal-wins; side-effecting execution follows claimed-work
operator discipline when multiple workers can execute it
(`internals/durable-state-awaitables-approvals-timers.md` §20;
`internals/runtime-and-operators.md` §13.2).

Constraint source: C3, C4.

### Delegated Child Output

A parent observing a child session is a typed source observation:

```text
source = child session output
cursor = after output sequence
match = optional event predicate
```

The channel/router system already owns the source contract through
`SessionAgentOutputChannel`. Agent tools may project this into a request/response
adapter, but the adapter must stay thin and reuse the channel schema.

RFC-conforming target: typed source identity plus cursor plus optional match,
using snapshot-first / subscribe-after-cursor observation. Do not add parallel
event taxonomies or source-specific cursor protocols
(`internals/projections-and-channels.md` §10.4; `internals/durable-log.md`
§7.1).

Constraint source: C6.

### Route Completion

Immediate append/call receipts are router metadata. Terminal prompt completion
is durable runtime result state. Do not synthesize terminal `Done` at the ACP
edge over raw `TurnComplete` observation. Bind terminal completion to the
state/result fact that the keyed handler owns.

RFC-conforming target: terminal facts are durable records/projection state with
first-valid-terminal-wins, not edge-local synthesis
(`internals/durable-state-awaitables-approvals-timers.md` §20.2;
`internals/projections-and-channels.md` §10.3).

Constraint source: C7.

## SDD Gate

Every new runtime SDD must include a short "Constraint Check" section:

```text
C1 keyed durable state:
C2 handler, not long-lived body:
C3 durable result identity:
C4 durable completion / externally resolved wait:
C5 no parked entity body:
C6 typed source observation:
C7 first-class schemas:
```

Each line must say either "complies", "not applicable", or "bridge exception".
A bridge exception is admissible only if all three are true:

1. The change modifies existing code that already violates the constraint,
   rather than introducing a new primitive, schema, module, operation, or
   workflow identity.
2. The RFC-conforming target is dispatched as a bead, not merely referenced.
3. The bridge code carries a sunset commitment naming the wave, date, or
   dependent bead by which it is deleted.

A bridge exception that fails any of these is not dispatchable. Rewrite the SDD
to comply with the constraint directly, or open a separate SDD for the
RFC-conforming target and gate the bridge work on it.

## Priority Over The Workflow-Engine-Era Cannon

Pre-shrink cannon described the workflow engine, deferred input mailbox, and
engine-level restart recovery as the runtime substrate. Those descriptions are
historical and remain useful for understanding bridge code, but they are not
target architecture. The Stream-First Agent Substrate RFC and this constraint
document define the target. Where they conflict with older cannon, the RFC and
this document have priority.

Until they satisfy C2 and C5, the following are bridge machinery, not target:

- the `@effect/workflow` engine as the RuntimeContext progress model;
- per-sequence `DurableDeferred` input mailboxes;
- the `RuntimeInputIntentDispatcher` and any equivalent dispatcher fork;
- generic suspended-workflow recovery sweeps at the engine layer;
- `Workflow.make` identities that represent an operation, request, claim, wait,
  or one-shot tool call rather than a keyed durable resource.

New work in any of these surfaces requires either RFC-conforming replacement or
a bridge exception meeting the gate above.

## Executable Contract Follow-Ups

C2, C4, C6, and C7 are now test-enforced (`tf-zchu`) by Semgrep rules in
`.semgrep.yml`, gated in CI through `scripts/semgrep-check-baseline.mjs`
(`pnpm run lint:semgrep`) with rule-unit coverage in `semgrep-tests/`
(`pnpm run lint:semgrep:test`). `semgrep-error-baseline.json` is the admissible
bridge-exception ledger: an existing in-scope finding may be baselined with a
justification note; any new finding fails CI. The remaining constraints (C1, C3,
C5) stay review-enforced.

- C2 guard — `firegrid-no-unclassified-workflow-make`: fails CI on every new
  production `Workflow.make` definition. This is strictly stronger than C2's
  "operation-shaped long-lived loops or park on multiple semantic wait kinds"
  sub-case, since a new context-lifetime loop or cross-event parked body cannot
  appear without a new `Workflow.make`. Existing owner workflows are baselined.
- C4 guard — `firegrid-c4-no-new-durable-deferred-runtime-wait`: fails CI on new
  `DurableDeferred` use under the RuntimeContext input/tool/permission/
  child-session surfaces (`workflow-engine/workflows`, `agent-event-pipeline`,
  `control-plane`, `channels`). The existing per-sequence input mailbox
  (`runtime-context.ts`) is baselined as the `tf-5cn1` bridge with deletion
  targets `tf-vrz6`/`tf-w6qj`; a new use needs an admissible bridge exception per
  the SDD Gate. The engine clock `DurableDeferred` in
  `workflow-engine/internal` is intentionally out of scope (engine primitive,
  not a RuntimeContext wait kind).
- C6 guard — `firegrid-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools`:
  fails CI on new agent-tool protocol schemas (`packages/protocol/src/agent-tools`)
  that add `cursor:`/`eventTag:` taxonomies or a `session_read`/`ChildOutput*`
  stack instead of reusing the router-backed `SessionAgentOutputChannel` schema.
- C7 guard — `firegrid-c7-no-edge-local-terminal-synthesis`: fails CI on
  edge-local construction of a terminal `{ _tag: "Done" }` in the transport edge
  (`packages/host-sdk/src/host/*edge*.ts`) where the terminal fact is not backed
  by durable runtime state. Observing a `TurnComplete` output is compliant;
  synthesizing the terminal completion locally is not.

First live-bridge application bead: `tf-c22a`. It applies this gate to existing
bridge SDDs and PRs, including `SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE`,
`tf-1ymw`, and `tf-r6br`.
