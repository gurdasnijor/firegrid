# SDD: Durable Agent-Driven Choreography Surface

Status: framing draft -- architect-gated. Gurdas decides §0. This is an
SDD-only PR; no implementation code, and no merge without coordinator signoff.

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
- oca3 bead `tf-7dq`: active §6 dark-factory Claude-ACP startup halt work
  (expressed -> running), which is resolving the same adapter session recovery
  seam framed here

## §0 -- The load-bearing question, read this first

**How should Firegrid expose ACP adapter session recovery so a real tool-use
agent can durably suspend, recover, and resume choreography through the public
Firegrid session surface after live process loss?**

Gurdas-gated coordinator recommendation: keep the public contract centered on
Firegrid session identity plus typed promptability/recovery state, while the
runtime privately persists enough adapter identity and reattach profile to use
ACP `session/load` or `session/resume` when the adapter supports it. Do not
expose raw ACP wire session ids as the public control contract.

This is now the single open dark-factory public-surface blocker from the original
three-gap packet. The other two gaps were closed after this SDD was first
written: PR #383 added typed `CallerFact` waits, and PR #388 landed the durable
`execute` side-effect seam. Those resolved facts sharpen rather than broaden the
question: the factory loop can now wait on caller-owned facts and execute bounded
capabilities, but a `persistent:false` ACP agent still needs a public, durable
protocol path for recovery when a synchronous MCP call outlives the original
agent process.

`tf-7dq` is the active implementation/proof lane for the same seam: the §6
dark-factory Claude-ACP startup halt is the bottom-up symptom of adapter session
ownership and recovery not yet being proved end-to-end. This SDD should converge
with that lane rather than spawn a duplicate solution track.

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

### 2. RESOLVED by PR #383: `wait_for` can wait on caller-owned facts

This section is no longer an open gap. PR #383 (`tf-0du`) added the typed
`CallerFact` source to `RuntimeWaitSource`: `AgentOutput` and `RuntimeRun` remain
runtime-owned observations, while `CallerFact` names a caller-owned durable fact
stream by stable `stream` name
(`packages/protocol/src/agent-tools/schema.ts:92-123`). The runtime wait streams
layer now has an optional `CallerOwnedFactStreams` host-composition capability
that resolves that stream name to a concrete durable observation stream
(`packages/runtime/src/durable-tools/internal/runtime-wait-streams.ts:40-75`),
and the wait router dispatches the `CallerFact` variant rather than rejecting it
(`packages/runtime/src/durable-tools/internal/wait-router.ts:104-108`).

The residual design constraint remains useful but is not a blocker for §0: the
agent-facing surface carries a typed source discriminator and a stream name, not
a DurableTable facade or an arbitrary string channel registry. That preserves the
ownership frame from `SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md` while letting
the factory planner wait on app-owned facts such as human approvals, provider
callbacks, and factory phase projections.

This also explains why TFIND-053 was retracted: the missing thing was not a
separate agent read API. The intended action surface is public `sessions.*` plus
the runtime-context MCP toolset. With `CallerFact` in place, caller-owned durable
fact waits are no longer the open dark-factory blocker.

### 3. RESOLVED by PR #388: `execute` has a live durable side-effect seam

This section is no longer an open gap. PR #388 (`tf-i20`) replaced the stale
"catalog only" state with a live host-owned execution seam. The protocol still
advertises `execute` as a sandbox-neutral operation
(`packages/protocol/src/agent-tools/schema.ts:510-587`), and the dispatcher still
routes the tool to `AgentToolHost`
(`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:461-477` and
`:632-635`). The live host now implements `executeSandboxTool` and
`executeSessionCapability` through `runProviderExecute`
(`packages/host-sdk/src/host/agent-tool-host-live.ts:106-156` and `:243-269`)
instead of returning `unsupportedAgentTool` for the execute paths.

The residual nuance is capability availability, not public-surface absence: a
host composition still needs a `SandboxProvider`/capability to execute against,
and absence fails as a typed tool execution failure
(`packages/host-sdk/src/host/agent-tool-host-live.ts:123-131`). That is the
right narrowed boundary for factory readiness: `execute` is a bounded advertised
capability path, not arbitrary provider access and not a delegation substitute.

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

Firegrid now satisfies this for caller-owned factory facts through the typed
`CallerFact` source added in PR #383. The remaining gap is not fact-wait
expressiveness; it is recovering the live adapter/tool-use session that issued
the wait when the original ACP process is gone.

### Choreography-first application layer

