# subscribers/runtime-context-session-workflow

**Shape: D** — workflow-machinery justified.

Per `docs/cannon/architecture/runtime-design-constraints.md` §"SDD Gate",
Shape D requires the README to name the load-bearing reasons. This folder
satisfies all three:

1. **Exclusive ownership of a per-key resource.** Exactly one live codec
   session (one ACP / stdio-jsonl agent process) per `(contextId,
   activityAttempt)`. The `Workflow.make({ idempotencyKey: ({contextId,
   activityAttempt}) => contextId:activityAttempt })` admission collapses
   concurrent dispatches to one execution; the body's spawn is wrapped in
   `Activity.make({ name: "rcsw.spawn/${key}" })` so engine memoization
   makes it fire exactly once even across body re-materialization.
2. **Cross-execution handoff.** Inputs arrive asynchronously after the
   session starts; the body parks on `Workflow.suspend(instance)` between
   input intents and resumes via `Workflow.resume(executionId)`. The
   Shape C `subscribers/runtime-context` handler converts each Input
   `RuntimeIngressInputRow` into a wakeup `Workflow.resume` and does NOT
   call `session.send` directly.
3. **Restart-safe live side effect.** Activity memoization keeps spawn
   exactly-once across resume; the body re-derives its input cursor from
   durable per-intent processed markers, so a host restart that loses the
   in-memory codec session can re-spawn AND replay the cursor without
   sending the same input twice.

## Replaces

The pre-cutover lifecycle had TWO independent owners of the codec session:

| Caller | Pre-cutover call | Race |
|---|---|---|
| `subscribers/runtime-control/control-request-side-effects.ts:100` | `session.startOrAttach(context, attempt)` | TOCTOU on `Ref<Map<key, session>>` |
| `subscribers/runtime-context/handler.ts` `sendSessionCommand` → `session.send` → `getOrStart` → `session.startOrAttach` | implicit-attach if not present | same Ref TOCTOU |

Both races were proved in production (Zed `agent_silent` /
`firegrid run --prompt --agent claude-acp …` spawned 2 `claude-agent-acp`
PIDs). The fix is structural: this workflow becomes the SOLE admission
boundary; `control-request-side-effects.start` dispatches the workflow
(no direct `startOrAttach`); the Shape C subscriber's Input handler
calls `Workflow.resume` (no direct `session.send`).

Empirical evidence: `packages/tiny-firegrid/src/simulations/runtime-context-session-workflow/FINDING.md`
(probes A/B/C, all GREEN).

## Hard rules

This folder MAY import `@effect/workflow` (`Workflow.make`,
`Activity.make`, `Workflow.suspend`, `Workflow.resume`,
`WorkflowEngine.WorkflowInstance`). All three Shape D justification
items above are required (per `runtime-design-constraints.md` §SDD Gate).

This folder MUST NOT:
- be imported by the Shape C `subscribers/runtime-context-session/`
  folder (its README excludes workflow machinery);
- replace the `RuntimeContextWorkflowSessionService.send` Tag with a
  workflow-only surface — the Tag is preserved so the workflow's own
  Activities call it (the workflow is the sole caller, but the
  Tag-based contract stays).

## Public surface

- `RuntimeContextSessionWorkflow` — the workflow.
- `RuntimeContextSessionWorkflowLayer` — `Workflow.toLayer` for the
  composition root to install.
- `RuntimeContextSessionWorkflowDispatch` — typed dispatch service the
  control-side-effect calls.
