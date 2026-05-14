/**
 * `@firegrid/runtime/agent-tools`
 *
 * Canonical Firegrid agent tools as Effect AI `Tool` values collected
 * with `Toolkit.make(...)` (`FiregridAgentToolkit`), plus the host-side
 * lowering of `ToolUse` events to `ToolResult` events in
 * `toolUseToEffect`.
 *
 * The toolkit is the public exposure manifest:
 *   `McpServer.registerToolkit(FiregridAgentToolkit)` projects it to
 *   MCP; downstream codecs read `Tool.name`, `Tool.description`,
 *   `Tool.parametersSchema`, and `Tool.successSchema` directly.
 *
 * Schemas live in `@firegrid/protocol/agent-tools` and are imported
 * once. There is no separate Firegrid descriptor registry.
 */

export {
  ExecuteTool,
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridAgentToolkitLayer,
  FiregridMcpToolFailureSchema,
  ScheduleMeTool,
  SleepTool,
  SpawnAllTool,
  SpawnTool,
  ToolCallWorkflow,
  ToolCallWorkflowLayer,
  WaitForTool,
  type FiregridMcpToolFailure,
} from "./tools.ts"
export {
  agentToolsStreamUrlFromTopology,
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridMcpServerListenerConfig,
  type FiregridMcpServerLayerOptions,
  type FiregridMcpServerListenerConfig as FiregridMcpServerListenerConfigType,
} from "./mcp-host.ts"
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
