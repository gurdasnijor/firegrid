# Shape C Clean-Room Test Triage

Status: dispatch aid
Date: 2026-05-22
Source: CC2 read-only stdout triage

This note turns the host-sdk test triage into a checklist for the clean-room
composition slice. It is not new architecture. It applies the greenfield rule:
tests that assert the old parked RuntimeContext workflow body are stale unless
they can be rewritten to assert the same product behavior through Shape C
observables.

## Repoint To The Clean-Room Entry

These tests keep their product invariant, but must stop driving
`RuntimeContextWorkflowRuntime`, `RuntimeContextWorkflowNative`, or
`WorkflowEngineTable` directly.

- `packages/host-sdk/test/host/prompt-routing.test.ts`
  - Rewrite deferred-input helpers to assert durable ingress row sequencing and
    `RuntimeContextStateStore.lastProcessedInputSequence`.
  - Replace `runtime.dispatchIntent(...)` / `runtime.ensureActive(...)` calls
    with the clean-room startRuntime + appendRuntimeIngress path.
  - Preserve no-engine-attached, reconcile, and child-spawn product behavior.

- `packages/host-sdk/test/host/runtime-codec-event-plane.test.ts`
  - Delete `waitForWorkflowDeferred`.
  - For the ACP permission rendezvous test, assert:
    - inbound permission input exists in `RuntimeControlPlaneTable.inputIntents`;
    - one session command is emitted with commandId
      `runtime-input-<contextId>-<inputId>`;
    - pending permission state is cleared after rendezvous.
  - Keep the `schedule_me` / `ScheduledPromptWorkflow` assertion as
    Shape-D-valid.

- `packages/host-sdk/test/host/two-host-isolation.test.ts`
  - Replace `WorkflowEngineTable.executions` peeks with per-host
    `RuntimeOutputTable` row peeks.
  - Preserve the isolation invariant: a host observing the wrong context sees no
    rows.

- `packages/host-sdk/test/host/channel-tags.test.ts`
  - Replace `RuntimeContextWorkflowRuntime.ensureActive(context)` and
    `workflowName === "firegrid.runtime-context"` with the clean-room
    context-creation entry and a target-shape owner identifier.
  - Keep channel target/tag composition tests.

## Delete Or Replace Elsewhere

These tests directly drive the parked body and should not be kept as
compatibility assertions.

- `packages/host-sdk/test/host/runtime-context-workflow-core.test.ts`
  - Delete tests centered on `RuntimeContextWorkflowNative`,
    `RuntimeContextWorkflowNativeLayer`, `executeRuntimeContextWorkflow`, and
    `runtimeContextWorkflowExecutionId`.
  - Specifically stale body-replay tests called out by CC2: lines around 538,
    581, 730, 817, and 936.
  - Move any still-valid assertions to target homes:
    - Shape B output observation tests move under runtime
      `agent-event-pipeline` subscriber/source tests.
    - Session prompt ingress through `RuntimeContextWorkflowSession.send` moves
      to the Shape C handler/subscriber test surface.
    - Permission correlation and output gap skip are Shape C handler/state tests,
      not workflow-body replay tests.

## Keep As Target-Valid Shape D

These references are not evidence for the old RuntimeContext body and should
survive if their local test harness is decoupled from stale helpers.

- `ScheduledPromptWorkflow` / `DurableClock.sleep` coverage for `schedule_me`.
- `WaitForWorkflow` usage that proves durable wait routing.
- `DurableStreamsWorkflowEngine` / `WorkflowEngineTable` tests inside
  runtime-owned workflow-engine test surfaces.

## Keep And Extend Deletion Guards

- `packages/host-sdk/test/host/two-host-isolation.test.ts`
  - Keep the guard removing the `RuntimeContextEngineRegistry` application
    surface.
  - Extend absent-symbol checks to include:
    - `RuntimeContextWorkflowNative`
    - `RuntimeContextWorkflowNativeLayer`
    - `RuntimeContextWorkflowRuntime`
    - `executeRuntimeContextWorkflow`
    - `runtime-input-deferred`

- `packages/host-sdk/test/host/channel-tags.test.ts`
  - Keep negative payload checks that prevent substrate internals from leaking
    into channel payloads.
  - Extend negative-substring checks to include:
    - `RuntimeContextWorkflowNative`
    - `runtime-input-deferred`

## Acceptance For CC1

The clean-room composition PR should include at least one real runtime turn
through the new entry. Host-sdk public-flow tests may be repointed or replaced
according to the list above. They should not be made green by preserving
`RuntimeContextWorkflowRuntime`, workflow deferred mailboxes, or
`RuntimeContextWorkflowNative` as the execution path.
