# FINDING — tf-7dq: §6 dark-factory ACP halt (expressed, not yet running)

Status: ROOT CAUSE PROVEN + a real Firegrid observability gap sharpened.
No papering: the §6 sim still halts; the halt is now classified precisely
and the limitation is self-documented.

## Two distinct facts

### Fact 1 (root cause, EXTERNAL — not a Firegrid defect)

The planner halts at ACP `session/prompt` purely because the Anthropic
account behind `ANTHROPIC_API_KEY` has hit its configured usage/spend
limit. Proven by a direct `@agentclientprotocol/claude-agent-acp@0.36.1`
repro (initialize → session/new → session/prompt with the real session
id), child stderr:

```
Error handling request { ... method: 'session/prompt' ... } {
  code: -32603,
  message: 'Internal error: API Error: 400 You have reached your specified
            API usage limits. You will regain access on 2026-06-01 at
            00:00 UTC.',
  data: { errorKind: 'unknown' }
}
```

The Firegrid path is SOUND: trace shows `acp.initialize`,
`acp.new_session` (mcp_server_count=1, `firegrid-runtime-context`
attached) all succeed; only the model turn is refused, upstream of any §6
choreography. No Firegrid substrate/integration defect causes the halt.

### Fact 2 (Firegrid observability gap, REAL — sharpened here)

claude-agent-acp puts the real cause on the JSON-RPC `error.message`. But
the `@agentclientprotocol/sdk` `RequestError` consumed by
`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`
(`acpPromise` → `codecError(op, message, cause)`) drops `error.message`;
only `{code:-32603, data:{errorKind:"unknown"}, name:"RequestError"}`
reaches the surfaced `event.cause`. The sim's `JSON.stringify` then can't
recover it either (and a `normalizeForLog` that pulls non-enumerable
`message`/`code`/`data`/`cause` was added and confirms the field is simply
absent from `event.cause`, not merely non-enumerable).

Consequence: an operator/sim CANNOT distinguish "account out of quota"
from a genuine integration bug from the Firegrid-surfaced agent error —
they must separately capture child stderr. That is a precise, actionable
observability gap, distinct from Fact 1.

## What this PR changes (sharpening, not papering)

- `dark-factory-pipeline` adds `normalizeForLog` so any diagnostic fields
  that ARE present (incl. non-enumerable `message`/`cause`) survive
  serialization — forward-compatible the moment upstream propagates them.
- On an opaque `errorKind:"unknown"` ACP error with no message, the sim
  now emits a precise finding
  `dark-factory.acp_error_message_not_propagated`
  (status `blocked-external`) naming the exact loss site and stating that
  §6 is EXPRESSED and the Firegrid path sound, but cannot be PROVEN until
  run with available Anthropic quota. The generic
  `dark-factory.agent_error_before_choreography` is retained.
- The sim still HARD-HALTS before choreography. No fake planner, no
  stubbed tool use.

## Resolution / routing

1. Operational (cannot be fixed in this repo): re-run the §6 dark-factory
   sim with an `ANTHROPIC_API_KEY` whose account has available Anthropic
   quota, or after 2026-06-01 00:00 UTC. Only then can "§6 expressed"
   advance to "§6 proven" (planner → real Firegrid `wait_for` CallerFact /
   `session_new` / `session_prompt` ToolUse).

2. Coordinator routing (Fact 2 — separate runtime-package work, NOT taken
   here on substrate-boundary/scope discipline): propagate the ACP
   JSON-RPC `error.message` (and/or journal child stderr) into
   `AgentCodecError` / the Error agent-output cause at
   `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`, so a
   failed ACP prompt is diagnosable from the trace artifact alone. This is
   an observability fix with its own review surface; a toy must not edit
   the runtime codec unprompted.

## Discipline

HARD HALT respected. The model-turn blocker is external and was not
papered (no synthetic planner). The deliverable is the proven root cause
plus a precise, falsifiable classification and a correctly-scoped routing
of the secondary observability gap. The known-gap findings from #390
(`execute` provider side-effects, `session_cancel`/`session_close` clean
unwind) remain valid and unaffected.
