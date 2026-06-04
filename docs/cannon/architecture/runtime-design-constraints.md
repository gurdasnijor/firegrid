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

The canonical runtime shape is:

```text
events -> DurableTable(events) -> transforms(rows) -> keyed subscribers(rows)
```

Every runtime component must be one of these roles:

- an **event producer** that writes durable event/fact rows;
- a **transform** that is a pure function over rows or row streams;
- a **keyed subscriber** that owns durable state for one entity key, reads rows
  for that key, optionally writes more rows, and returns.

Workflows are a kind of keyed subscriber. A workflow-shaped subscriber uses
`@effect/workflow` execution machinery when it earns its keep: activity
memoization, durable timers, cross-execution handoff, or restart-safe live
side effects. That does not make workflow a fourth architectural role.

The constraints below are corollaries of this shape. If a proposed component is
none of these roles, it is the wrong primitive. If a proposed primitive solves a
problem created by violating one of these constraints, the primitive is bridge
debt. The preferred fix is to restore the shape, not to elaborate the bridge.

`DurableTable` is the substrate of record for this model. "Reducer" or
"handler" means transition-function-shaped business logic over durable rows; it
does not name a new runtime framework.

The companion document
`docs/cannon/architecture/runtime-pipeline-type-boundaries.md` maps this shape
to concrete Firegrid Effect service boundaries and shows where workflow
machinery is, and is not, justified.

## What This Shape Does Not Include

- **No long-lived parked bodies.** A keyed subscriber is invoked for events for
  its key, runs to completion, and returns. It does not park on a deferred, keep
  a fiber alive across events, or rely on locals that persist between
  invocations. State persists in `DurableTable`, not in fiber state.
- **No replay-based execution.** Subscribers do not reconstruct progress by
  re-walking history. They read durable state, read the relevant event/fact, run
  the transition, and write durable state/actions. Restart means read persisted
  state and continue from durable facts, not replay every event since creation.
- **No workflow-engine ban.** `@effect/workflow` is valid execution machinery
  for subscribers that need restart-safe live execution. The banned shape is a
  workflow body that represents the lifetime of an entity, parks across many
  events, stores cross-event state in locals, or scans durable history as its
  progress model.
- **No bridge-by-default in a greenfield codebase.** Firegrid currently has no
  production users or user state to migrate. A "bridge from X to subscribers" or
  "cutover layer" is overhead unless it proves a sequencing dependency that
  cannot be removed by deleting X and building the compliant shape directly.

## Greenfield Operating Mode

Firegrid is currently a greenfield runtime: there are no production users or
durable user contexts that require a compatibility bridge. That changes the
default answer for every runtime-shrink decision.

The default path is:

```text
prove the target in packages/firelab
  -> build the compliant production shape
  -> delete the wrong shape
```

The non-default path is:

```text
make the wrong shape safer
  -> bridge it
  -> later migrate off it
```

The non-default path is admissible only when deleting the wrong shape directly
would block a dispatched target-shape bead. "Preserve existing production
behavior" is not a sufficient argument while the product has no production user
state to preserve.

`packages/firelab` exists to make large architectural bets cheap. Any
runtime SDD whose uncertainty is architectural rather than mechanical should
first be expressed as a firelab simulation. The simulation must answer a
specific topology question, not produce another research brief. Its result is
one of:

- **GREEN:** the target edge works; dispatch production replacement.
- **YELLOW:** the target edge works only with a named substrate/helper layer;
  dispatch that layer and keep it within the target shape.
- **RED:** the target edge fails; stop and revise the architecture before
  touching production code.

Do not spend production effort improving a known-wrong edge when a firelab
simulation can validate the shorter target edge faster. Bridge work is debt; in
greenfield mode, debt is admitted only when it accelerates deletion.

`packages/firelab/` is the workbench. Production runtime code under
`packages/runtime/`, `packages/host-sdk/`, and `packages/protocol/` is where
validated shapes get *built*. The two roles do not blur, and validated
firelab modules do not graduate into production by copy/move:
production code is written fresh against the simulation's answered
contract, using production substrate, types, and Layer graph.

Operational consequences for lane dispatch — when a production lane may be
dispatched, when an unsettled upstream wave forbids it, and what happens to
speculative production artifacts produced before the upstream wave exits —
live in the dispatch docs, not this constraint doc:

- [`docs/architecture/2026-05-22-shape-c-cutover-roadmap.md`](../../architecture/2026-05-22-shape-c-cutover-roadmap.md)
  §"Tiny-Firegrid-First Dispatch Gate" — the per-wave precondition and the
  dispatch decision form.
