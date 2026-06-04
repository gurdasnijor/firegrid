# tf-i724 Rec-2 RuntimeToolUseExecutor Contract Finding

Date: 2026-05-20

Simulation:

- `packages/firelab/src/simulations/runtime-tool-use-executor-contract/`
- Run: `pnpm --filter firelab simulate:run runtime-tool-use-executor-contract --timeout-ms 60000`
- Trace: `packages/firelab/.simulate/runs/2026-05-20T08-37-14-862Z__runtime-tool-use-executor-contract/trace.jsonl`
- Summary: `pnpm --filter firelab simulate:show 2026-05-20T08-37-14-862Z__runtime-tool-use-executor-contract`

## Contract Surface

`RuntimeToolUseExecutor` only declares `execute(context, event): Effect<ToolResult, never, WorkflowEngine | WorkflowInstance | Scope>`; it does not define timeout owner, workflow-scope cancellation semantics, stale `ToolResult` admissibility, or `toolUseId` idempotency. See `packages/runtime/src/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts:16`.

The current production workflow wraps each executable `ToolUse` as `Activity.make({ name: firegrid.runtime-context.tool.${event.part.id}, ... })` and sends the returned `ToolResult` back through the session command stream. See `packages/host-sdk/src/host/runtime-context-workflow-core.ts:278` and `packages/host-sdk/src/host/runtime-context-workflow-core.ts:422`.

The live host layer captures host tool substrate, then re-provides the current workflow engine, workflow instance, and scope into `toolUseToEffect`. See `packages/host-sdk/src/host/runtime-substrate.ts:88`.

The workflow engine caches activity results by `(executionId, activity.name, attempt)`, where `activity.name` currently embeds `toolUseId`. See `packages/runtime/src/workflow-engine/internal/engine-runtime.ts:316`.

## Verdicts

### Timeout: `SEAM-GAP-timeout`

Observed behavior:

- Workflow-side timeout returned no `ToolResult`: `firegrid.tf_i724.timeout.workflow_side_returned=false`.
- The executor observed workflow interruption: `workflow_side_interrupted=true`.
- Codec-side timeout returned a timeout-shaped `ToolResult`: `codec_side_result_timed_out=true`.
- Codec-side timeout also interrupted the simulated subprocess: `codec_side_interrupted_subprocess=true`.

Gap: both timeout shapes are possible at the seam, but the contract does not define which layer owns timeout, whether timeout must always become a `ToolResult`, or whether workflow cancellation is allowed to erase the result entirely.

### Workflow Scope Cancel: `SEAM-GAP-cancel`

Observed behavior:

- The executor started once and observed interruption: `firegrid.tf_i724.cancel.starts=1`, `executor_observed_interrupt=true`.
- A stale callback fired after cancellation: `stale_callback_after_cancel=true`.
- No cancelled-tool activity result row was persisted; the final probe saw only four activity rows, all from non-cancelled completed branches.

Gap: current substrate interrupts the in-flight executor fiber, but the seam does not state whether an external subprocess must receive cancel, or whether late `ToolResult` delivery must be rejected at the workflow/session boundary.

### Duplicate `toolUseId`: `SEAM-GAP-dedup`

Observed behavior:

- Same workflow activity attempt deduplicated: `same_attempt_starts=1`, and both results had `callNo=4`.
- Retry activity attempt replayed as a new invocation: `retry_attempt_starts=2`, with `callNo=5` then `callNo=6`.
- Trace summary shows the second same-attempt activity returned from cache in ~0.4ms, while attempt 2 claimed and executed a fresh activity.

Gap: `toolUseId` is not structurally idempotent across all activity attempts. The current idempotency boundary is actually `(workflow execution id, activity name, attempt)`, while Phase 1 Lane 2 is planning execution identity shaped like `wait:contextId:toolUseId`. That mismatch needs an explicit decision before WaitForWorkflow semantics harden around it.

## Phase 1 Lane 2 Preserve/Decide

Lane 2 should explicitly choose and document:

1. Whether timeout is workflow-owned, codec/tool-owned, or both with different result semantics.
2. Whether workflow-scope close must propagate cancellation to subprocesses and reject late results.
3. Whether `toolUseId` is an idempotency key across retries, or only within a single workflow activity attempt.

Until those are explicit, all three branches remain contract gaps rather than green contract behavior.
