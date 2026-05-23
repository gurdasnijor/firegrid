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

// Host-mcp/acp relocation wave: agent-tool BINDINGS (Tool/Toolkit, error
// schemas, runtime-context routing tag) moved from
// `packages/host-sdk/src/agent-tools/bindings/`.
export {
  formatToolError,
  toolCancelled,
  toolErrorResult,
  toolExecutionFailed,
  toolInvalidInputFromParseError,
  toolResult,
  ToolCancelledError,
  ToolError,
  ToolExecutionFailedError,
  ToolInvalidInputError,
  unknownToolResult,
} from "./bindings/tool-error.ts"
export {
  CallTool,
  ExecuteTool,
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridMcpToolFailureSchema,
  FiregridPrimitiveProfileToolkit,
  ScheduleMeTool,
  SendTool,
  SessionCancelTool,
  SessionCloseTool,
  SessionNewTool,
  SessionPromptTool,
  SleepTool,
  SpawnAllTool,
  SpawnTool,
  WaitForAnyTool,
  WaitForTool,
  type FiregridMcpToolFailure,
} from "./bindings/tools.ts"

// Host-mcp/acp relocation wave: agent-tool EXECUTION moved from
// `packages/host-sdk/src/agent-tools/execution/`.
export {
  AgentToolHost,
  type AgentToolHostService,
  type AppendSessionPromptParams,
  type CallApprovalChannelParams,
  type ExecuteSandboxToolParams,
  type ExecuteSessionCapabilityParams,
  type SessionLifecycleParams,
  type SpawnAllParams,
  type SpawnAllResult,
  type SpawnChildContextParams,
  type SpawnChildContextResult,
} from "./tool-host.ts"
export {
  toolUseToEffect,
  type ToolLoweringContext,
} from "./tool-use-to-effect.ts"
export {
  FiregridAgentToolkitLayer,
  FiregridPrimitiveProfileToolkitLayer,
} from "./toolkit-layer.ts"
export {
  RuntimeToolUseExecutorLive,
} from "./runtime-tool-use-executor-live.ts"
