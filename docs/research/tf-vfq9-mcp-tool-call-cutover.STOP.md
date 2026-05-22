# STOP — tf-vfq9: MCP tool-call cutover blocked; owning-workflow tool input/result seam is absent

**Verdict:** the cutover (route MCP tool calls into the owning `RuntimeContextWorkflow`, delete `ToolCallWorkflow`) **cannot be implemented now without papering over it with another operation-shaped workflow.** The required *owning-workflow tool input/result seam is not present.* Per the dispatch's STOP rule, halting with file:line evidence for architecture review. No code changed.

## What the cutover needs vs. what exists

To run MCP tool calls inside the owning workflow (one execution per `contextId`, satisfying `WORKFLOW_ADMISSION.1`/`PHASE_6_AGENT_TOOLS.14-1`), the workflow must accept a **host-executable tool-call request** and return its **result correlated to the caller** (the MCP handler, by `toolUseId`), while preserving toolUseId at-most-once, durable suspension (sleep/schedule_me/wait_for), and wait_for replay memoization. None of that seam exists.

## Missing boundary — file:line evidence

1. **ACP tool calls are observation-only in the owning workflow — it does not execute them.**
   `packages/runtime/src/workflow-engine/workflows/runtime-context.ts:531-532` — in `handleToolUseOutput`, `if (context.runtime.config.agentProtocol === "acp") { return }`. MCP tool calls come from ACP agents (claude-acp etc.), so they are *skipped* by the only in-workflow tool-execution path. TFIND-041 (lines 519-526) makes this an intentional authority decision, not an oversight.

2. **The discriminant the cutover requires is explicitly deferred, not the current contract.**
   `runtime-context.ts:525-530` — "Promoting an event-level discriminant (option A: `ToolUseRequest` vs `ToolUseObservation`) is a tracked, **deliberately-deferred future option, not the current contract**." That `ToolUseRequest` (host-executes + returns result) is exactly the input event the cutover needs. Grep confirms it exists only in this comment: no `ToolUseRequest`/`ToolUseObservation` type anywhere.

3. **No caller-correlated tool-result return.**
   `runtime-context.ts:534-544` — even the stdio-jsonl path sends the result back to the **agent** (`sendSessionActivity({ _tag: "AgentInput", event: result, ... })`), not to a synchronous external caller keyed by `toolUseId`. `RuntimeContextSessionCommand` (`runtime-context.ts:85-88`) carries only `{ _tag: "AgentInput", event }` — there is no tool-call-request command and no result-return surface.

4. **The MCP path uses `ToolCallWorkflow` precisely because of this gap.**
   `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:76-108` — `handleTool` runs `ToolCallWorkflow.execute({ contextId, toolUseId, toolName, input })` on the runtime-context engine and blocks on `result.part.result`. It is the synchronous request/result surface the owning workflow lacks.

5. **The spec already states the precondition.**
   `docs/investigations/2026-05-21-phase0c-migration-map.md:79` — `ToolCallWorkflow` is operation-shaped migration debt (`WORKFLOW_ADMISSION.1/.3`, `PHASE_6_AGENT_TOOLS.14-1`), and: "Replacement: lower validated tool invocations into the owning runtime-context workflow's **channel/table seam. Delete after that seam exists.**" The seam does not exist.

## Why not implement anyway

Any in-scope implementation here would be one of:
- a new `ToolCallWorkflow`-equivalent operation-shaped workflow — **forbidden** by the dispatch ("do not paper over with another operation-shaped workflow") and by `WORKFLOW_ADMISSION.1/.3`;
- a `forkDaemon`/ad-hoc fiber to bridge request→result — **replay-unsafe** (re-fires on replay; same class as tf-7kq8/tf-e49h), and breaks toolUseId at-most-once + durable suspension.

The correct unblock is to **build the seam first**: the deferred TFIND-041 option A (`ToolUseRequest` vs `ToolUseObservation`) plus a caller-correlated tool-result return through the runtime-context workflow's channel/table seam (the same input/output-cursor seam the Phase-0C work is landing). That is a deliberate architecture surface, not a narrow cutover, and it is the documented precondition for deleting `ToolCallWorkflow`.

## Recommendation

Sequence: (1) land the owning-workflow tool input/result seam (`ToolUseRequest` + caller-correlated result, replay-safe, toolUseId at-most-once, durable suspension preserved) as its own bead; (2) then this cutover + `ToolCallWorkflow` deletion becomes a mechanical follow-up. tf-vfq9 should block on (1).
