# FINDING — tf-o3x4 factory capability #4 delegation proof

Status authority: bead `tf-o3x4`. Simulation:
`packages/firelab/src/simulations/delegation-proof-cap4`.

## Verdict

GREEN, narrow.

Run `2026-05-21T05-19-22-981Z__delegation-proof-cap4` completed with
760 spans, 0 errored spans, and a 753.7 ms trace window.

The driver span records:

- `firegrid.delegation_proof_cap4.saw_session_new: true`
- `firegrid.delegation_proof_cap4.saw_session_prompt: true`
- `firegrid.delegation_proof_cap4.child_handoff_observed: true`
- `firegrid.delegation_proof_cap4.child_resume_observed: true`

## What this proves

The sim exercises the current v1 delegation path through public surfaces:

- Public client `sessions.createOrLoad`, `prompt`, `start`,
  `session.wait.forAgentOutput`, `firegrid.open(...).snapshot`, and
  `sessions.attach`.
- Public agent tools `session_new` and `session_prompt`.
- No `spawn` or `spawn_all`.

The parent session emits `session_new`, receives a session-shaped child handle,
then emits `session_prompt` to resume that child. The child RuntimeContext is
created with `createdBy = agent-tool:<parentContextId>` and parent/correlation
metadata. The delegated child receives both the initial handoff and the resume
prompt, then emits durable `TextChunk` output containing
`CAP4_CHILD_HANDOFF_RECEIVED` and `CAP4_CHILD_RESUME_RECEIVED`. The driver
observes those outputs through the public session projection surface.

This closes the tf-39b handoff gap for the current v1 path: child creation,
handoff delivery, resume, and externally observable child output all work in
one trace.

The observation assertion is driver-side over the public client projection
surface. Parent-agent `wait_for` over an arbitrary delegated child's
`session.agent_output` remains a separate ergonomics follow-up: the current
runtime-context MCP wait catalog is not a dynamic child-session output catalog.
That does not require a new delegation verb, but it is relevant if beta wants a
planner agent to wait on child output entirely from inside the parent turn.

## Shape notes

`session_new` currently accepts `agentKind`, `prompt`, and options metadata/cwd;
it does not expose a child `agentProtocol` selector. Therefore the delegated
child in this proof speaks the current raw child runtime path and writes the
normalized `firegrid.agent-output` durable event envelope. The parent remains a
stdio-jsonl agent so its tool-use choreography is exercised through the normal
agent-tool lowering path.

That is enough to prove capability #4's live substrate path, but it also
documents a v1 ergonomics boundary: stdio-jsonl child delegation is not yet an
agent-selectable shape through `session_new`. Do not add a new public
delegation verb from this spike alone; if beta needs codec-selectable child
sessions, extend the existing session tool shape deliberately.

## Evidence commands

```bash
pnpm --filter firelab simulate:run delegation-proof-cap4 --timeout-ms 240000
pnpm --filter firelab simulate:show 2026-05-21T05-19-22-981Z__delegation-proof-cap4
pnpm --filter firelab simulate:perf 2026-05-21T05-19-22-981Z__delegation-proof-cap4
```

## Non-goals held

- No new client-surface delegation method.
- No `spawn` / `spawn_all` revival.
- No host-sdk or runtime imports in the driver.
- No provider-specific channel or broad Channel/Queue/Mailbox abstraction.
