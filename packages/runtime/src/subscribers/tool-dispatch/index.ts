// subscribers/tool-dispatch/ public surface.
//
// SHAPE: D — Activity memoization (see ./README.md).
//
// Public subpath: `@firegrid/runtime/subscribers/tool-dispatch`. Re-exports the
// Shape D tool-dispatch Layer (`RuntimeToolCallWorkflowLayer`) together with
// the executor capability tag and the scheduled-prompt layer; matches the
// barrel that previously lived under `agent-event-pipeline/tool-execution/`.
//
// Source physically moved from
// `packages/runtime/src/agent-event-pipeline/tool-execution/`
// (`docs/architecture/2026-05-22-runtime-physical-target-tree.md`
// §subscribers/tool-dispatch/).

export {
  RuntimeToolUseExecutor,
} from "../../workflow-engine/tool-execution/runtime-tool-use-executor.ts"
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
} from "./runtime-tool-call-workflow.ts"
export {
  ScheduledPromptWorkflowLayer,
} from "../../workflow-engine/workflows/scheduled-prompt.ts"
