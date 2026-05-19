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

// LENS: host-sdk:rcws-rin-cycle — executor stays provideMerge'd; the RIN-shaped cycle is deliberate (see LENSES.md)
// TFIND-031 (Option Y, layer-composition-order fix): BOTH the workflow
// body (`RuntimeContextWorkflowNativeLayer`) and the tool executor
// (`RuntimeToolUseExecutorLive`) capture the durable-wait family via
// `Effect.context<…>()`. The executor MUST stay `provideMerge`d into the
// workflow chain — the workflow handler resolves `RuntimeToolUseExecutor`
// from the context captured at layer-build time, so its output has to be
// fed into `RuntimeContextWorkflowNativeLayer`'s build context. A plain
// sibling `Layer.merge` silently breaks that wiring (the tool activity
// can no longer resolve the executor at workflow-execution time → e.g.
// `schedule_me` produces nothing).
//
// The only defect was that the executor's OWN `DurableWait*` RIn was
// never discharged — it flowed out as an unsatisfiable support-layer RIn
// (the layer required what it provided). Fix: provide the durable-wait
// substrate INTO `RuntimeToolUseExecutorLive` too. This is the SAME
// `HostRuntimeObservationSubstrateLive` reference provided into the
// workflow body, so Effect Layer memoization builds it exactly once ⇒ the
// workflow body, its wait-router, and the tool executor all resolve the
// SAME materialized `DurableToolsTable` / wait store (SDD shared-store
// invariant — recorder and waker cannot diverge). `DurableWait*` now
// LEAVES RIn (discharged here, execution-scoped) while STAYING in ROut;
// the public host contract is unchanged.
export const runtimeContextWorkflowSupportLayer = (
  handle: ActiveRuntimeContextEngine,
  agentToolHost: AgentToolHostService,
) =>
  RuntimeContextWorkflowNativeLayer.pipe(
    Layer.provideMerge(HostRuntimeObservationSubstrateLive),
    Layer.provideMerge(
      RuntimeToolUseExecutorLive.pipe(
        Layer.provide(HostRuntimeObservationSubstrateLive),
      ),
    ),
    Layer.provideMerge(Layer.succeed(WorkflowEngine.WorkflowEngine, handle.engine)),
    Layer.provideMerge(Layer.succeed(WorkflowEngineTable, handle.table)),
    Layer.provideMerge(Layer.succeed(AgentToolHost, agentToolHost)),
  )
