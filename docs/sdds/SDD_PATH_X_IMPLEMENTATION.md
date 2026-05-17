# SDD: Path X Workflow-Native Runtime Substrate Implementation

Status: draft implementation plan

Date: 2026-05-17

Authoritative inputs:

- `docs/research/workflow-native-runtime-substrate-spike-2026-05-16.md`
- `docs/research/workflow-engine-audit.md`
- `docs/research/durability-assumption-audit-2026-05-16.md`

Related specs:

- `firegrid-host-sdk`
- `firegrid-schema-projection-contract`
- `firegrid-runtime-agent-event-pipeline`
- `firegrid-runtime-boundary-reconciliation`
- `firegrid-workflow-driven-runtime`
- `workflow-engine-durable-state`

## Decision

Path X is the implementation target: a reactive `RuntimeContextWorkflow` body
over `DurableStreamsWorkflowEngine`, using content-derived `DurableDeferred`
for input, permission, and tool round-trips; reusing the existing
`durable-tools` wait-router and reconciler for push wake and crash recovery;
and keeping high-volume output on per-context side-channel streams.

This is a greenfield project, not a production migration. The plan should not
carry dual-write soak windows, compatibility writers, divergence detection, or
large public-surface preservation matrices. The current public session method
shape remains the SDK boundary, but the implementation can move directly to the
workflow-native substrate once the targeted prep work is done.

## Coordination

PR 282, the `RuntimeToolUseExecutor` seam, is compatible with Path X and should
not be blocked. Path X consumes that seam when the reactive workflow body runs
tool execution inside workflow activities.

The Host SDK plane-split lane remains parallelizable. Its public surface is
transport-shaped: session methods and host composition, not table appends. The
optional Host SDK `RUNTIME_CAPABILITY_PROJECTIONS` cleanup should be cancelled,
because Path X deletes or rewrites the authority files it would polish.

## Greenfield Scope Rules

- Do not build dual-write pathways between old ingress rows and new deferred
  commands.
- Do not add compatibility writers whose only purpose is to preserve old table
  authority behavior during a migration window.
- Do not add divergence-detection observability between old and new substrates.
- Do not expand this SDD into a table-by-table public-surface preservation
  checklist.
- Keep client and CLI interactions session-shaped. App-facing examples should
  use `sessions.createOrLoad`, `session.prompt`, `session.wait.*`,
  `session.permissions.respond`, `session.snapshot`, and `watchContexts`.
- The rewrite may delete old runtime authority/subscriber code once replacement
  tests prove the workflow-native behavior.

## Engine And Runtime Decisions

The reactive workflow body should use `Workflow.SuspendOnFailure`. Runtime
contexts are long-lived and externally observable; recoverable codec, delivery,
tool, or host-substrate failures should suspend the workflow with an
inspectable cause rather than erase diagnostic state. Because the workflow
engine audit found that `instance.cause` is not durable today, PR A adds durable
cause persistence before the reactive body lands.

User-initiated tool cancellation is not required for the first Path X cutover.
The current public surface does not expose a durable in-flight tool cancel
operation that must interrupt a running activity. PR A documents current
`interrupt` behavior with tests. Full cluster-style in-flight activity
cancellation should be implemented only when a public cancel surface requires
it.

Side effects that cross the runtime boundary must be workflow activities. In
particular, stdin byte emission, ACP JSON-RPC sends, and equivalent
process/session side effects must be wrapped in `Activity.make`. DurableDeferred
first-writer-wins protects input acceptance; workflow activity rows and claims
protect at-most-once external side effects.

## Sequence

### PR A: Engine Confidence And Durable ACP Permission Fix

Purpose:

- Close the workflow-engine test gaps required by Path X.
- Add the small engine durability hardening needed for `SuspendOnFailure`.
- Fix the ACP permission continuation crash-loss bug independently of the full
  substrate rewrite.

What it does:

- Adds isolated `poll` tests for absent, in-flight or suspended, and completed
  workflow executions.