The RFC's choreography layer says the model owns ordering, branching,
parallelism, and recovery at runtime, while durability comes from tools such
as `sleep`, `wait_for`, `spawn`, `spawn_all`, `schedule_me`, and `execute`
(`docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/choreography-and-combinators.md:17-34`).
Each primitive must append durable trace/session records before suspension,
fanout, or external work, and must be observable by humans and agents through
stream-derived observation.

Firegrid currently exposes much of the tool vocabulary, and PR #383/#388 closed
the caller-fact wait and execute surface gaps. The durable agent-driven seam is
still incomplete at adapter session recovery: the public surface must let a real
tool-use agent continue choreography without relying on live-process continuity
or app/private reach-pasts.

## §3 -- Firegrid-Specific Alignment Needed In The RFC Frame

The RFCs are useful as guarantees, but the SDD follow-up should align them to
Firegrid's chosen substrate vocabulary before implementation:

1. **Delegation vocabulary:** the RFC names `spawn` / `spawn_all`; Firegrid's
   factory path can use `session_new` / `session_prompt`. Treat delegation as
   satisfied for this SDD unless a later product requirement needs batch
   fanout ergonomics.
2. **State wait vocabulary:** PR #383 mapped the RFC's `state.changes(query)`
   shape to declared caller-owned fact streams via typed `CallerFact`; do not
   copy Fireline's broad stringly channel registry into Firegrid's public
   protocol.
3. **Session recovery vocabulary:** ACP now distinguishes `loadSession` for
   `session/load` and `sessionCapabilities.resume` for `session/resume`.
   Firegrid should store adapter capabilities and profile decisions, while
   public clients/agents use Firegrid session identity and promptability state.
4. **Execute vocabulary:** PR #388 made the RFC's `execute(sandbox, input)` a
   Firegrid host-policy target. The remaining alignment point is to keep it as a
   bounded capability/sandbox path, not an arbitrary process escape hatch.
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

### Resolved Gap B: caller-owned durable fact waits

PR #383 chose the B3-shaped direction: `RuntimeWaitSource` now includes typed
`CallerFact` sources resolved by host-composed caller-owned fact streams. The
original rejected options still stand as guardrails: do not add arbitrary source
strings, and do not force factory facts into `AgentOutput`.

This resolved gap should not remain in §0. It is evidence that the decomposition
was right, and that the remaining decision can focus narrowly on ACP adapter
session recovery.

### Resolved Gap C: `execute`

PR #388 landed the C3-shaped direction additively: live host `execute` resolves
through a bounded sandbox/provider or session capability seam and reports typed
failures when no capability is composed. The original rejected options still
stand as guardrails: do not treat `execute` as delegation, and do not make it an
arbitrary provider escape hatch.

This resolved gap should not remain in §0 either. The open follow-up is only how
ACP-backed agent sessions survive owner loss and resume/terminalize the
choreography turn through Firegrid's public session surface.

## §6 -- Acceptance Bar For The Follow-Up Implementation

The implementation that follows this framing should prove the still-open
adapter recovery behaviors, and should treat the resolved wait/execute seams as
inputs rather than duplicate work:

1. An ACP adapter that advertises `loadSession: true` can be cold-restarted,
   loaded by protocol session id, replay session updates, and expose a
   recovered Firegrid promptable state without exposing raw ACP ids to app
   code as the control surface.
2. An ACP adapter that advertises `sessionCapabilities.resume` can reconnect
   through ACP `session/resume` when its negotiated profile makes that sound,
   and Firegrid records the resulting promptability/recovery state durably.
3. An ACP adapter that does not support load/resume cannot be treated as
   promptable after owner loss; Firegrid emits a typed not-live or terminal
   recovery record before accepting new prompt/tool work against that session.
4. A long-running MCP tool call has an explicit durable suspension/recovery
   lifecycle. It may block only under an adapter profile Firegrid can reattach
   and prove; otherwise the public contract must surface a durable
   terminal/recovered result path rather than depending on a live process.
5. The `tf-7dq` §6 Claude-ACP startup halt investigation and this SDD converge
   on the same adapter recovery seam, so implementation evidence from `tf-7dq`
   updates this decision packet instead of creating a parallel solution.
6. Delegation tests continue to use `session_new` / `session_prompt` as the
   factory path, so the implementation does not accidentally broaden this SDD
   into a spawn/spawn_all redesign.
7. `CallerFact` waits from PR #383 and `execute` from PR #388 remain accepted
   substrate inputs; regressions there are bugs in those seams, not new §0
   decision questions.

## §7 -- Merge Gate

This SDD is intended to feed the factory-readiness decision alongside cca2's
bottom-up PR #365 evidence. Gurdas signs off §0; the coordinator holds the
merge gate. Do not self-merge an implementation direction from this document
without that signoff.