- [`docs/architecture/2026-05-22-shape-c-cutover-operating-plan.md`](../../architecture/2026-05-22-shape-c-cutover-operating-plan.md)
  §"Operating Rules For Lanes" — the lane-level rule and the
  speculative-artifact deletion rule.

## Review Rule

Before accepting a runtime SDD, protocol addition, workflow identity, channel
route, or agent-tool surface, answer these questions:

1. What is this solving?
2. Is the problem unique to Firegrid's domain, or self-inflicted by today's
   replaying workflow body, mailbox, string channel, or edge-local protocol
   shape?
3. Which canonical role is it: event producer, transform, or keyed subscriber?
4. Does an existing primitive already own it: `DurableTable`, channel router,
   typed source observation, or a durable completion/event result row?
5. Can the target edge be validated first in `packages/firelab`?
6. Does the proposed change comply with all seven constraints below?

If the answer to 2 is "self-inflicted" or the answer to 6 is "no", stop and
rewrite the work around the constraint. If the answer to 5 is "yes", prove the
target edge in firelab before touching production runtime code. Do not
land another parallel protocol,
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

Pipeline corollary: keyed subscribers own durable state per entity key through
`DurableTable` rows.

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

### C2. Subscribers Are Per-Event Handlers, Not Long-Lived Bodies

RFC source: `concepts/choreography-and-combinators.md` §6.3,
`internals/runtime-and-operators.md` §13, and
`operating/restart-semantics.md` §25.

Pipeline corollary: the runtime transition is a keyed subscriber over durable
event/fact rows. A workflow-shaped subscriber is still a subscriber; it handles
one event for its key and completes.

The target runtime handler materializes for one event, advances durable state,
dispatches any required side effects through durable result identity, and
returns. A common shape factors this as a pure transition:

```text
(state, event) -> (newState, actions)
```

A workflow-shaped handler may also inline side-effecting work using
`Activity`, `DurableDeferred`, or `DurableClock` when restart-safe live
execution is required. The constraint is about body lifetime, not handler
purity: the forbidden shape is a body whose lifetime spans many events for one
entity. Between events, the entity is durable state.

In this codebase, `RuntimeContextWorkflowNative`'s event loop is a long-lived
replaying body. It exists for current engine compatibility; the structural
target moves transition logic into per-event workflow/keyed-subscriber
invocations on keyed RuntimeContext state. `@effect/workflow` may still execute
those invocations when restart-safe live execution is needed. Bridge mechanisms
that elaborate the long-lived body are forbidden unless they satisfy the
bridge-exception gate below.

Anti-pattern: adding a replay cursor, replay memo table, durable deferred
mailbox, or restart sweep to make a long-lived body cheaper. Those mechanisms
are admissible only when they satisfy the bridge-exception gate below. They are
not target architecture.

### C3. Side Effects Complete By Durable Result Identity

RFC source: `internals/runtime-and-operators.md` §13.2 and
`reference/idempotency.md` §24.

Pipeline corollary: a side-effecting subscriber writes or observes a durable
result row keyed by the operation identity.

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

Pipeline corollary: an async wait is a durable event/result row that a keyed
subscriber observes, not a mailbox or parked deferred slot.

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
target. `DurableDeferred` is workflow-engine execution machinery: valid within
one per-event subscriber's handling of one event for bounded handoff, but
forbidden as the cross-event mailbox that lets a long-lived body wait for the
next event for an entity. `wait_for`/channel observation is the agent-surface
observation primitive. "Awakeable" appears in some feature specs as a
durable-wait synonym. The canonical runtime term for this constraint is durable
completion / externally resolved wait.

Anti-pattern: creating a new mailbox, per-sequence deferred, polling workflow,
request/claim/completion family, or bespoke result channel for each wait kind.
Those patterns reimplement durable completions with more surface area.

### C5. The Runtime Does Not Park Entity Bodies Between Events

RFC source: `operating/restart-semantics.md` §25.2-§25.6 and
`internals/runtime-and-operators.md` §12.

Pipeline corollary: a subscriber exists only while processing rows; between
events, the entity exists as durable table state.

The target model has no parked entity body that spans the entity's event
stream and needs to be armed after a write. Writing an event or resolving a
durable completion is sufficient; the substrate routes it to the keyed
subscriber. A workflow-shaped subscriber may park internally while handling one
event when `DurableDeferred`, `DurableClock`, or activity machinery earns its
keep, but the parked execution is scoped to that event handling, not to the
entity lifetime across unrelated events.

