# Shape C Legacy Deletion And Export Map

Status: dispatch aid
Date: 2026-05-22
Source: CC4 read-only stdout triage

This note turns the legacy reachability scan into Wave 2 deletion lanes. It is
intended to review the clean-room composition PR and then drive deletion once
the new entry proves a real runtime turn.

## Lane A: RuntimeContext Body Driver Removal

Remove or quarantine every public/exported route into the old parked
RuntimeContext workflow body.

Runtime exports to shrink:

- `packages/runtime/src/index.ts`
  - Remove:
    - `RuntimeContextWorkflowNative`
    - `RuntimeContextWorkflowNativeLayer`
    - `RuntimeContextWorkflowPayload`
  - Keep:
    - `RuntimeContextWorkflowSession` and session command/evidence types
    - `RuntimeContextStateStore` and state-store helpers

- `packages/runtime/src/kernel/index.ts`
  - Remove:
    - `RuntimeContextWorkflowNative`
    - `RuntimeContextWorkflowNativeLayer`
    - `executeRuntimeContextWorkflow`
    - `RuntimeInputIntentDispatcherLive`
  - Delete with it:
    - `packages/runtime/src/kernel/internal/run-context-workflow.ts`
  - Keep:
    - `readRuntimeContext`
    - `requireLocalRuntimeContextWithHostSession`
    - runtime config/read helpers

- `packages/runtime/src/workflow-engine/index.ts`
  - Remove:
    - `appendRuntimeInputDeferred`
  - Delete with it:
    - `packages/runtime/src/workflow-engine/runtime-input-deferred.ts`
  - Keep:
    - `DurableStreamsWorkflowEngine`
    - `WorkflowEngineTable`
    - workflow-engine row types

- `packages/runtime/src/workflow-engine/workflows/index.ts`
  - Remove:
    - `RuntimeContextWorkflowNative`
    - `RuntimeContextWorkflowNativeLayer`
    - `runtimeInputDeferredFor`
    - `runtimeInputDeferredName`
    - `RuntimeContextWorkflowExecutionEnv`
  - Keep:
    - `RuntimeContextWorkflowSession` and command/evidence types, until they
      move to a less misleading path.
    - `WaitForWorkflow`, `ToolCallWorkflow`, scheduled-prompt workflow, and
      other Shape-D-valid workflows.

Host-sdk old entries to rewrite or leave inert until deletion:

- `packages/host-sdk/src/host/commands.ts`
  - Keep public names such as `startRuntime` / `appendRuntimeIngress` only if
    their bodies are rewritten to call the clean-room entry.
  - Remove the old `executeRuntimeContextWorkflowForContextId` path.

- `packages/host-sdk/src/host/runtime-context-workflow-support.ts`
  - Remove the `runtimeContextWorkflowSupportLayer` old body wiring.
  - Keep or move `toolCallWorkflowSupportLayer` only if still needed for
    Shape-D-valid tool/scheduled-prompt support.

## Lane B: Agent Tool Host Re-Entry Removal

Remove agent-tool paths that re-enter the old RuntimeContext workflow body.

- `packages/host-sdk/src/host/agent-tool-host-live.ts`
  - Remove the block that calls `executeRuntimeContextWorkflow` with
    `RuntimeContextWorkflowNative`.
  - Keep `RuntimeHostAgentToolHostLive` only if rewritten to use target runtime
    services and clean-room composition.

- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`
  - Review any `RuntimeContextWorkflowRuntime` dependency.
  - Keep only target Shape-D or runtime-owned service dependencies.

## Quarantine Until Renamed

These target-shaped seams currently have workflow-era names or paths. They may
stay for Wave 1, but should not be used as precedent for new workflow-body
imports.

- `RuntimeContextWorkflowSession`
  - Keep as the session-command sink used by Shape C:
    `send(context, activityAttempt, command)`.
  - Consider moving/renaming to a narrower command-sink path after the clean
    room entry lands.

- `packages/runtime/src/workflow-engine/workflows/runtime-context-run.ts`
  - Mixed file. Keep run-record helpers that the new driver needs.
  - Remove workflow payload / workflow identity helpers once unused.

- `RuntimeContextWorkflowRuntime`
  - Mixed wrapper. If any Shape-D tool path still requires its `run` wrapper,
    quarantine it. Prefer inlining runtime-owned engine execution in Lane B so
    the wrapper can be removed.

## Package Export Shape

No package subpath must disappear in Wave 2. The deletion is mostly barrel
content:

- `@firegrid/runtime`
- `@firegrid/runtime/kernel`
- `@firegrid/runtime/workflow-engine`
- `@firegrid/runtime/workflows`
- `@firegrid/host-sdk`
- `@firegrid/host-sdk/host`

These subpaths may remain, but their exported symbol sets must stop exposing
the old RuntimeContext body driver.

## Guard Candidates

After clean-room composition lands, guard against new imports of these symbols
from that directory:

- `RuntimeContextWorkflowNative`
- `RuntimeContextWorkflowNativeLayer`
- `executeRuntimeContextWorkflow`
- `RuntimeContextWorkflowRuntime`
- `appendRuntimeInputDeferred`
- `runtimeInputDeferredFor`
- `runtimeInputDeferredName`
- `@effect/workflow`
- ambient raw `AgentSession`

The guard should not affect runtime-owned Shape D workflow implementations.
