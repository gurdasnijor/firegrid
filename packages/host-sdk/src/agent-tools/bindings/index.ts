/**
 * `@firegrid/host-sdk/agent-tools/bindings`
 *
 * BINDING side of the agent-tool boundary
 * (`firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6`): protocol-schema → Effect AI
 * `Tool`/`Toolkit` values, the MCP-facing failure schema, the structured
 * tool-error schemas, and the bridge-scoped routing-context tag. No host
 * execution or lowering.
 */

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
  CallTool,
  ExecuteTool,
  FiregridAgentToolContext,
  FiregridAgentToolkit,
  FiregridMcpToolFailureSchema,
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
} from "./tools.ts"