The current `RuntimeContextWorkflowNative` parks a context-lifetime body.
Controller-owned write+arm is load-bearing only if a dispatched sequencing
dependency proves that body must be preserved temporarily. It must not become a
new permanent abstraction.

Anti-pattern: making the generic workflow engine infer semantic wait kinds, or
adding a blanket suspended-workflow recovery sweep. If the engine does not know
why a body is parked, only the controller that issued the command can safely
recover it. In the target model, the parked-body problem disappears.

### C6. Observations Are Typed Source, Cursor, Match

RFC source: `internals/projections-and-channels.md` §10.4 and
`internals/durable-log.md` §7.1.

Pipeline corollary: observation is a typed read/subscription over durable source
rows, not a source-specific protocol family.

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

Pipeline corollary: event rows, state rows, transform outputs, subscriber
inputs, and result rows are all explicit schema contracts.

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

The dense raw-output scan is a symptom of the parked-body shape in
`RuntimeContextWorkflowNative`: a long-lived body reads dense agent output to
discover sparse state-relevant facts. The originally proposed
`SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE` makes that scan cheaper, but preserves the
shape that produces it.

Under the greenfield frame, the live-P0 framing in that SDD does not apply:
there are no users hitting this scan. The structural fix is to make
RuntimeContext handling per-event (`tf-tvg1`) so the dense scan never happens,
not to introduce a new cursor primitive. The cursor SDD must be retired or
rewritten as bridge-only reference under `tf-c22a`.

Constraint source: C2, C5, C7.

### Runtime Input Mailbox

The per-sequence `DurableDeferred` input mailbox, dispatcher, and sequence
allocator are bridge debt. Input arrival is an event or durable completion keyed
by input identity and routed to the session handler. The kernel/controller must
not allocate arrival-order sequences as durable authority.

Gate result: in a greenfield codebase, production controller-owned write+arm is
not the expected next step. It evolves the known-wrong parked-body edge. The
active validation path is `tf-tvg1`: prove the shorter per-event
workflow/keyed-subscriber RuntimeContext shape in firelab, then rewrite
the production RuntimeContext surface against that target. The former production
write+arm bridge bead `tf-5cn1` is superseded by `tf-tvg1`.

RFC-conforming target: durable identity plus externally resolved completion or
event delivery keyed by domain input identity, not a sequence-scanning deferred
mailbox (`reference/identity-model.md` §9; `internals/durable-state-awaitables-approvals-timers.md`
§20).

Constraint source: C1, C2, C4.

### Controller-Owned Write+Arm

Controller-owned write+arm is a migration safety primitive for a parked-body
engine. It is not the target abstraction. Because Firegrid has no production
users or user state to preserve, do not build production write+arm merely to
make the current parked-body edge safer. Prefer deleting the edge by validating
and implementing per-event workflow/keyed subscribers.

