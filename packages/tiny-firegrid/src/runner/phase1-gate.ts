import { Console, Effect } from "effect"
import path from "node:path"
import {
  readTraceSpans,
  resolveRunDir,
  tracePathForRunDir,
  type SpanRecord,
} from "./trace.ts"

export const workflowCorePathsSimulationId = "workflow-core-paths"

const legacySpanNames = [
  "firegrid.durable_tools.wait_for.match",
  "firegrid.runtime_context.workflow.output.wait",
  "firegrid.durable_tools.wait_router.complete_match",
] as const

const runtimeBodySpanNames = [
  "firegrid.runtime_context.workflow.native.run",
  "firegrid.runtime_context.workflow.merged.body",
  "firegrid.runtime_context.workflow.body.run",
] as const

const durableStateTransitionSpanNames = [
  "firegrid.runtime_control_plane.run.allocate_attempt",
  "firegrid.runtime_control_plane.run.upsert_event",
  "firegrid.runtime_context.workflow.state.transition",
] as const

const agentWaitForWorkflowName = "firegrid.agent_tools.wait_for"

interface GateCheck {
  readonly id: string
  readonly label: string
  readonly count: number
  readonly required: boolean
  readonly passed: boolean
  readonly example?: string
}

interface Phase1WorkflowCoreGateReport {
  readonly simulationId: string
  readonly spanCount: number
  readonly checks: ReadonlyArray<GateCheck>
  readonly failures: ReadonlyArray<GateCheck>
}

const attrString = (
  span: SpanRecord,
  name: string,
): string | undefined => {
  const value = span.attributes[name]
  return typeof value === "string" ? value : undefined
}

const attrBoolean = (
  span: SpanRecord,
  name: string,
): boolean | undefined => {
  const value = span.attributes[name]
  return typeof value === "boolean" ? value : undefined
}

const countMatching = (
  spans: ReadonlyArray<SpanRecord>,
  predicate: (span: SpanRecord) => boolean,
): number =>
  spans.reduce((count, span) => predicate(span) ? count + 1 : count, 0)

const exampleMatching = (
  spans: ReadonlyArray<SpanRecord>,
  predicate: (span: SpanRecord) => boolean,
): string | undefined => {
  const span = spans.find(predicate)
  if (span === undefined) return undefined
  const workflowName = attrString(span, "firegrid.workflow.name")
  const detail = workflowName === undefined ? "" : ` workflow=${workflowName}`
  return `${span.name}${detail}`
}

const hasSpanName = (
  names: ReadonlyArray<string>,
) =>
  (span: SpanRecord): boolean => names.includes(span.name)

const isSimulationRun = (span: SpanRecord): boolean =>
  span.name === "firegrid.simulation.run" &&
  (
    attrString(span, "firegrid.simulation.id") === workflowCorePathsSimulationId ||
    span.resource["firegrid.simulation.id"] === workflowCorePathsSimulationId
  ) &&
  attrString(span, "firegrid.simulation.outcome") === "DriverCompleted"

const isDriverVerdict = (span: SpanRecord): boolean =>
  span.name === "firegrid.workflow_core_paths.driver" &&
  attrBoolean(span, "firegrid.workflow_core_paths.saw_wait_for_call") === true &&
  attrBoolean(span, "firegrid.workflow_core_paths.saw_result_marker") === true

const isAgentWaitForWorkflow = (span: SpanRecord): boolean =>
  attrString(span, "firegrid.workflow.name") === agentWaitForWorkflowName

const isWaitForWorkflowExecution = (span: SpanRecord): boolean =>
  span.name === "firegrid.workflow_engine.execution.execute" &&
  isAgentWaitForWorkflow(span)

const isWaitForActivityExecution = (span: SpanRecord): boolean =>
  span.name === "firegrid.workflow_engine.activity.execute" &&
  isAgentWaitForWorkflow(span)

const isRaceAllCompletion = (span: SpanRecord): boolean =>
  span.name === "firegrid.workflow_engine.deferred.done" &&
  isAgentWaitForWorkflow(span) &&
  attrString(span, "firegrid.workflow.deferred.name")?.startsWith("raceAll/") === true

