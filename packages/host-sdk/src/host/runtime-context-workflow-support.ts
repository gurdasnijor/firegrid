import { WorkflowEngine } from "@effect/workflow"
import { Layer } from "effect"
import { WorkflowEngineTable } from "@firegrid/runtime/workflow-engine"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../agent-tools/execution/tool-host.ts"
import {
  RuntimeContextWorkflowNativeLayer,
} from "./runtime-context-workflow-core.ts"
import {
  HostRuntimeObservationSubstrateLive,
  RuntimeToolUseExecutorLive,
} from "./runtime-substrate.ts"
import type { ActiveRuntimeContextEngine } from "./runtime-context-engine-registry.ts"

export const runtimeContextWorkflowSupportLayer = (
  handle: ActiveRuntimeContextEngine,
  agentToolHost: AgentToolHostService,
) =>
  RuntimeContextWorkflowNativeLayer.pipe(
    Layer.provideMerge(HostRuntimeObservationSubstrateLive),
    Layer.provideMerge(RuntimeToolUseExecutorLive),
    Layer.provideMerge(Layer.succeed(WorkflowEngine.WorkflowEngine, handle.engine)),
    Layer.provideMerge(Layer.succeed(WorkflowEngineTable, handle.table)),
    Layer.provideMerge(Layer.succeed(AgentToolHost, agentToolHost)),
  )
