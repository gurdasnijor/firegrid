import { Context, type Effect, Layer } from "effect"
import type {
  AgentInputEvent,
  AgentOutputEvent,
} from "../../events/index.ts"

interface RuntimeToolUseExecutorContext {
  readonly contextId: string
}

type RuntimeToolUseEvent = Extract<AgentOutputEvent, { _tag: "ToolUse" }>
type RuntimeToolResultEvent = Extract<AgentInputEvent, { _tag: "ToolResult" }>

// Service interface deliberately exposes only the executor tag in its R
// channel. Implementations may internally use workflow machinery (today's
// `RuntimeToolUseExecutorLive` is one example, capturing AgentToolHost +
// RuntimeChannelRouter + RuntimeAgentToolExecution + RuntimeObservationStreams
// at layer construction), but they must provide those deps inside `execute` so
// the caller's R stays clean. This is what lets Shape C callers
// (`handleRuntimeContextEvent`) name only `RuntimeToolUseExecutor` in R
// without dragging `WorkflowEngine | WorkflowInstance` through every call
// site — see `docs/cannon/architecture/runtime-pipeline-type-boundaries.md`
// §"Shape C: Stateful Keyed Subscriber, No Workflow Machinery".
interface RuntimeToolUseExecutorService {
  readonly execute: (
    context: RuntimeToolUseExecutorContext,
    event: RuntimeToolUseEvent,
  ) => Effect.Effect<RuntimeToolResultEvent, never>
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
