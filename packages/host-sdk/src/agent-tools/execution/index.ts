/**
 * `@firegrid/host-sdk/agent-tools/execution`
 *
 * EXECUTION side of the agent-tool boundary
 * (`firegrid-host-sdk.AGENT_TOOL_BOUNDARY.6`): host-side `ToolUse` →
 * `ToolResult` lowering (`toolUseToEffect`), the `AgentToolHost` host
 * capability seam, and the toolkit handler Layer that wires registered tools
 * through the lowering.
 */

export {
  AgentToolHost,
  type AgentToolHostService,
  type AppendScheduledPromptParams,
  type AppendSessionPromptParams,
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
  ToolCallWorkflow,
  ToolCallWorkflowLayer,
} from "./toolkit-layer.ts"