const isDurableClockSchedule = (span: SpanRecord): boolean =>
  span.name === "firegrid.workflow_engine.clock.schedule" &&
  isAgentWaitForWorkflow(span)

const forbiddenCheck = (
  spans: ReadonlyArray<SpanRecord>,
  spanName: string,
): GateCheck => {
  const predicate = (span: SpanRecord) => span.name === spanName
  const count = countMatching(spans, predicate)
  const example = exampleMatching(spans, predicate)
  return {
    id: `legacy:${spanName}`,
    label: `legacy span must be zero: ${spanName}`,
    count,
    required: false,
    passed: count === 0,
    ...(example === undefined ? {} : { example }),
  }
}

const requiredCheck = (
  spans: ReadonlyArray<SpanRecord>,
  id: string,
  label: string,
  predicate: (span: SpanRecord) => boolean,
): GateCheck => {
  const count = countMatching(spans, predicate)
  const example = exampleMatching(spans, predicate)
  return {
    id,
    label,
    count,
    required: true,
    passed: count > 0,
    ...(example === undefined ? {} : { example }),
  }
}

// firegrid-workflow-driven-runtime.VALIDATION.10
export const analyzePhase1WorkflowCoreGate = (
  spans: ReadonlyArray<SpanRecord>,
): Phase1WorkflowCoreGateReport => {
  const checks = [
    requiredCheck(
      spans,
      "simulation-completed",
      "workflow-core-paths simulation completed",
      isSimulationRun,
    ),
    requiredCheck(
      spans,
      "driver-verdict",
      "workflow-core-paths driver observed wait_for call and result marker",
      isDriverVerdict,
    ),
    ...legacySpanNames.map(spanName => forbiddenCheck(spans, spanName)),
    requiredCheck(
      spans,
      "runtime-body",
      "runtime-context body span present",
      hasSpanName(runtimeBodySpanNames),
    ),
    requiredCheck(
      spans,
      "durable-state-transition",
      "durable state-transition span present",
      hasSpanName(durableStateTransitionSpanNames),
    ),
    requiredCheck(
      spans,
      "wait-for-workflow-execution",
      "workflow execution for firegrid.agent_tools.wait_for present",
      isWaitForWorkflowExecution,
    ),
    requiredCheck(
      spans,
      "activity-execution",
      "workflow-engine Activity execution for firegrid.agent_tools.wait_for present",
      isWaitForActivityExecution,
    ),
    requiredCheck(
      spans,
      "durable-deferred-race-all",
      "DurableDeferred.raceAll completion present",
      isRaceAllCompletion,
    ),
    requiredCheck(
      spans,
      "durable-clock-sleep",
      "DurableClock.sleep schedule present",
      isDurableClockSchedule,
    ),
  ]
  return {
    simulationId: workflowCorePathsSimulationId,
    spanCount: spans.length,
    checks,
    failures: checks.filter(check => !check.passed),
  }
}

const formatCheck = (check: GateCheck): string => {
  const status = check.passed ? "PASS" : "FAIL"
  const countLabel = check.required ? `count=${check.count}` : `count=${check.count} expected=0`
  const example = check.example === undefined ? "" : ` example=${check.example}`
  return `${status}\t${check.id}\t${countLabel}\t${check.label}${example}`
}

export const showPhase1WorkflowCoreGate = (runId: string | undefined) =>
  Effect.gen(function*() {
    const runDir = yield* resolveRunDir(runId)
    const spans = yield* readTraceSpans(runDir)
    const report = analyzePhase1WorkflowCoreGate(spans)
    yield* Console.log(`run: ${path.basename(runDir)}`)
    yield* Console.log(`trace: ${tracePathForRunDir(runDir)}`)
    yield* Console.log(`spans: ${report.spanCount}`)
    yield* Console.log("")
    yield* Effect.forEach(report.checks, check =>
      Console.log(formatCheck(check)), { discard: true })
    if (report.failures.length > 0) {
      return yield* Effect.fail(new Error(
        `Phase 1 workflow-core-paths gate failed: ${report.failures.map(f => f.id).join(", ")}`,
      ))
    }
    yield* Console.log("")
    yield* Console.log("Phase 1 workflow-core-paths gate passed")
  })
