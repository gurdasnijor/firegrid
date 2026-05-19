# SDD: Durable Agent-Driven Choreography Surface

Status: framing draft -- architect-gated. Gurdas decides §0. This is an
SDD-only PR; no implementation code, no bead claim, and no merge without
coordinator signoff.

Related:

- `docs/sdds/SDD_FIREGRID_FACTORY_RUN_PROCESS.md`
- `docs/sdds/SDD_FIREGRID_FACTORY_ALIGNED_AGENT_TOOL_WORKSTREAM.md`
- `docs/sdds/SDD_CHOREOGRAPHY_FACADE.md`
- `docs/sdds/SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md`
- `docs/rfc/firegrid-client-runtime-input-intents.md`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/**`
- ACP Session Setup: <https://agentclientprotocol.com/protocol/session-setup>
- cca2 / PR #365 dark-factory smoke, TFIND-055 classification: (b) narrow
  public surface-exposure gap

## §0 -- The load-bearing question, read this first

**How should Firegrid expose the durable agent-driven choreography surface so a
real tool-use agent can choreograph the factory loop entirely through the public
surface?**

Coordinator recommendation: expose one public, durable choreography seam over
three coupled gaps:

1. **Adapter session recovery seam:** Firegrid must persist enough adapter
   session identity and reattach profile to recover an ACP-backed session via
   protocol `session/load` or `session/resume`, while exposing only Firegrid
   session identity, live-promptability, and typed not-live/recovered states to
   apps and agents. Do not expose raw ACP wire session ids as the public control
   contract.
2. **Caller-owned fact wait seam:** `wait_for` must be able to target
   declared caller-owned durable facts/projections, not only built-in
   `RuntimeRun` and `AgentOutput` streams. The Firegrid shape should be typed
   EventPlane/DurableTable projection waits, not Fireline's generic channel
   registry copied wholesale.
3. **Durable execute seam:** the advertised `execute` tool must lower through
   a host-owned durable execution target registry with claim/terminal records,
   or be removed from the public tool catalog until it is real. For dark
   factory readiness, the recommendation is to implement the seam, because the
   planner needs a public way to invoke named execution targets without
   reaching past the facade.

Delegation is **not** one of the three blocking gaps. The factory planner can
delegate with `session_new` plus `session_prompt`; `spawn`/`spawn_all` may be
future convenience wrappers, but the dark-factory public-surface gap should not
be broadened to "missing delegation."

The core decision is not whether Firegrid has durable workflows internally. It
does. The gap is that the public agent-facing surface does not yet expose the
durable suspend/recover/resume seam a real tool-use agent needs when it is the
one sequencing the factory loop.

## §1 -- Bottom-Up Evidence From cca2 / PR #365 Smoke

cca2's dark-factory smoke classified the current state as a narrow
surface-exposure gap rather than a substrate rewrite. The critical failure mode
is:

```txt
ephemeral ACP agent process
  -> synchronous runtime-context MCP tool call
  -> Firegrid workflow can durably wait
  -> agent process/client call cannot be durably suspended, re-spawned,
     reattached, and resumed with the resolved wait result through the current
     public protocol surface
```

### 1. ACP has session load/resume; Firegrid ACP facade creates only new sessions

ACP's public session setup spec says agents with `loadSession: true` support
`session/load`, and the agent must replay the entire conversation as
`session/update` notifications before the load response completes. The same
page defines `session/resume` for agents advertising
`sessionCapabilities.resume`, where the client reconnects without replaying
history and continues once ready.

Firegrid's ACP codec currently initializes and calls `connection.newSession`
only (`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:323` and
`:329`). It stores the returned ACP session id in a local closure
(`:339`) and uses it for prompts (`:346-350`), but the `AgentSession` public
service metadata contains only `{ kind, capabilities }`
(`packages/runtime/src/agent-event-pipeline/codecs/contract.ts:34-40`).
There is no public/runtime facade for `load_session`, `resume_session`,
adapter reattach profile, promptability classification, or typed not-live
state.

The ACP codec test fixture advertises `loadSession: false`
(`packages/runtime/test/codecs/acp/index.test.ts:39-45`) and the coverage
asserts `newSession` lowering with MCP server declarations
(`packages/runtime/test/codecs/acp/index.test.ts:332-385`). That is valid
coverage for current launch behavior; it does not prove restart/reload
semantics.

### 2. `wait_for` cannot wait on caller-owned durable facts

The public agent-tool schema intentionally narrowed `RuntimeWaitSource` to the
first supported set: `AgentOutput` and `RuntimeRun` only
(`packages/protocol/src/agent-tools/schema.ts:92-108`). The lowering rejects
invalid predicates and then calls `WaitFor.match` with that built-in source
(`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:174-255`).

That is the right typed direction from
`SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md`, but it is insufficient for the
factory loop. The planner needs to wait on app-owned facts such as "Linear
plan approval resolved", "provider callback received", or "factory run phase
terminalized". Those are not necessarily `AgentOutput` rows and should not be
smuggled into agent output just to make `wait_for` see them.

This also explains why TFIND-053 was retracted: the missing thing is not a
separate agent read API. The intended action surface is public `sessions.*`
plus the runtime-context MCP toolset. The actual gap is that this toolset does
not yet expose caller-owned durable fact waits.

### 3. `execute` is exposed but not live-host implemented

`execute` appears in the protocol operation catalog
(`packages/protocol/src/agent-tools/schema.ts:638-650`) and the tool dispatcher
accepts `"execute"` (`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:632-635`).

The live runtime host returns unsupported for both sandbox and session-capability
execute paths (`packages/host-sdk/src/host/agent-tool-host-live.ts:128-131`).
That makes `execute` a public affordance without a production-backed durable
side-effect path. For factory readiness, this is a surface-exposure gap, not a
reason to reframe delegation: `session_new` and `session_prompt` are the
delegation tools that matter for the factory loop, while `execute` is the
named execution target seam.

## §2 -- Top-Down RFC Guarantee Shortfalls

The external RFCs define the guarantee frame. They are not Firegrid-specific
implementation specs, but they make the missing public seam visible.

### Restart and live ownership

The RFC restart contract says durable logs, projections, claims, waits, and
completions survive restart, while open protocol sessions, stdio child
processes, in-memory promises, fibers, and provider handles do not survive
unless explicitly reattached
(`docs/rfc/external/durable-stream-agent-plaform-rfc/operating/restart-semantics.md:5-28`).
After restart, live sessions must be reattached/loaded if supported, otherwise
classified not-live or reprovisioned, and prompt dispatch must block until the
session is promptable (`:53-63`). Pending suspensions require a durable
terminal or recovered record, selected by the adapter's declared reattach
profile (`:64-91`).

Firegrid has durable workflow waits, durable runtime input intents, and
per-context output observation, but the agent-facing public surface does not
yet expose a recovered/terminalized suspension contract for the agent process
itself. With `persistent:false` local ACP processes, a live MCP request is not
durable merely because the workflow waiting underneath is durable.

### Session model and promptability

The RFC session model allows adapters to map lifecycle to ACP `session/new`,
`session/load`, or `session/resume`
(`docs/rfc/external/durable-stream-agent-plaform-rfc/internals/session-prompt-adapters.md:1-22`).
It requires a distinction between durable logical session and live promptable
resource (`:23-47`), requires every adapter to declare a reattach profile
(`:50-65`), and sketches `load_session` plus `owns_promptable` semantics
(`:67-80`). It also says prompt dispatch for existing session ids must be
blocked until restart classification is promptable, and stale sessions must
return typed not-live rather than accepting prompt work (`:81-94`).

Firegrid's client/host split already correctly routes client prompts through
durable runtime input intents, but it does not yet have the corresponding ACP
session load/recovery surface. `client.sessions.attach(...)` or a stored
Firegrid context id should not be confused with recovered live ownership of
the ACP adapter session.

### Durable waits, approvals, and caller-owned facts

The RFC says durable coordination should be expressible as state operations
plus projection waits where possible, e.g. `state.insert(...)` followed by
`wait_for(state.changes(query).onInsert)`
(`docs/rfc/external/durable-stream-agent-plaform-rfc/internals/durable-state-awaitables-approvals-timers.md:19-30`).
Durable promises are wait records plus completion keys plus completion records,
and must not depend solely on in-memory futures (`:38-55`). Human approvals
are durable waits, where the UI observes projections and appends decisions
(`:106-125`), and the waiting operation resumes by durable state observation
rather than private callback (`:226-245`).

Firegrid satisfies part of this for runtime-owned events, but not for
caller-owned factory facts through the public `wait_for` tool. The planner
cannot express "wait until this app-owned approval/projection row appears" as
a first-class public durable wait today.

### Choreography-first application layer

The RFC's choreography layer says the model owns ordering, branching,
parallelism, and recovery at runtime, while durability comes from tools such
as `sleep`, `wait_for`, `spawn`, `spawn_all`, `schedule_me`, and `execute`
(`docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/choreography-and-combinators.md:17-34`).
Each primitive must append durable trace/session records before suspension,
fanout, or external work, and must be observable by humans and agents through
stream-derived observation.

Firegrid currently exposes much of the tool vocabulary, but the durable
agent-driven seam is incomplete across the three gaps above. The public
surface lets host code choreograph; it does not yet let a real tool-use agent
choreograph the whole factory loop without relying on live-process continuity
or app/private reach-pasts.

## §3 -- Firegrid-Specific Alignment Needed In The RFC Frame

The RFCs are useful as guarantees, but the SDD follow-up should align them to
Firegrid's chosen substrate vocabulary before implementation:

1. **Delegation vocabulary:** the RFC names `spawn` / `spawn_all`; Firegrid's
   factory path can use `session_new` / `session_prompt`. Treat delegation as
   satisfied for this SDD unless a later product requirement needs batch
   fanout ergonomics.
2. **State wait vocabulary:** the RFC's `state.changes(query)` should map to
   declared Firegrid EventPlane/DurableTable projections. Do not copy
   Fireline's broad stringly channel registry into Firegrid's public protocol.
3. **Session recovery vocabulary:** ACP now distinguishes `loadSession` for
   `session/load` and `sessionCapabilities.resume` for `session/resume`.
   Firegrid should store adapter capabilities and profile decisions, while
   public clients/agents use Firegrid session identity and promptability state.
4. **Execute vocabulary:** the RFC's `execute(sandbox, input)` must become a
   Firegrid host-policy target. The public target name must resolve through a
   declared capability or sandbox registry with durable claim/terminal records,
   not an arbitrary process escape hatch.
5. **Trace vocabulary:** Firegrid may use existing runtime output, durable
   wait, and session projection rows rather than introducing a separate
   Fireline-style `agent.suspended` row name, but the observable lifecycle must
   still be public and replayable.

## §4 -- Prior Art From Fireline

Fireline is abandoned prior art, not a model to copy. The useful ideas are the
seams, not the exact Rust APIs or naming.

### Durable suspension envelope

Fireline's choreography tools append an `AgentSuspended` record and return a
`SuspensionSentinel` from the tool call path
(`/Users/gnijor/gurdasnijor/fireline/crates/fireline-channels/src/choreography/mod.rs:294-313`
and `:571-606`). The durable operation can be `WaitFor`, `Call`, `Schedule`,
`Spawn`, or `SpawnAll`
(`/Users/gnijor/gurdasnijor/fireline/crates/fireline-channels/src/choreography/types.rs:621-649`),
and the corresponding `AgentSuspended` / `AgentResumed` shapes key recovery by
`session_id` and `awakeable_id` (`:651-720`).

`SuspensionCoordinator` is then a durable subscriber. It matches
`agent_suspended`, executes the operation through channel drivers or child
session management, and marks completion by scanning for an `agent_resumed`
with the same `awakeableId`
(`/Users/gnijor/gurdasnijor/fireline/crates/fireline-channels/src/choreography/coordinator.rs:44-104`
and `:106-144`).

Firegrid should borrow the durable-envelope idea: an agent tool invocation
that may outlive the live process needs a public durable suspension record and
a public terminal/recovered observation. Firegrid should not copy the exact
`awakeable` vocabulary unless it survives the Firegrid naming pass.

### Session load from durable stream

Fireline's `testy_load` is a focused local ACP prior. It advertises
`loadSession: true` and implements `session/load`
(`/Users/gnijor/gurdasnijor/fireline/src/bin/testy_load.rs:1-15` and
`:161-209`). When the agent has lost in-memory session knowledge, it can
rebuild from durable stream history (`:60-82`) and replay session updates
before acknowledging load.

Fireline's session proxy also records whether the initialized agent supports
load and does not mark the proxy prompt-ready until it owns a live ACP session
(`/Users/gnijor/gurdasnijor/fireline/crates/fireline-runtime/src/launch/session_proxy.rs:65-69`
and `:250-275`).

Firegrid should borrow the pattern of "load is a runtime-owned reattach
operation that proves live promptability." It should not make the raw ACP wire
session id an app/client field that user code must manage.

### Channel registry

Fireline's `ChannelRegistry::standard` registers time, state changes, state
control, session, webhook, Telegram, and event drivers
(`/Users/gnijor/gurdasnijor/fireline/crates/fireline-channels/src/choreography/registry.rs:69-103`).
That shows why the factory loop wants a generic-looking wait language, but it
also shows what Firegrid should avoid: a public string channel registry can
become a second coordination vocabulary beside typed Firegrid projections.

Firegrid should keep the idea of pluggable target families, but expose them as
typed declared sources: built-in runtime streams plus caller-owned EventPlane
or DurableTable projection descriptors.

## §5 -- Options And Recommendations

### Gap A: ACP session load/resume and durable agent suspension

**A1. Expose raw ACP session id in `AgentSession.meta` and let callers manage
load.** Rejected. This leaks adapter wire identity into the public Firegrid
contract, still does not classify live promptability, and makes clients
responsible for a restart decision the RFC assigns to the runtime.

**A2. Keep blocking MCP tool calls only, and require persistent agents for
long waits.** Rejected for dark factory. It would make the factory work only
when a live process survives the wait, contradicting the restart contract and
the observed `persistent:false` ACP local process shape.

**A3. Runtime-owned adapter reattach profile plus public durable suspension
lifecycle.** Recommended. Firegrid should persist the adapter session identity
and negotiated recovery capability internally, classify sessions as
`reattached_promptable`, `not_live`, `recovered`, `terminal`, etc., and expose
only Firegrid session identity plus those states. ACP-backed agents should use
`session/load` when `loadSession` is true, `session/resume` when the negotiated
ACP capability permits it, and typed not-live/terminal rows otherwise.

This is necessary but not sufficient by itself: ACP can reload a conversation,
but it does not magically preserve a dead synchronous MCP request. Therefore
the public choreography tools must also record a durable suspension lifecycle
that can be resumed or terminalized after restart. The agent-visible tool
contract should make long waits explicit: either return an immediate durable
suspension sentinel and later re-enter the session with the result, or block
only under an adapter profile that Firegrid can actually reattach and prove.
Silent live-process dependence is not an acceptable contract.

### Gap B: caller-owned DurableTable/EventPlane waits

**B1. Add arbitrary source strings to `wait_for`.** Rejected. This recreates
the registry shape that `SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md` rejected.

**B2. Force factory facts into `AgentOutput`.** Rejected. It would make agent
output a dumping ground for app-owned provider facts and blur ownership.

**B3. Extend `RuntimeWaitSource` with declared caller-owned projection
sources.** Recommended. The app/host should declare public waitable sources
for its EventPlane or DurableTable projections. Agent-facing `wait_for` should
continue using schema-backed discriminated variants, with field predicates
restricted to declared scalar/indexed fields and snapshot-first wait semantics.

The design should preserve the current good part of `wait_for`: typed source
variants and invalid-input rejection. It should widen the source family, not
fall back to open-ended channel names.

### Gap C: `execute`

**C1. Remove `execute` from the public tool catalog until implemented.**
Acceptable as a short-term honesty fix, but it leaves the factory planner
without the named execution seam the RFC expects.

**C2. Treat `execute` as an alias for `session_prompt`.** Rejected. Delegation
and execution are different capabilities. A child session is an agent
conversation; execute is a named target/tool/sandbox side effect with its own
claim, policy, and terminal result.

**C3. Implement host-owned durable execute target registry.** Recommended.
`execute` should resolve a named target through host policy, claim externally
visible work before side effects, dispatch the sandbox/tool capability, and
append durable success/failure/timeout/cancel records. The returned tool
result should be derived from that durable terminal state. This can borrow
Fireline's "Call through registry" idea without importing its generic channel
shape.

## §6 -- Acceptance Bar For The Follow-Up Implementation

The implementation that follows this framing should prove these behaviors:

1. An ACP adapter that advertises `loadSession: true` can be cold-restarted,
   loaded by protocol session id, replay session updates, and expose a
   recovered Firegrid promptable state without exposing raw ACP ids to app
   code as the control surface.
2. An ACP adapter that does not support load/resume cannot be treated as
   promptable after owner loss; Firegrid emits a typed not-live or terminal
   recovery record before accepting new prompt/tool work against that session.
3. A `wait_for` tool call can wait on a declared caller-owned factory
   fact/projection, with snapshot-first behavior and timeout terminal state
   derived from durable rows.
4. `execute` either has a real host-owned durable implementation with
   claim-before-side-effect semantics, or the public catalog stops advertising
   it for the runtime-context toolset.
5. Delegation tests continue to use `session_new` / `session_prompt` as the
   factory path, so the implementation does not accidentally broaden this SDD
   into a spawn/spawn_all redesign.

## §7 -- Merge Gate

This SDD is intended to feed the factory-readiness decision alongside cca2's
bottom-up PR #365 evidence. Gurdas signs off §0; the coordinator holds the
merge gate. Do not self-merge an implementation direction from this document
without that signoff.
