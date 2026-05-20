import { DurableClock, type WorkflowEngine } from "@effect/workflow"
import type {
  SleepToolInput,
  SleepToolOutput,
} from "@firegrid/protocol/agent-tools"
import { Context, Duration, Effect, Layer } from "effect"
import type { Scope } from "effect"
import type {
  AgentInputEvent,
  AgentOutputEvent,
} from "../events/index.ts"

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
    WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance | Scope.Scope
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

export interface RuntimeToolExecutionContext {
  readonly contextId: string
  readonly toolUseId: string
}

export type RuntimeAgentToolExecutionError =
  | {
    readonly _tag: "InvalidToolInput"
    readonly reason: string
    readonly cause?: unknown
  }
  | {
    readonly _tag: "ToolExecutionFailed"
    readonly cause: unknown
  }
  | {
    readonly _tag: "UnsupportedTool"
    readonly reason: string
  }

export interface RuntimeAgentToolExecutionService {
  readonly sleep: (
    params: RuntimeToolExecutionContext & {
      readonly input: SleepToolInput
    },
  ) => Effect.Effect<
    SleepToolOutput,
    RuntimeAgentToolExecutionError,
    WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
  >
}

// firegrid-host-sdk.PACKAGE_GRAPH.6
// firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.9
export const makeRuntimeAgentToolExecutionService = (): RuntimeAgentToolExecutionService => ({
  sleep: ({ toolUseId, input }) =>
    DurableClock.sleep({
      name: `tool:${toolUseId}`,
      duration: Duration.millis(input.durationMs),
      inMemoryThreshold: Duration.zero,
    }).pipe(Effect.as<SleepToolOutput>({ slept: true })),
})

export class RuntimeAgentToolExecution extends Context.Tag(
  "@firegrid/runtime/RuntimeAgentToolExecution",
)<RuntimeAgentToolExecution, RuntimeAgentToolExecutionService>() {
  static layer = (
    service: RuntimeAgentToolExecutionService,
  ): Layer.Layer<RuntimeAgentToolExecution> => Layer.succeed(this, service)
}
