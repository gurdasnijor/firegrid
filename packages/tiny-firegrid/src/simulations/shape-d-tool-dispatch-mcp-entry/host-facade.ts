// Host-sdk MCP-entry tool-call facade — replaces the legacy
// `workflowRuntime.run({ workflowName, supportLayer, effect })` bridge.
//
// Production today (the bridge being deleted in Wave D Option A — see
// FINDING.md):
//
//   packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:76-102
//     const execute = ToolCallWorkflow.execute({ contextId, toolUseId, ... })
//     return yield* workflowRuntime.run({
//       context: runtimeContext,
//       workflowName: ToolCallWorkflow.name,
//       supportLayer: toolCallWorkflowSupportLayer(agentToolHost),
//       effect: execute.pipe(provideRuntimeContext(runtimeContext)),
//     })
//
// Wave D Option A target (this sim's facade):
//
//   const executeMcpEntryTool = (payload) =>
//     Effect.gen(function*() {
//       const engine = yield* WorkflowEngine
//       return yield* engine.execute(ToolCallWorkflow, payload)
//     })
//
// The `R` channel becomes `WorkflowEngine` only — no
// `RuntimeContextWorkflowRuntime`, no `AgentToolHost`, no
// `toolCallWorkflowSupportLayer`, no `provideRuntimeContext`. The
// host-sdk facade composes the registered Shape D Layer (the runtime
// root from `composition/host-live.ts`) and invokes
// `ToolCallWorkflow.execute(...)` directly.
//
// Negative shape asserted in `probe.test.ts`:
//   ✗ no import of `RuntimeContextWorkflowRuntime` / workflowRuntime.run /
//      supportLayer / toolCallWorkflowSupportLayer;
//   ✗ no import of any `RuntimeToolResultTable` /
//      `runtimeToolResultAtMostOnce` / new tables/* primitive;
//   ✗ no #684 wait-routing / runtime-streams / RuntimeObservationStreams
//      imports.

import { Effect } from "effect"
import {
  type ToolCallPayload,
  ToolCallWorkflow,
  type ToolResult,
  WorkflowEngine,
} from "./resources.ts"

/**
 * MCP-entry tool execution. The host-sdk facade calls this when an MCP
 * client invokes a registered tool. The facade's `R` is
 * `WorkflowEngine` only.
 */
export const executeMcpEntryTool = (
  payload: ToolCallPayload,
): Effect.Effect<ToolResult, unknown, WorkflowEngine> =>
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine
    return yield* engine.execute(ToolCallWorkflow, payload)
  })
