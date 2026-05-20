import { describe, expect, it } from "vitest"
import {
  analyzePhase1WorkflowCoreGate,
  workflowCorePathsSimulationId,
} from "../src/runner/phase1-gate.ts"
import type { SpanRecord } from "../src/runner/trace.ts"

const span = (
  name: string,
  attributes: Record<string, unknown> = {},
): SpanRecord => ({
  name,
  traceId: "trace",
  spanId: `${name}-${Math.random()}`,
  kind: 0,
  startTime: [0, 0],
  endTime: [0, 1],
  duration: [0, 1],
  status: { code: 1 },
  attributes,
  resource: { "firegrid.simulation.id": workflowCorePathsSimulationId },
})

const agentWaitForAttrs = {
  "firegrid.workflow.name": "firegrid.agent_tools.wait_for",
}

const passingTrace = (): ReadonlyArray<SpanRecord> => [
  span("firegrid.simulation.run", {
    "firegrid.simulation.id": workflowCorePathsSimulationId,
    "firegrid.simulation.outcome": "DriverCompleted",
  }),
  span("firegrid.workflow_core_paths.driver", {
    "firegrid.workflow_core_paths.saw_wait_for_call": true,
    "firegrid.workflow_core_paths.saw_result_marker": true,
  }),
  span("firegrid.runtime_context.workflow.native.run"),
  span("firegrid.runtime_control_plane.run.upsert_event"),
  span("firegrid.workflow_engine.execution.execute", agentWaitForAttrs),
  span("firegrid.workflow_engine.activity.execute", agentWaitForAttrs),
  span("firegrid.workflow_engine.deferred.done", {
    ...agentWaitForAttrs,
    "firegrid.workflow.deferred.name": "raceAll/wait-for-workflow.race/tool-1",
  }),
  span("firegrid.workflow_engine.clock.schedule", agentWaitForAttrs),
]

describe("Phase 1 workflow-core-paths gate", () => {
  it("firegrid-workflow-driven-runtime.VALIDATION.10 accepts the collapsed substrate trace shape", () => {
    const report = analyzePhase1WorkflowCoreGate(passingTrace())
    expect(report.failures).toEqual([])
  })

  it("firegrid-workflow-driven-runtime.VALIDATION.10 rejects legacy durable-tools wait-router spans", () => {
    const report = analyzePhase1WorkflowCoreGate([
      ...passingTrace(),
      span("firegrid.durable_tools.wait_router.complete_match"),
    ])
    expect(report.failures.map(failure => failure.id)).toContain(
      "legacy:firegrid.durable_tools.wait_router.complete_match",
    )
  })

  it("firegrid-workflow-driven-runtime.VALIDATION.10 rejects traces missing WaitForWorkflow execution", () => {
    const report = analyzePhase1WorkflowCoreGate(
      passingTrace().filter(span =>
        span.name !== "firegrid.workflow_engine.execution.execute"),
    )
    expect(report.failures.map(failure => failure.id)).toContain(
      "wait-for-workflow-execution",
    )
  })
})
