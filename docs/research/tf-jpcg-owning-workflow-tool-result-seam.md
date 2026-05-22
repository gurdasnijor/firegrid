# tf-jpcg — owning-workflow tool input/result seam: design + architecture boundary

**Bead:** tf-jpcg (prerequisite for tf-vfq9 ToolCallWorkflow cutover). **Status:** design + boundary report; no production patch yet — the narrow seam is implementation-ready, but it forces a concurrency-semantics decision that changes the build. Per the dispatch's STOP rule, surfacing the exact boundary + minimal primitive before writing the replay-sensitive merged-loop change.

Source-verified on this branch (fresh off origin/main).

## What exists today (foundation)

- **Input delivery into the owning workflow exists** but is *agent-input-shaped*. `appendRuntimeInputDeferred` (`runtime-input-deferred.ts:94-171`) writes a sequenced `RuntimeIngressInputRow` into the durable deferred `runtime-context/<ctx>/input/<seq>` (`:139-148`); the owning workflow's merged loop awaits it via `awaitRuntimeInput` → `DurableDeferred.await` (`runtime-context.ts:207-220`). This is the Phase-0C input seam (tf-b1jm, closed #613).
- **The merged event union is `Input | Output` only** (`runtime-context.ts:347-349`). `RunToolUse` is a transition *action* derived from a ToolUse **output** observation (`:378-380`, produced at `:689`) — i.e. it fires only when the *agent emits* a ToolUse, never from a host-submitted request.
- **Tool execution already runs inside the owning workflow** for the codec path: `runToolUseActivity` (`runtime-context.ts:438-467`) calls the shared `RuntimeToolUseExecutor.execute`. The MCP path reaches the *same* executor through a per-call `ToolCallWorkflow` (`runtime-tool-call-workflow.ts:10-27`). The per-call workflow is the request/response wrapper, not intrinsic to execution (audit `2026-05-22-tool-call-workflow-audit.md:16`).

## What is missing (the seam tf-jpcg must build)

1. **A host-submitted tool-request channel.** No merged-event source for "host wants you to execute this tool." Only agent-output-derived `RunToolUse` and agent-input rows exist.
2. **A result-by-toolUseId return.** The codec path routes a `ToolResult` back to the *agent* (`sendSessionActivity`, `runtime-context.ts:534-544`); nothing returns a result to an external synchronous caller keyed by `toolUseId`. `RuntimeContextSessionCommand` carries only `AgentInput` (`:85-88`).

## The narrow seam (implementation-ready)

A non-operation-workflow, runtime-engine/table seam — no per-call `Workflow.make`:

- **Submit:** MCP `handleTool` writes a `ToolUseRequest { contextId, toolUseId, toolName, input }` into a durable deferred/row keyed by `toolUseId` (mirror of `appendRuntimeInputDeferred`, new family `runtime-context/<ctx>/tool/<toolUseId>`). Idempotent on `toolUseId` ⇒ **at-most-once** (replaces `ToolCallWorkflow.idempotencyKey = toolUseId`, `tool-call.ts:20`).
- **Execute:** add a third merged-event source `ToolRequest` to the loop; on dequeue, run `RuntimeToolUseExecutor.execute` **in the workflow body** (NOT `Activity.make` — `DurableClock.sleep`/`WaitForWorkflow.execute` only suspend durably from the body; an Activity journals as a unit). This preserves `sleep`/`schedule_me`/`wait_for` durable suspension.
- **Return + memoize:** write the `ToolResult` into a durable deferred `runtime-context/<ctx>/tool-result/<toolUseId>`. The MCP handler awaits *that* deferred (via the existing engine handle, `RuntimeContextWorkflowRuntime`, instead of `ToolCallWorkflow.execute`). A resolved result-deferred is the **replay memoization** (same shape as `completedRuntimeInput`, `runtime-context.ts:222-242`) ⇒ the tool never re-runs on owning-workflow replay (the tf-7kq8 class).

This satisfies WORKFLOW_ADMISSION.1/.3, keeps `RuntimeToolUseExecutor`, and lets `ToolCallWorkflow` be deleted by tf-vfq9.

## The architecture boundary (why I stopped before writing it)

**`@effect/workflow` durable suspension is per-execution and unwinds the whole execution.** `DurableDeferred.await` on an unresolved deferred calls `Workflow.suspend(instance)` (`repos/effect/packages/workflow/src/DurableDeferred.ts:119`); a child fiber's suspension propagates to the parent instance (`:167-168`). Resume = full-body replay. So a single execution can only make concurrent durable progress if its body *explicitly forks* the concurrent branches.

The owning `RuntimeContextWorkflowNative` body is a **sequential** `while` loop processing one merged event at a time (`runtime-context.ts:864-895`). Running a suspending tool in that body (required for durable suspension) **suspends the entire loop**. Consequences:

- **Today the MCP path is concurrent:** each `tools/call` spawns its own `ToolCallWorkflow` execution (`toolkit-layer.ts:76-98`), so parallel tool use (which ACP/Claude does) runs with independent durable suspension.
- **The narrow seam serializes it (single-flight per context):** a long `sleep`/`wait_for` blocks every other queued tool call *and* blocks agent-output observation. Worst case — an agent issuing `wait_for(X)` and the `send(X)` that satisfies it in one parallel batch — **deadlocks** under single-flight (loop parks in `wait_for`, the `send` never runs).
- The codec path *already* serializes tool execution through this loop, so single-flight is an accepted model for codec agents — but it is a **real regression for ACP parallel tool use.**

Preserving concurrency requires rewriting the sequential merged loop into a **concurrent durable supervisor** (fork each `ToolRequest` as a concurrent branch, join via per-`toolUseId` deferreds, fold in-flight tool executions into the durable loop state). That is feasible but is a deep, high-blast-radius change to the most replay-sensitive code in the system (tf-7kq8 / tf-aseo territory) — not a "narrow runtime-engine/table seam."

## The decision needed + minimal primitive

The fork that changes the build:

- **Option A — single-flight seam (narrow).** Build the seam above; tool calls per context serialize. Minimal primitive = the `ToolUseRequest` deferred-in + `ToolResult` deferred-out family. Ship behind acceptance that ACP parallel tool use serializes; file the concurrency gap as a blocking follow-up before tf-vfq9 deletes ToolCallWorkflow under load.
- **Option B — concurrent durable supervisor (correct, large).** Rewrite the merged loop to fork durable tool branches. Minimal primitive = a per-context "durable tool-slot" supervisor over per-`toolUseId` deferreds. Own SDD; high replay-risk.

**Recommendation:** Option A *if* single-flight-per-context is acceptable for the private-beta agent set (verify whether ACP agents actually issue concurrent suspending tool calls in practice); otherwise Option B as a scoped SDD. Either way, do **not** reintroduce a per-call workflow.

## Follow-ups
- `tf-jpcg` stays blocked on this A/B decision.
- New bead (if A): "ACP parallel-tool-use concurrency regression — durable tool-slot supervisor" (blocks tf-vfq9 deletion-under-load).
