import { type WorkflowEngine } from "@effect/workflow"
import { Context, type Effect, Layer } from "effect"
import type {
  AgentInputEvent,
  AgentOutputEvent,
} from "../../agent-event-pipeline/events/index.ts"

interface RuntimeToolUseExecutorContext {
  readonly contextId: string
}

type RuntimeToolUseEvent = Extract<AgentOutputEvent, { _tag: "ToolUse" }>
type RuntimeToolResultEvent = Extract<AgentInputEvent, { _tag: "ToolResult" }>

interface RuntimeToolUseExecutorService {
  readonly execute: (
    context: RuntimeToolUseExecutorContext,
    event: RuntimeToolUseEvent,
  ) => Effect.Effect<
    RuntimeToolResultEvent,
    never,
    WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
  >
}

// firegrid-host-sdk.TOOL_EXECUTOR_SEAM.1
// firegrid-host-sdk.TOOL_EXECUTOR_SEAM.3
// firegrid-host-sdk.PACKAGE_GRAPH.6
export class RuntimeToolUseExecutor extends Context.Tag(
  "@firegrid/runtime/RuntimeToolUseExecutor",
)<RuntimeToolUseExecutor, RuntimeToolUseExecutorService>() {
  static layer = (
    service: RuntimeToolUseExecutorService,
  ): Layer.Layer<RuntimeToolUseExecutor> => Layer.succeed(this, service)
}
