// subscribers/tool-dispatch/ public surface.
//
// SHAPE: D — Activity memoization (see ./README.md).
//
// Public subpath: `@firegrid/runtime/subscribers/tool-dispatch`. Re-exports the
// Shape D tool-dispatch Workflow + Layer + executor capability tag.
//
// Source physically moved into this folder (post-#727 / tf-up1v cleanup wave):
//   - `ToolCallWorkflow` + `RuntimeToolCallWorkflowLayer` from
//     `packages/runtime/src/workflow-engine/workflows/tool-call.ts` +
//     `packages/runtime/src/subscribers/tool-dispatch/runtime-tool-call-workflow.ts`
//     (folded into `./workflow.ts`).
//   - `RuntimeToolUseExecutor` from
//     `packages/runtime/src/workflow-engine/tool-execution/runtime-tool-use-executor.ts`.

export {
  RuntimeToolUseExecutor,
} from "./runtime-tool-use-executor.ts"
export {
  evaluateFieldEquals,
  type FieldEqualsTrigger,
  makeRuntimeAgentToolExecutionService,
  RuntimeAgentToolExecution,
  RuntimeAgentToolExecutionLive,
  type RuntimeAgentToolExecutionError,
  type RuntimeAgentToolExecutionService,
  type RuntimeCallToolExecutionParams,
  type RuntimeScheduleToolExecutionParams,
  type RuntimeSendToolExecutionParams,
  type RuntimeToolExecutionContext,
  type RuntimeWaitForAnyDescriptorExecution,
  type RuntimeWaitForAnyToolExecutionParams,
  type RuntimeWaitForToolExecutionParams,
} from "./runtime-agent-tool-execution.ts"
export {
  RuntimeToolCallWorkflowLayer,
  ToolCallWorkflow,
  ToolCallWorkflowPayloadSchema,
  type ToolCallWorkflowPayload,
} from "./workflow.ts"
export {
  ScheduledPromptWorkflowLayer,
} from "../../workflow-engine/workflows/scheduled-prompt.ts"

// Wave D-B: runtime-owned tool-dispatch facade (Shape D — Activity
// memoization). Host-sdk consumes the `ToolDispatch` Tag and
// `ToolDispatchLive` host-install Layer; the underlying `@effect/workflow`
// machinery (`WorkflowEngine`, `ToolCallWorkflow.execute(...)`) stays
// inside this folder, justified by the folder's Shape D rationale.
export {
  ToolDispatch,
  ToolDispatchLive,
  type ToolDispatchFailure,
  type ToolDispatchInput,
  type ToolDispatchService,
} from "./dispatch.ts"
