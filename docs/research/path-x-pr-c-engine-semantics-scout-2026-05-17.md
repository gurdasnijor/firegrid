# Path X PR C Engine Semantics Scout

Date: 2026-05-17

Scope: read-only review of Path X PR C architecture against `origin/main` after
Host SDK integration. This note captures workflow-engine semantics that should
shape PR C and the invariant tests that should block mixed-mode regressions.

## Finding

PR C should not keep a production alternate path through the legacy
`RuntimeContextWorkflow -> runRuntimeContext -> session-runtime -> subscribers`
stack. The current main branch still composes that path:

- `packages/host-sdk/src/host/layers.ts:20` imports `RuntimeContextWorkflowLayer`.
- `packages/host-sdk/src/host/layers.ts:204` composes it in `FiregridRuntimeHostLive`.
- `packages/host-sdk/src/host/runtime-context-workflow.ts:27` wraps
  `runRuntimeContext` in one workflow activity.
- `packages/host-sdk/src/host/raw-process-runtime.ts:172` calls
  `runCodecRuntimeEventPipeline`.
- `packages/runtime/src/agent-event-pipeline/session-runtime.ts:148` forks
  `runIngressDelivery`, and `:154` forks `runToolRouter`.

The native Path X loop exists at
`packages/host-sdk/src/host/runtime-context-workflow-core.ts:198`, but current
references are test-only. PR C should wire that native workflow as the only host
runtime path or delete the partial native loop. Mixed mode is worse than the old
path because both substrates can be accidentally used.

## Why Raced Activity Plus Wait Is Invalid

The tempting shape is:

```ts
Effect.race(startOrRunSessionActivity, waitForAgentOutput(...))
```

or a durable equivalent that races `Activity.make(...)` against `WaitFor.match`.
That is not the right workflow shape for Path X.

Reasons:

1. `Activity.make` is an idempotent side-effect boundary. Upstream wraps activity
   execution through `engine.activityExecute(...)`; see
   `repos/effect/packages/workflow/src/Activity.ts:232`.

2. Activity execution is tied to workflow suspension semantics. Firegrid's engine
   stores/replays activity rows in
   `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:193`, claims
   them at `:204`, returns `Workflow.Suspended` for a non-winning worker at
   `:219`, and persists completed results around `:228`.

3. `DurableDeferred.await` suspends by asking the engine for a deferred result;
   absent deferred result becomes workflow suspension. See
   `repos/effect/packages/workflow/src/DurableDeferred.ts:102` and `:118`.

4. `DurableDeferred.raceAll` persists the race result through a race deferred and
   runs normal `Effect.raceAll` inside `DurableDeferred.into`; see
   `repos/effect/packages/workflow/src/DurableDeferred.ts:217` and `:227`.
   Losers are interrupted. Activities have an interrupt retry policy by default
   (`repos/effect/packages/workflow/src/Activity.ts:128`). Racing a live
   external-process/session activity against a wait can therefore interrupt and
   retry the side-effect runner, which is the wrong at-most-once boundary.

5. `Workflow.wrapActivityResult` waits for active activity state to drain before
   a suspended result is allowed to settle; see
   `repos/effect/packages/workflow/src/Workflow.ts:566` and `:581`. A long-lived
   activity competing with a wait can strand the workflow instead of producing a
   clean suspended state.

The safe pattern is sequential command activities plus durable waits:

1. Start or attach the external session with a short activity.
2. Return started evidence from that activity once the external supervisor is
   installed.
3. Let output arrive through the per-context output stream.
4. Let the workflow body wait on typed output and issue additional short send or
   tool activities.

## Started And Exited Seam

`Started | Exited` is the right seam for runtime lifecycle evidence, but not as a
single long-running activity result.

Correct shape:

- `RuntimeRun.started` is recorded before the external session start command.
- `startSessionActivity` returns started/attached evidence, not final process
  exit.
- Output/token/stderr/agent observations remain on the per-context side-channel.
- Terminal agent output, such as `Terminated`, is observed by the workflow body.
- The workflow records `RuntimeRun.exited` or `RuntimeRun.failed` after the
  terminal observation.

Incorrect shape:

- One `Activity.make` owns the entire process lifetime and returns `Exited`.
- The workflow races that activity against `WaitFor.match`.
- The old `session-runtime` subscriber path remains callable as a fallback.

The first shape gives the workflow the sequencing authority. The second shape
recreates the old hidden runtime runner and makes waits an observer of a separate
process, not the driver of session choreography.

## PR C Invariant Tests

PR C should add or preserve tests at the workflow/session boundary, not only unit
tests over old table mechanics.

Required engine invariants:

- Poll: absent execution and suspended execution poll as `undefined`; completed
  execution polls as `Workflow.Complete`.
- Interrupt: interrupt persists `interrupted: true` without deleting or
  completing the execution row.
- Replay: completed activity success and failed activity exits replay after
  engine reconstruction without rerunning side effects.
- Activity claim: concurrent workers racing the same activity produce one claim
  and one side-effect execution.
- Suspend cause: `Workflow.SuspendOnFailure` persists and restores cause across
  engine reconstruction.
- Deferred resume: durable deferred completion resumes a suspended workflow after
  engine reconstruction.
- Wait: `WaitFor.match` persists active waits, resolves historical and future
  source rows, reconciles completion-before-status crash windows, supports
  timeout, and resolves concurrent waits independently.

Required Path X runtime invariants:

- `FiregridRuntimeHostLive` composes the native workflow layer, not
  `RuntimeContextWorkflowLayer` from the legacy file.
- Starting a runtime records `RuntimeRun.started`, calls one start/attach
  activity once, and then suspends on typed output if no output exists.
- After host/process restart, the workflow resumes from wait/deferred state
  without rerunning start/attach activity.
- ToolUse handling happens in the workflow body: `RuntimeToolUseExecutor`
  activity returns a `ToolResult`, and a send activity emits it to the session.
- ACP observation-only tool calls are not claimed for tool execution.
- Permission response and tool result paths complete content-derived deferreds or
  session send activities; they do not append through the old ingress delivery
  subscriber path.
- Terminal output drives `RuntimeRun.exited`; a missing terminal output leaves a
  suspended or failed workflow with durable cause, not a hung activity.
- `session.prompt`, `session.permissions.respond`,
  `session.wait.forAgentOutput`, `session.wait.forPermissionRequest`,
  `session.snapshot`, and CLI `run/start` remain session-shaped public APIs.

Required deletion assertions:

- No production import or export of `runRuntimeContext`.
- No production import or export of `runCodecRuntimeEventPipeline`.
- No production import or export of `runIngressDelivery`.
- No production import or export of `runToolRouter`.
- No production export of direct `appendRuntimeIngress` or owner stream helpers
  from app-facing `@firegrid/host-sdk` subpaths.
- `@firegrid/runtime/host-substrate` does not export old ingress delivery or
  output journal authority layers as public escape hatches.

## Current Blockers On Main

As of `origin/main` at `7ab037c24`:

- Legacy production runtime path is still wired.
- Native runtime workflow exists but is not the production host layer.
- `@firegrid/runtime/host-substrate` still exports old bypass surfaces.
- `@firegrid/host-sdk/host` still exports `appendRuntimeIngress`.
- Runtime architecture docs still describe `session-runtime` and subscribers as
  the current operational layout.

These are acceptable only as pre-PR-C state. A final PR C should not land with
any of them still callable as alternate production paths.
