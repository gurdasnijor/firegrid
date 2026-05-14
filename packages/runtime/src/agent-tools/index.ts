/**
 * `@firegrid/runtime/agent-tools`
 *
 * Canonical Firegrid agent-tool descriptor manifest plus host-side
 * lowering of `ToolUse` events to `ToolResult` events. The descriptor
 * set is the *public contract* codecs publish; the match expression in
 * `tool-use-to-effect.ts` is the host implementation.
 */

export {
  FiregridAgentTools,
  firegridAgentToolCatalog,
  firegridAgentToolNames,
  type FiregridAgentToolName,
} from "./descriptors.ts"
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
} from "./tool-error.ts"
export {
  ScheduledInputWorkflow,
  ScheduledInputWorkflowLayer,
  ScheduledInputWorkflowPayload,
} from "./scheduled-input-workflow.ts"
export {
  AgentToolHost,
  type AgentToolHostService,
  type AppendScheduledPromptParams,
  type ExecuteSandboxToolParams,
  type SpawnAllParams,
  type SpawnAllResult,
  type SpawnChildContextParams,
  type SpawnChildContextResult,
} from "./tool-host.ts"
export {
  toolUseToEffect,
  type ToolLoweringContext,
} from "./tool-use-to-effect.ts"
