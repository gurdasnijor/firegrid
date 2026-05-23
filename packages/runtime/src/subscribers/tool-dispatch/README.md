# subscribers/tool-dispatch/

SHAPE: D — Activity memoization

Workflow-shaped subscriber for tool-use side effects. The workflow body owns
exactly one load-bearing capability:

- **Activity memoization** — once a tool call commits a result, replay re-uses
  the memoized output rather than re-invoking the tool. This is the durable
  exactly-once boundary for non-idempotent side effects (HTTP calls,
  file-system writes, external API invocations).

No other workflow-machinery features are used here. No `DurableClock`, no
parked input mailbox, no cross-execution handoff.

Files (post tf-up1v cleanup):

- `workflow.ts` — `ToolCallWorkflow` definition + payload schema + `RuntimeToolCallWorkflowLayer` handler. Physically moved from `workflow-engine/workflows/tool-call.ts` + the previous `runtime-tool-call-workflow.ts` (folded together).
- `runtime-tool-use-executor.ts` — `RuntimeToolUseExecutor` capability tag + `RuntimeToolUseExecutor.layer(...)` helper. Physically moved from `workflow-engine/tool-execution/runtime-tool-use-executor.ts`.
- `runtime-agent-tool-execution.ts` — runtime-owned validated executor service.
- `dispatch.ts` — `ToolDispatch` Tag + `ToolDispatchLive` host-install Layer.
- `index.ts` — public barrel (`@firegrid/runtime/subscribers/tool-dispatch`).
