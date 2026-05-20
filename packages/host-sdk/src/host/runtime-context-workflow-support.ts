import type { WorkflowEngine } from "@effect/workflow"
import { Layer } from "effect"
import type { WorkflowEngineTable } from "@firegrid/runtime/workflow-engine"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../agent-tools/execution/tool-host.ts"
import {
  RuntimeContextWorkflowNativeLayer,
} from "./runtime-context-workflow-core.ts"
import {
  HostRuntimeObservationSubstrateLive,
  HostRuntimeObservationStreamsLive,
  RuntimeAgentToolExecutionLive,
  type HostRuntimeContextExecutionEnv,
  RuntimeToolUseExecutorLive,
} from "./runtime-substrate.ts"
import type { ChannelInventory } from "./channel.ts"

// TFIND-031 (Option Y, layer-composition-order fix): BOTH the workflow
// body (`RuntimeContextWorkflowNativeLayer`) and the tool executor
// (`RuntimeToolUseExecutorLive`) capture execution-scoped substrate via
// `Effect.context<…>()`. The executor MUST stay `provideMerge`d into the
// workflow chain — the workflow handler resolves `RuntimeToolUseExecutor`
// from the context captured at layer-build time, so its output has to be
// fed into `RuntimeContextWorkflowNativeLayer`'s build context. A plain
// sibling `Layer.merge` silently breaks that wiring (the tool activity
// can no longer resolve the executor at workflow-execution time → e.g.
// `schedule_me` produces nothing).
//
// The executor's own observation-substrate RIn is discharged by providing
// `HostRuntimeObservationSubstrateLive` into `RuntimeToolUseExecutorLive`
// too. This is the SAME layer reference provided into the workflow body,
// so Effect Layer memoization builds it exactly once; recorder and waker
// cannot diverge. The public host contract is unchanged.
export const runtimeContextWorkflowSupportLayer = (
  contextId: string,
  agentToolHost: AgentToolHostService,
): Layer.Layer<
  never,
  unknown,
  | HostRuntimeContextExecutionEnv
  | ChannelInventory
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngineTable
> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- DurableTable.layer still leaks any through substrate layers; the declared Layer R channel is the intended capability boundary.
  RuntimeContextWorkflowNativeLayer.pipe(
    Layer.provideMerge(HostRuntimeObservationSubstrateLive),
    Layer.provideMerge(HostRuntimeObservationStreamsLive),
    Layer.provideMerge(
      RuntimeToolUseExecutorLive.pipe(
        Layer.provide(HostRuntimeObservationSubstrateLive),
        Layer.provideMerge(HostRuntimeObservationStreamsLive),
        Layer.provideMerge(RuntimeAgentToolExecutionLive),
      ),
    ),
    Layer.provideMerge(Layer.succeed(AgentToolHost, agentToolHost)),
    Layer.withSpan("firegrid.host.runtime_context.workflow_support.layer", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
  )
