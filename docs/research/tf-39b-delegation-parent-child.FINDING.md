# FINDING — tf-39b factory-vision §7.4 participant delegation

Status authority: bead `tf-39b`. Self-contained sim
`packages/firelab/src/simulations/delegation-parent-child-pipeline.ts`
(auto-discovered by the #385 registry — no shared-file edit; no
`configurations/` import). Lane-built, full CI gate green.

## What the sim does (public surface only)

A deterministic, agent-free stdio-jsonl **parent** participant performs the
§7.4 delegation move purely through the public agent-tool surface:
`session_new` (create child + initial handoff prompt) then `session_prompt`
(resume the child using the returned handle). NO `spawn`/`spawn_all`
(excluded from the toolkit per finding tf-mn2). The driver uses only public
client APIs: `sessions.createOrLoad`, `prompt`, `start`,
`session.wait.forAgentOutput`, `firegrid.open(childContextId).snapshot()`,
`firegrid.sessions.attach`.

Run `2026-05-19T11-54-29-997Z`, status completed.

## PROVEN through the public surface (epistemic tier: SOURCE-VERIFIED)

- `sawSessionNew: true`, `sawSessionPrompt: true`,
  `sawForbiddenSpawnTool: false` — delegation is session_new +
  session_prompt only; no spawn/spawn_all.
- `childCreatedWithParentCorrelation: true` —
  `firegrid.open(childContextId).snapshot().context.createdBy ===
  "agent-tool:<parentContextId>"`, observed strictly through the public
  client. The child RuntimeContext is **durably created with parent
  correlation and observable from the outside**. childContextId is
  deterministic from (parentContextId, session_new toolUseId).

That is the core §7.4 claim "a parent participant creates a child
participant, observable from outside" — demonstrated end to end.

## NOT proven — localized gap (HALT + FINDING, not papered)

`childResultObserved: false`, `childResumeObserved: false`,
`childText: ""`. The child agent produced no `TextChunk`.

Span-level localization (SOURCE-VERIFIED):

- The child context **started** (`firegrid.runtime-context.session.start.
  ctx_ctx_ext_…-child-1`), ran a process, and **all processes exited 0**
  (`firegrid.process.exit_code: 0`) — no exec/crash failure.
- The **only** `session.send.runtime-input` span is the parent's
  `…turn-1`. There is **no** `session.send.runtime-input` delivering the
  `session_new` workflow-authored handoff ingress (nor the subsequent
  `session_prompt`) to the **child** context's agent process.
- Observed `agent_output` event tags across the whole run: `Ready`,
  `ToolUse`, `TurnComplete`, `Terminated` — **zero `TextChunk`**. The
  child, a deterministic stdio-jsonl agent that only emits after receiving
  a `{type:"prompt"}` stdin line, never received one and exited 0 via its
  idle safety timeout.

Conclusion (SOURCE-VERIFIED): the create+correlation half of §7.4 works;
the **delegated handoff prompt is not delivered to the child agent
process**, so "child resumable from inside / parent observes the child
*result*" is unproven through the public surface.

Root cause (epistemic tier: INFERENCE — owed verification): the gap is in
the child-context path that turns a `session_new`/`session_prompt`
workflow-authored ingress into a codec `session.send` to the child agent
stdin. Candidates not yet disambiguated: (a) the child RuntimeContext
workflow does not consume/forward the workflow-authored ingress; (b) the
codec does not flush the workflow-authored prompt to the child process
stdin; (c) the ingress is not appended for the delegated child. The
trace does not carry stdin payloads. **Next verification step:** instrument
the child-context ingress→codec send path (or capture child stdin bytes)
to pin (a) vs (b) vs (c) before any fix is decision-grade.

## Net

§7.4 delegation create + parent correlation: delivered and proven through
the public surface. The handoff-delivery-to-delegated-child gap is
surfaced as a precise, falsifiable finding (the sim goes green the moment
the child receives its prompt). Not a reach-past — the sim uses only
public client + public agent-tool surfaces. Recommend a follow-on
SDD/instrumentation bead to pin and close the child-handoff-delivery gap.
Coordinator holds the gate; no self-merge.