Write+arm remains valid as negative evidence and as a reference for why generic
engine sweeps are unsafe. It is not a license to introduce a permanent
controller layer around `@effect/workflow`.

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
Canonical role (producer / transform / keyed subscriber):
C1 keyed durable state:
C2 handler, not long-lived body:
C3 durable result identity:
C4 durable completion / externally resolved wait:
C5 no parked entity body:
C6 typed source observation:
C7 first-class schemas:
```

If the subscriber is workflow-shaped, the SDD must name which workflow
capability is load-bearing and why a plain handler over `DurableTable` rows is
insufficient. "Restart safety" alone is insufficient; `DurableTable` already
provides restart-safe state. Workflow machinery is justified when the handler
does external side effects requiring at-most-once memoization, blocks on
cross-execution handoff longer than one event, or needs durable wall-clock
timers.

Each line must say either "complies", "not applicable", or "bridge exception".
A bridge exception is admissible only if all four are true:

1. The change modifies existing code that already violates the constraint,
   rather than introducing a new primitive, schema, module, operation, or
   workflow identity.
2. The RFC-conforming target is dispatched as a bead, not merely referenced.
3. The bridge code carries a sunset commitment naming the wave, date, or
   dependent bead by which it is deleted.
4. Deleting the violating code directly would block a dispatched bead that has a
   real sequencing dependency on the bridge. Bridges to preserve
   currently-running behavior do not qualify in the greenfield codebase.

A bridge exception that fails any of these is not dispatchable. Rewrite the SDD
to comply with the constraint directly, or open a separate SDD for the
RFC-conforming target and gate the bridge work on it.

## Runtime Shrink Falsification Test

The re-architecture is succeeding only if the graph and code surface shrink as
the target shape lands. For each RuntimeContext rewrite PR after `tf-tvg1`,
report the before/after line and module count for the touched runtime surface:

- RuntimeContext state/input/output handling;
- tool dispatch and tool result handling;
- output observation and transition handling;
- wait routing / observation matching.

Establish the baseline before `tf-tvg1`'s production rewrite begins: total line
count and module count for the four surfaces above, as of `main` at `tf-tvg1`
dispatch. Record that baseline in the bead. Each subsequent rewrite PR reports
delta against the baseline. The re-architecture is succeeding if the cumulative
delta is negative and decreasing across the wave. If a single PR adds net lines,
it must explicitly justify which constraint capability was added that was not
present before.

If subscriber implementations consistently make those surfaces larger than the
workflow bodies, mailboxes, cursors, and operation wrappers they replace, the
new shape is hiding complexity rather than removing it. That is a falsifying
signal for the current re-architecture direction and should stop the wave for
architecture review.

## Priority Over The Workflow-Engine-Era Canon

Pre-shrink canon described the context-lifetime workflow body, deferred input
mailbox, and engine-level restart recovery as the RuntimeContext substrate.
Those descriptions are historical and remain useful for understanding bridge
code, but they are not target architecture. The Stream-First Agent Substrate RFC
and this constraint document define the target. Where they conflict with older
canon, the RFC and this document have priority.

Until they satisfy C2 and C5, the following are bridge machinery, not target:

- `RuntimeContextWorkflowNative` as one long-lived parked body that owns the
  context event loop;
- per-sequence `DurableDeferred` input mailboxes;
- the `RuntimeInputIntentDispatcher` and any equivalent dispatcher fork;
- generic suspended-workflow recovery sweeps at the engine layer;
- workflow bodies that use replay/scans/locals as the cross-event RuntimeContext
  state model.

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
- Shape-aware C2 guard (`tf-1r0o`) —
  `firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber`: fails CI
  on `Activity.make`, `Workflow.suspend`, `Workflow.execute`,
  `WorkflowEngine.WorkflowEngine`, or `WorkflowEngine.WorkflowInstance` inside
  `packages/runtime/src/agent-event-pipeline/subscribers/runtime-context/**`.
  That directory is the Shape C cutover landing zone defined by
  [`runtime-pipeline-type-boundaries.md`](./runtime-pipeline-type-boundaries.md)
  and [`packages/runtime/src/agent-event-pipeline/TOPOLOGY.md`](../../../packages/runtime/src/agent-event-pipeline/TOPOLOGY.md);
  a violation either turns the subscriber into a (parked, replaying) Shape D
  body or assumes a workflow runtime the host composition is not obligated to
  provide. Shape D workflows live in `tool-execution/` or under a justified
  `workflow-engine/workflows/` landing.
- Transforms purity guard — **follow-up**, NOT YET LANDED. The intended rule
  (`firegrid-transforms-no-effect-shaped-exports`) would fail CI on
  `Effect.gen`, `Effect.{succeed,fail,sync,tryPromise,promise,async}`,
  `Layer.*`, `Workflow.make`, `Activity.make`, `DurableDeferred.*`, or
  `Context.{Tag,GenericTag}` inside
  `packages/runtime/src/agent-event-pipeline/transforms/**`. The shape rule
  is documented in
  [`packages/runtime/src/agent-event-pipeline/transforms/README.md`](../../../packages/runtime/src/agent-event-pipeline/transforms/README.md)
  and [`TOPOLOGY.md`](../../../packages/runtime/src/agent-event-pipeline/TOPOLOGY.md);
  review-enforced today. The CI rule was deferred because `semgrep --test`
  mode (the existing tf-zchu unit-test harness) reports a phantom rule-id
  mismatch on `dup-detection.ts` whenever this rule is in `.semgrep.yml`,
  regardless of `paths.include` configuration — needs deeper investigation or
  a rule-split / second-target test invocation. Until landed, transforms
  purity is review-enforced; the reviewer test is "callable in a unit test
  with no Effect environment."

First live-bridge application bead: `tf-c22a`. It applies this gate to existing
bridge SDDs and PRs, including `SDD_DURABLE_OUTPUT_CURSOR_PRIMITIVE`,
`tf-1ymw`, and `tf-r6br`.
