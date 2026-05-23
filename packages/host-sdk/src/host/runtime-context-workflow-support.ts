import { Layer } from "effect"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../agent-tools/execution/tool-host.ts"
import {
  RuntimeContextInputFactsLive,
} from "@firegrid/runtime/runtime-context-input-facts"
import {
  makeRuntimeContextExitSignal,
  RuntimeContextSubscriberLive,
  runtimeContextAwaitExit,
  type RuntimeContextExitSignal,
} from "@firegrid/runtime/runtime-context-subscriber"

export {
  makeRuntimeContextExitSignal,
  runtimeContextAwaitExit,
  type RuntimeContextExitSignal,
}
import {
  HostRuntimeObservationSubstrateLive,
  HostRuntimeObservationStreamsLive,
  type HostRuntimeContextExecutionEnv,
} from "./runtime-substrate.ts"
import {
  RuntimeAgentToolExecutionLive,
  RuntimeToolCallWorkflowLayer,
  ScheduledPromptWorkflowLayer,
} from "@firegrid/runtime/tool-executor"
import {
  RuntimeToolUseExecutorLive,
} from "../agent-tools/execution/runtime-tool-use-executor-live.ts"
import type { RuntimeChannelRouter } from "./channel.ts"

export type { HostRuntimeContextExecutionEnv }

const runtimeToolUseExecutorLayer = RuntimeToolUseExecutorLive.pipe(
  Layer.provide(HostRuntimeObservationSubstrateLive),
  Layer.provideMerge(HostRuntimeObservationStreamsLive),
  Layer.provideMerge(RuntimeAgentToolExecutionLive),
)

// Shape C cutover (Wave 1 host-composition slice): the per-context support
// layer no longer registers a `RuntimeContextWorkflowNative` workflow body. It
// composes the target-shape Shape C subscriber (`RuntimeContextSubscriberLive`)
// fed by the typed sources Wave 1 owns:
//
//   - input  : `RuntimeContextInputFacts.forContext(contextId)` (#682)
//   - output : `RuntimeAgentOutputAfterEvents.forContext(contextId)` filtered
//              by `isStateRelevantOutputObservation` (#681)
//
// The subscriber forks into the layer scope and is interrupted on
// `RuntimeContextWorkflowRuntime.run` exit (context deregister / host
// shutdown). Tool execution remains live via `RuntimeToolUseExecutor` provided
// here (the executor's own observation substrate is discharged by the same
// provideMerge memoised reference).
//
// No `RuntimeContextWorkflowNativeLayer`. No `DurableDeferred` mailbox. No
// entity-lifetime parked body. The R channel below no longer mentions
// `WorkflowEngine.WorkflowEngine` / `WorkflowEngineTable` for this layer —
// those tags stay in `RuntimeContextWorkflowRuntime`'s engine provisioning for
// the surviving Shape D subscribers (tool-call, scheduled-prompt, wait-for).
export const runtimeContextWorkflowSupportLayer = (
  context: RuntimeContext,
  agentToolHost: AgentToolHostService,
  exitSignal: RuntimeContextExitSignal,
): Layer.Layer<
  never,
  unknown,
  HostRuntimeContextExecutionEnv | RuntimeChannelRouter
> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- DurableTable.layer still leaks any through substrate layers; the declared Layer R channel is the intended capability boundary.
  RuntimeContextSubscriberLive(context, exitSignal).pipe(
    Layer.provideMerge(HostRuntimeObservationSubstrateLive),
    Layer.provideMerge(HostRuntimeObservationStreamsLive),
    Layer.provideMerge(RuntimeContextInputFactsLive),
    Layer.provideMerge(runtimeToolUseExecutorLayer),
    Layer.provideMerge(Layer.succeed(AgentToolHost, agentToolHost)),
    Layer.withSpan("firegrid.host.runtime_context.workflow_support.layer", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.runtime.shape": "C",
      },
    }),
  )

export const toolCallWorkflowSupportLayer = (
  agentToolHost: AgentToolHostService,
) =>
  // tf-5ose: register the durable ScheduledPromptWorkflow alongside the tool-call
  // workflow on the host-engine scope. schedule_me starts it `discard:true`, so it
  // outlives the tool call and the engine must own its handler to resume it after
  // the DurableClock delay fires.
  Layer.merge(RuntimeToolCallWorkflowLayer, ScheduledPromptWorkflowLayer).pipe(
    Layer.provideMerge(HostRuntimeObservationSubstrateLive),
    Layer.provideMerge(HostRuntimeObservationStreamsLive),
    Layer.provideMerge(runtimeToolUseExecutorLayer),
    Layer.provideMerge(Layer.succeed(AgentToolHost, agentToolHost)),
  )
