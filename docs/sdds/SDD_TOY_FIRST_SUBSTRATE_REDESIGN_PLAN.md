# SDD: Toy-First Substrate Redesign Plan

Status: draft planning brief -- Gurdas signs off the plan; coordinator holds the
gate. SDD/plan only: no implementation, no self-merge.

Inputs: PR #366 durable agent-driven choreography SDD, cca2 / PR #365 tiny-firegrid
smoke, RFC restart/choreography guarantees, and Fireline choreography/resume
prior art. cca2 classifies the current dark-factory gap as (b): narrow
public-surface exposure, not protocol mismatch. ACP and its SDK support
`session/load` and wire session ids, app-owned `DurableTable` facts work, and
`runtimeContextMcp` URL-less host injection is the intended public wiring; the
missing seams are Firegrid public session load/wire-id handling, caller-owned
fact waits, and live-host `execute`. Delegation is not a gap because
`session_new` / `session_prompt` are the supported path. Preconditions:
real-agent `runtimeContextMcp` must reliably expose the Firegrid toolset to the
agent before any agent-driven delegation, durable wait, or action slice can be
trusted.

## 1. Invariants

1. **Durable verified facts survive restart and are verifiable.** A test can
   append a fact, restart the toy runtime, read it back from the public surface,
   and verify its schema/hash/source proof without trusting process memory.
2. **Participant identity is stable across reads.** A participant created once
   has one durable id; every later read, delegation, wait, and observation names
   the same id after restart.
3. **Triggers are idempotent.** Submitting the same trigger key twice produces
   one accepted effect and one observable duplicate/no-op result, never two
   downstream side effects.
4. **Participants can delegate.** A participant can create or address another
   participant through the public surface, and both the delegation request and
   resulting child identity are durable facts.
5. **Waits are durable.** A participant can suspend on a declared condition,
   restart can occur while suspended, and the participant resumes or terminalizes
   from durable facts rather than an in-memory promise.
6. **Actions are remembered.** When the toy performs an external or simulated
   action, the accepted action, attempt, and terminal result become facts that
   future participants can observe.
7. **Meaningful state transitions are observable.** Every accepted trigger,
   identity creation, delegation, wait state, action attempt/result, duplicate,
   recovery, and terminal state is inspectable through the public read surface.

## 2. Build Order

1. **Durable verified facts.** Start with the fact log/read contract because
   every later invariant must be asserted from facts, not handles.
2. **Participant identity.** Add stable actor/session identity before triggers
   so idempotency and delegation have durable subjects.
3. **Idempotent triggers.** Add trigger keys before actions so duplicated input
   cannot teach the toy to double-execute.
4. **Observability.** Make transitions readable early; later capabilities must
   not add invisible state.
5. **Toolset visibility gate.** Before choreography-dependent work, run a
   deterministic real-agent probe that distinguishes real runtime-context MCP
   bridge-not-ready from the documented `.smoke`/CI-excluded Codex ACP flake
   where a live LLM spuriously says the tool is unavailable.
6. **Action-and-remember.** Add the first side-effect-shaped behavior only after
   facts, identity, idempotency, and observation exist.
7. **Participant delegation.** Add child participant creation/addressing after
   action memory so delegation does not need host-sdk-style hidden launch state.
8. **Durable waits.** Add suspension last because it is the most likely place to
   smuggle capture-and-replay. It must compose from facts, identity, triggers,
   actions, delegation, and observation.

Capstone: `packages/tiny-firegrid/src/configurations/factory-pipeline.ts` is new
and must read like a public-talk demo. It must not port
`dark-factory-pipeline.ts`, import `packages/host-sdk/src/host/**`, or rely on
hidden host internals. If a primitive is not cleanly exposed, the toy writes the
clean local version instead of reaching past the public surface.

Today's public happy path is the baseline: client/app code can use
`sessions.createOrLoad`, `prompt`, `start`, `snapshot`,
`wait.forAgentOutput`, `wait.forPermissionRequest`, and
`permissions.respond`; agent tools live-supported for this plan are
`sleep`, `wait_for` over runtime observations, `session_new`, and
`session_prompt`. The catalog also names `schedule_me`, cancel/close, and
`execute`; this plan treats unsupported catalog entries as evidence to expose
or remove, not as things the toy may reach around.