- Adds isolated `interrupt` tests for persisted interrupted state and resume
  behavior.
- Adds failed-exit replay tests for `deferredResult`.
- Adds failed-exit replay tests for `activityExecute`.
- Adds a durable `cause` field to `WorkflowExecutionRow`, writes it when a
  workflow suspends on failure, and restores it into `WorkflowInstance`.
- Replaces ACP `livePermissionContinuations` with content-derived
  `DurableDeferred` names such as `permission-{id}`.

Likely files:

- `packages/runtime/src/workflow-engine/internal/table.ts`
- `packages/runtime/src/workflow-engine/internal/engine-runtime.ts`
- `packages/runtime/test/workflow-engine/DurableStreamsWorkflowEngine.test.ts`
- `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`
- relevant ACP/session permission tests under `packages/runtime/test/` and
  `packages/client/test/`

Behavior changed:

- Suspended workflow failure cause survives process restart.
- ACP permission responses no longer depend on an in-memory promise map.
- No reactive runtime-context rewrite yet.

Invariants and validation:

- Existing workflow-engine durability tests remain green.
- ACP permission request/response behavior remains session-shaped.
- `session.permissions.respond` still returns `contextId`,
  `permissionRequestId`, and `inputId`.
- Browser/client code still does not import runtime or workflow-engine modules.

Reversible standalone:

- yes. This is independently useful engine coverage plus a real permission
  durability bug fix.

Gates:

- the reactive body's use of `Workflow.SuspendOnFailure`;
- durable permission handling inside the codec-session activity boundary;
- confidence that failed deferred and activity exits replay correctly.

Estimate:

- 3 to 5 engineer-days.

### Q-2 Proof Work: CodecSessionAlive Activity Boundary

Before committing to the final reactive body shape, spend 1 to 2 days proving
the codec-session activity boundary. This is proof work, not a long gate with
formal acceptance thresholds.

Scope:

- Build the smallest local-process proof of one long-running
  `CodecSessionAlive` activity plus an external sandbox supervisor.
- Verify replay behavior around process/session restart.
- Prove that byte emission is represented as an `Activity.make` side effect,
  preserving the current at-most-once invariant from
  `packages/runtime/test/sources/sandbox/local-process-stdin-delivery.test.ts`.
- Check whether ACP needs the same supervisor shape or a small adaptation.

Output:

- either a short committed test/proof if it is clean enough to keep, or a short
  implementation note attached to PR B;
- a go/no-go on the exact reactive body shape. If the full replayable codec
  session is too awkward, keep the reactive body and deferred command model but
  use the spike's fallback: a thin host-scoped live codec process driven by the
  workflow body.

Estimate:

- 1 to 2 engineer-days.

### PR B: Workflow-Native Runtime Substrate Rewrite

Purpose:

- Replace the current runtime authority/subscriber bypass with the Path X
  workflow-native substrate in one direct rewrite.

What it does:

- Rewrites `RuntimeContextWorkflow` as the reactive control-plane loop.
- Uses content-derived DurableDeferred names for prompt input, permission
  responses, and tool results.
- Wires the existing durable-tools wait-router and reconciler for
  runtime-context deferred wake.
- Introduces the per-context output side-channel stream for token streams,
  stderr/log lines, and normalized agent-output observations.
- Runs tool execution through `RuntimeToolUseExecutor` inside workflow
  activities.
- Wraps external side effects such as stdin emission and ACP sends in
  `Activity.make`.
- Replaces `tool-router.ts`, ingress delivery, and session-runtime bypass
  responsibilities with workflow-body behavior.
- Updates client/session reads and waits to the new runtime substrate without
  adding dual-write or compatibility writer layers.
- Rewrites tests from old ingress/table mechanics to session-level behavior and
  workflow-native durability.

Likely files:

