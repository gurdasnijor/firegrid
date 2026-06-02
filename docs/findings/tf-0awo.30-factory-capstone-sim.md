# tf-0awo.30 — factory capstone sim after #831

**Bead:** `tf-0awo.30b` · **Sim:** `factory-capstone` · **Date:** 2026-06-02
**Run:** `packages/tiny-firegrid/.simulate/runs/2026-06-02T14-26-21-332Z__factory-capstone/trace.jsonl`
**Main:** `dcf6f312b1f6c9a1102333d2098f1c82aac14c71`

## Result

The post-#831 rerun proves the old factory blocker is cleared. The planner's
`session_new` no longer falls through to `tool "session_new" is not yet ported
onto the unified executor`; that string is absent from the 1,782-line trace.

The trace advances from external trigger through delegated child session
creation, initial child prompt, explicit `session_prompt`, child output
observation, and a child ACP permission request. It does not reach the requested
`FACTORY_CAPSTONE_TERMINAL` merge-signoff marker in this run.

## Evidence

- Line 27 seeds the `darkFactory.facts` trigger fact.
- Line 40 registers the runtime-context MCP toolkit, including `session_new`,
  `session_prompt`, `session_cancel`, `session_close`, and `execute`.
- Line 395 shows the planner's `wait_for` on `darkFactory.facts` completing
  before delegation.
- Lines 464-477 show the parent planner calling
  `mcp__firegrid-runtime-context__session_new` with a real delegated prompt and
  receiving the ACP permission gate for that tool call.
- Line 611 dispatches `host.sessions.create_or_load`.
- Lines 638 and 661 show the child ACP `session/new` and the spawned child
  runtime context.
- Lines 675, 688, and 695 show the initial child prompt and the remaining
  `session_new` lowering sequence: `session.prompt` send, then
  `host.sessions.start` call.
- Line 715 is the successful `Toolkit.handle` span for `session_new`; lines
  718 and 720 return a running child `{ sessionId, contextId }` to the parent.
- Lines 796-809 show the parent planner calling
  `mcp__firegrid-runtime-context__session_prompt`.
- Lines 952, 970, 985, 988, and 990 show `session_prompt` dispatching
  `session.prompt`, delivering a second child ACP `session/prompt`, and
  returning `{ appended: true }` to the parent.
- Lines 1196, 1397, 1575, and 1731 show parent `wait_for` calls against
  `session.agent_output`; lines 1587/1592 and 1743/1754 show the parent
  observing child output after delegation.
- Line 1765 is the driver summary: status `incomplete`, output count 80,
  permission requests 3, no terminal marker, no finding marker, no timeout.

## How far it runs

The loop now runs through the public surface far enough to create a delegated
child context, prompt it twice, start it, and observe child output from the
parent via `wait_for` over `session.agent_output`. That is the factory
delegation proof that was blocked by the old `session_new` executor fallthrough.

The run stops because the sim driver has an 80-output cap
(`packages/tiny-firegrid/src/simulations/factory-capstone/driver.ts:69-78`),
not because the parent emitted a `FACTORY_CAPSTONE_FINDING` marker or hit its
15s wait timeout. The child had reached an ACP permission request for
`mcp__firegrid-runtime-context__execute` at lines 1073-1084. The parent then
observed that child `execute` tool call through `session.agent_output` at lines
1587/1592 and 1743/1754 before the driver cap ended the run.

## Next boundary

No new terminal production gap is proven by this run. Two boundaries are visible:

1. The first parent `wait_for` against `session.agent_output` omitted
   `afterSequence` and failed schema decoding at line 1208. The planner
   recovered by retrying with explicit cursors (`afterSequence: -1`, then `0`,
   then `10`). Source check: `sessionAgentOutputObservationRoute` currently
   requires `afterSequence` in
   `packages/runtime/src/channels/session-agent-output-route.ts:35-45`.

2. The child attempted `execute` and stopped at an ACP permission request
   because this sim only auto-approves the parent session. Source check:
   `execute` is still advertised by the MCP toolkit
   (`packages/runtime/src/unified/mcp-host/toolkit.ts:186-190`), but
   `tool-dispatch.ts` has no `case "execute"` and still falls through at
   `packages/runtime/src/unified/mcp-host/tool-dispatch.ts:598-605`. This run
   does not prove the execute fallthrough dynamically because the child execute
   call did not pass the ACP permission gate before the sim stopped.

## Triage

`session_new`/`session_prompt` delegation is now green for the capstone path.
The old Category 2 implementation gap is closed by #831.

The remaining status for this run is **Category 3 / sim boundary until further
evidence**: the driver ends at its own output cap while the child permission
request is pending. A follow-up sim should either auto-approve delegated child
permissions or constrain the child not to call `execute`; only then can it
prove whether the next production gap is `execute` lowering or a planner prompt
discipline issue.