## 3. Capability Growth And Temptations

| Capability | Likely substrate growth | Temptation to reject |
| --- | --- | --- |
| Durable verified facts | Tiny append/read API, schema verification, restart fixture. | DurableTable-adapter sprawl, production projection machinery, unchecked casts. |
| Participant identity | Public participant registry and id projection. | Reusing host session internals or exposing adapter wire ids as product ids. |
| Idempotent triggers | Trigger-key table/fold and duplicate outcome rows. | Hidden in-memory dedupe map or "good enough" test timing. |
| Observability | One public transition stream/read model. | Private debug helpers, trace rows only visible by importing internals. |
| Action-and-remember | Simulated action target, durable attempt/result records. | Real provider integrations, sandbox lifecycle, or `execute` host reach-pasts. |
| Participant delegation | Public child-create/address protocol. | Capturing a giant host environment, mutable construction-time getters, or `spawn_all` fanout before single delegation is honest. |
| Durable waits | Wait intent, condition matcher, completion/timeout/recovery rows. | `Effect.context<TagUnion>()` capture/re-provide, deferred handler env unions, in-memory promises as truth, or workflow engine ceremony that hides the contract. |

Hard constraints for every slice: zero `Effect.context<TagUnion>()` captures of
substrate-internal tag unions in `Layer.effect` bodies re-provided into deferred
work; zero self-referential services via mutable construction-time getter; zero
unjustified `Layer.provideMerge` of non-public tags; no union enumerating
"everything the deferred handler might need"; no eslint-disable for type-safety
rules. If types do not work, the architecture is wrong.

## 4. Load-Bearing Pause Gate

The highest-risk capabilities are **durable waits** and **participant
delegation**. They are where host-sdk reproduced capture-and-replay: repeated
`Effect.context` captures, the `RuntimeContextWorkflowSession` cycle, and the
TFIND-055 class-(b) public-surface gap where the workflow could wait but the
agent-facing protocol could not durably suspend/resume.

Pre-commitment: after each capability, write one paragraph in the PR body or
slice note: **"Did the substrate grow along the right axis, or did it accrete
another capture-and-replay piece?"** If the answer names any banned pattern
above, stop. Do not continue to the next capability, do not patch around the
type error, and do not widen an environment union. Reconsider the public
primitive shape first.

cca2's current smoke is ambiguous and must stay that way until the visibility
gate runs: the existing Codex ACP sleep smoke also failed here with "Firegrid
sleep MCP tool unavailable", but that can mean either a real runtime-context
MCP bridge-readiness problem or the documented `.smoke`/CI-excluded Codex ACP
failure mode where a live LLM spuriously says the tool is unavailable.
`claude-agent-acp` reached `Ready` without observable tool/text, and the `zed`
bridge was paused before conclusion. The toy must disambiguate with the
deterministic probe, then make real bridge failures visible as missing public
primitive/bridge capability, not solve them by importing host internals.
Session/load replay belongs to the tf-vao line: ACP replays conversation
through `session/update` on load, but Firegrid does not yet expose public
wire-sessionId/load.

## 5. Stop Condition

Declare toy success when `factory-pipeline.ts` demonstrates the seven
invariants through the public tiny-firegrid surface, survives a restart at the
fact/wait boundary, and remains small enough to explain live without naming
host-sdk internals.

Declare escalation when a capability cannot be expressed without a banned
pattern, hidden host import, broad deferred environment capture, eslint-disable,
or private protocol state. That means the production substrate was load-bearing
after all; pause the toy and ask Gurdas whether to expose the missing primitive
or change the invariant.

Separately escalate substrate readiness if the deterministic toolset-visibility
probe cannot show that a real agent reliably sees the Firegrid toolset through
`runtimeContextMcp`. That is not capture-and-replay accretion; it is a failed
precondition for agent-driven capabilities.