- `packages/runtime/src/host/runtime-context-workflow.ts`
- `packages/runtime/src/host/runtime-substrate.ts`
- `packages/runtime/src/host/layers.ts`
- `packages/runtime/src/host/raw-process-runtime.ts`
- `packages/runtime/src/agent-event-pipeline/session-runtime.ts`
- `packages/runtime/src/agent-event-pipeline/subscribers/tool-router.ts`
- `packages/runtime/src/agent-event-pipeline/subscribers/ingress-delivery.ts`
- `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process-stdin-delivery.ts`
- `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-appender.ts`
- `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts`
- `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts`
- `packages/runtime/src/durable-tools/internal/wait-router.ts`
- `packages/client/src/firegrid.ts`
- runtime host, subscriber, source, client session, and CLI scenario tests

Behavior changed:

- Runtime contexts are driven by the reactive workflow body.
- External input and permission/tool round-trips are workflow deferred
  completions, not direct ingress table delivery.
- At-most-once delivery is enforced by workflow activities and activity claims.
- High-volume output is side-channel stream data, not workflow journal data.

Invariants and validation:

- Cross-host prompt routing remains true at the session level: a non-owner host
  can submit input for an owner-host context and the owner workflow receives it.
- `session.prompt`, `session.permissions.respond`, `session.wait.forAgentOutput`,
  `session.wait.forPermissionRequest`, `session.snapshot`, and `watchContexts`
  remain the app-facing operations.
- Tool execution still uses `RuntimeToolUseExecutor`; runtime does not import
  host-sdk, client-sdk, or CLI.
- `schedule_me` continues to work through the executor/live host composition.
- The local-process stdin at-most-once crash test is rewritten to assert the
  activity-backed invariant.
- Runtime output waits observe history and future output from the new
  side-channel stream.

Reversible standalone:

- by revert only. This is the intentional substrate replacement, not a staged
  migration.

Gates:

- PR A;
- the 1 to 2 day Q-2 proof work.

Estimate:

- 1.5 to 3 engineer-weeks.

### PR C: Cleanup And Spec Alignment

Purpose:

- Remove dead code, stale exports, stale docs, and spec references after the
  direct rewrite lands.

What it does:

- Deletes old runtime authority/subscriber files that PR B left behind only to
  keep the diff reviewable.
- Removes obsolete exports and provider wiring for old ingress delivery,
  output-journal authority, and ToolUse router paths.
- Updates `packages/runtime/ARCHITECTURE.md` and
  `packages/runtime/src/agent-event-pipeline/README.md` to describe the
  workflow-native substrate.
- Updates SDD/spec references so `RUNTIME_CAPABILITY_PROJECTIONS` is marked
  superseded or removed from active implementation scope.
- Removes tests that only asserted deleted internal table mechanics and keeps
  session/workflow behavior tests.
- Runs dependency, dead-code, docs, specs, and semgrep checks.

Likely files:

- `packages/runtime/src/index.ts`
- `packages/runtime/ARCHITECTURE.md`
- `packages/runtime/src/agent-event-pipeline/README.md`
- `docs/sdds/*`
- `features/firegrid/*.feature.yaml`
- obsolete runtime authority/subscriber tests

Behavior changed:

- none intended beyond removing dead implementation surface.

Invariants and validation:

- `@firegrid/runtime` does not import host-sdk, client-sdk, or CLI.
- host-sdk and client-sdk remain sibling projections over protocol.
- browser/client code does not import runtime, host-sdk, Node modules, Effect AI,
  MCP, or platform-node.
- dead-code and dependency checks see the old bypass tier as gone.

Reversible standalone:

- yes, as a cleanup PR after PR B.

Gates:

- PR B.

Estimate:

- 2 to 4 engineer-days.

## Summary

The implementation is now three code PRs plus one short proof interval:

1. PR A: engine tests/hardening and durable ACP permission continuation fix.
2. Q-2 proof work: 1 to 2 days validating the codec-session activity boundary.
3. PR B: direct workflow-native substrate rewrite.
4. PR C: cleanup and spec/docs alignment.

Expected implementation scale is roughly 3 to 5 engineering-weeks after the
executor seam, assuming the Q-2 proof confirms the reactive body shape or uses
the documented fallback without changing the public session API.

