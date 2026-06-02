import { FileSystem, Path } from "@effect/platform"
import { Console, Data, Effect } from "effect"
import {
  readTraceSpans,
  resolveRunDir,
  runsRoot,
  type SpanRecord,
  startNs,
} from "./trace.ts"

// Summarize the architectural-seam coverage of a tiny-firegrid run's OTel
// trace. Counts spans per seam, asserts every documented seam fired at least
// once, and asserts the UKV production-path host/substrate spans a driver
// cannot forge. The seam-analysis engine behind `trace:seams` (manual report)
// and `trace:seams:ukv` (the preflight gate). Reads are delegated to the
// runner's trace.ts (@effect/platform FileSystem/Path) — no raw node: I/O.
//
// The SEAMS array is canonical: when a new architectural seam is added it should
// land here at the same time (docs/architecture/2026-05-31-production-flow-otel-coverage.md).

// The architectural seams the unified architecture introduces. Each entry:
// { id, match: (span name → boolean), description, optional? }.
const SEAMS = [
  {
    id: "client.channel.dispatch",
    match: (n: string) => n === "firegrid.channel.dispatch",
    description: "Channel router dispatches a call/send/wait_for verb",
  },
  {
    id: "signal.send",
    match: (n: string) => n === "firegrid.unified.signal.send",
    description: "sendSignal — durable record + workflow resume",
  },
  {
    id: "signal.record",
    match: (n: string) => n === "firegrid.unified.signal.record",
    description: "recordSignal — durable record without resume (auto-relay land)",
  },
  {
    id: "session.body",
    match: (n: string) => n === "firegrid.unified.session.body",
    description: "RuntimeContextSessionWorkflow body iteration",
  },
  {
    id: "adapter.start_or_attach",
    match: (n: string) => n === "firegrid.unified.adapter.start_or_attach",
    description: "Adapter startOrAttach — spawn/attach to agent process",
  },
  {
    id: "adapter.send",
    match: (n: string) => n === "firegrid.unified.adapter.send",
    description: "Adapter send — input forwarded to codec",
  },
  {
    id: "adapter.deregister",
    match: (n: string) => n === "firegrid.unified.adapter.deregister",
    description: "Adapter deregister — terminal cleanup",
  },
  {
    id: "permission.workflow.execute",
    match: (n: string) => n === "unified.permission-roundtrip.execute",
    description: "PermissionRoundtripWorkflow execute (driver call or observer fork)",
  },
  {
    id: "permission.request.write",
    match: (n: string) => n.startsWith("unified.permission.request/"),
    description: "Permission roundtrip writes the open-request row",
  },
  {
    id: "permission.relay",
    match: (n: string) => n.startsWith("unified.permission.relay/"),
    description: "PermissionRoundtripWorkflow relays decision back to session (§E)",
  },
  {
    id: "tool.workflow.execute",
    match: (n: string) => n === "unified.tool-dispatch.execute",
    description: "ToolDispatchWorkflow execute",
    optional: true,
  },
  {
    id: "tool.execute",
    match: (n: string) => n.startsWith("unified.tool.execute/"),
    description: "ToolDispatchWorkflow invokes the executor",
    optional: true,
  },
  {
    id: "tool.relay",
    match: (n: string) => n.startsWith("unified.tool.relay/"),
    description: "ToolDispatchWorkflow relays result back to session (§D)",
    optional: true,
  },
  {
    id: "journal.observer.daemon",
    match: (n: string) => n === "firegrid.unified.journal_observer.daemon",
    description: "JournalObserverLive daemon",
  },
  {
    id: "workflow.engine.execute",
    match: (n: string) => n === "firegrid.workflow_engine.execution.execute",
    description: "WorkflowEngine.execute — driver workflow invocation",
  },
  {
    id: "workflow.engine.resume",
    match: (n: string) =>
      n === "firegrid.workflow_engine.execution.resume.body" ||
      n.startsWith("firegrid.workflow_engine.execution.resume"),
    description: "WorkflowEngine.resume — engine waking a parked body",
  },
  {
    id: "codec.acp.initialize",
    match: (n: string) => n === "firegrid.agent_event_pipeline.acp.initialize",
    description: "Real ACP codec — connection.initialize",
  },
  {
    id: "codec.acp.new_session",
    match: (n: string) => n === "firegrid.codec.sdk.call",
    description: "Real ACP codec — newSession (codec SDK call)",
  },
  {
    id: "codec.acp.prompt",
    match: (n: string) => n === "firegrid.agent_event_pipeline.acp.prompt",
    description: "Real ACP codec — connection.prompt",
  },
  {
    id: "codec.acp.session_update",
    match: (n: string) => n === "firegrid.agent_event_pipeline.acp.session_update",
    description: "Real ACP codec — incoming agent session updates (tool_call etc.)",
  },
  {
    id: "codec.acp.exit",
    match: (n: string) => n === "firegrid.agent_event_pipeline.acp.exit",
    description: "Real ACP codec — process exit (clean teardown)",
  },
  {
    id: "sandbox.local_process.open_byte_pipe",
    match: (n: string) => n === "firegrid.agent_event_pipeline.source.local_process.open_byte_pipe",
    description: "LocalProcessSandboxProvider — real subprocess spawn",
  },
] as const

interface SeamCoverage {
  readonly id: string
  readonly description: string
  readonly count: number
  readonly optional: boolean
  readonly status: "pass" | "fail" | "skipped"
}

interface ProductionAssertion {
  readonly id: string
  readonly description: string
  readonly count: number
  readonly threshold: number
  readonly expectation?: "atLeast" | "exactly"
  readonly source: "host-substrate-span" | "driver-corroboration"
  readonly gating: boolean
  readonly status: "pass" | "fail"
}

interface SeamCoverageSummary {
  readonly runDir: string
  readonly totalSpans: number
  readonly productionAssertions: ReadonlyArray<ProductionAssertion>
  readonly seams: ReadonlyArray<SeamCoverage>
  readonly passing: number
  readonly failing: number
  readonly nonGatingProductionFailing: number
  readonly gatingProductionFailing: number
  readonly verdict: "execution-spans-covered" | "missing-execution-spans"
}

class NoUnifiedKernelValidationRun extends Data.TaggedClass(
  "NoUnifiedKernelValidationRun",
)<{
  readonly runsRoot: string
}> {}

const getNumberAttribute = (
  spans: ReadonlyArray<SpanRecord>,
  key: string,
): number => {
  for (const span of spans) {
    const value = span.attributes[key]
    if (typeof value === "number") {
      return value
    }
    if (typeof value === "string") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }
  return 0
}

const spanContextId = (span: SpanRecord): string | undefined => {
  const value = span.attributes["firegrid.context.id"]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const countTerminalBeforeDeregister = (
  spans: ReadonlyArray<SpanRecord>,
): number => {
  const terminalSignals = spans.filter(span =>
    span.name === "firegrid.unified.session.terminal_signal")
  const deregisters = spans.filter(span =>
    span.name === "firegrid.unified.adapter.deregister")
  let count = 0
  for (const deregister of deregisters) {
    const contextId = spanContextId(deregister)
    if (contextId === undefined) continue
    const deregisterStart = startNs(deregister)
    const ordered = terminalSignals.some(terminal =>
      spanContextId(terminal) === contextId &&
      startNs(terminal) <= deregisterStart)
    if (ordered) count += 1
  }
  return count
}

const countAcpToolUseUpdates = (
  spans: ReadonlyArray<SpanRecord>,
): number =>
  spans.filter(span => {
    const tag = span.attributes["firegrid.agent_output.tag"]
    return span.name === "firegrid.agent_event_pipeline.acp.session_update" &&
      typeof tag === "string" &&
      tag.includes("ToolUse")
  }).length

const countAcpToolResultRejections = (
  spans: ReadonlyArray<SpanRecord>,
): number =>
  spans.filter(span =>
    span.name === "firegrid.agent_event_pipeline.acp.tool_result" &&
    span.status.message === "ACP ToolResult input is out-of-band for this codec slice").length

const countToolResultCodecSendFailures = (
  spans: ReadonlyArray<SpanRecord>,
): number =>
  spans.filter(span =>
    span.name === "firegrid.unified.adapter.send" &&
    span.status.message === "codec send failed" &&
    span.attributes["firegrid.unified.adapter.send.event_tag"] === "ToolResult").length

const countMatching = (
  spans: ReadonlyArray<SpanRecord>,
  name: string,
): number => spans.filter(span => span.name === name).length

// Compute the full coverage summary for a run's spans. Pure — no I/O.
const analyzeSeamCoverage = (
  runDir: string,
  spans: ReadonlyArray<SpanRecord>,
): SeamCoverageSummary => {
  const terminalBeforeDeregisterCount = countTerminalBeforeDeregister(spans)
  const acpToolUseUpdateCount = countAcpToolUseUpdates(spans)
  const acpToolResultRejectionCount = countAcpToolResultRejections(spans)
  const toolResultCodecSendFailureCount = countToolResultCodecSendFailures(spans)
  const snapshotRunCount = getNumberAttribute(spans, "firegrid.ukv.snapshot_run_count")

  const productionAssertions: ReadonlyArray<ProductionAssertion> = [
    {
      id: "workflow_engine.execution.execute",
      description: "Workflow engine executed a session workflow body",
      count: countMatching(spans, "firegrid.workflow_engine.execution.execute"),
      threshold: 1,
      source: "host-substrate-span",
      gating: true,
      status: countMatching(spans, "firegrid.workflow_engine.execution.execute") > 0 ? "pass" : "fail",
    },
    {
      id: "adapter.start_or_attach",
      description: "Production codec adapter started or attached the agent",
      count: countMatching(spans, "firegrid.unified.adapter.start_or_attach"),
      threshold: 1,
      source: "host-substrate-span",
      gating: true,
      status: countMatching(spans, "firegrid.unified.adapter.start_or_attach") > 0 ? "pass" : "fail",
    },
    {
      id: "local_process.open_byte_pipe",
      description: "LocalProcessSandboxProvider spawned a real subprocess",
      count: countMatching(spans, "firegrid.agent_event_pipeline.source.local_process.open_byte_pipe"),
      threshold: 1,
      source: "host-substrate-span",
      gating: true,
      status: countMatching(spans, "firegrid.agent_event_pipeline.source.local_process.open_byte_pipe") > 0
        ? "pass"
        : "fail",
    },
    {
      id: "adapter.deregister",
      description: "Session terminal signal drove adapter deregistration",
      count: countMatching(spans, "firegrid.unified.adapter.deregister"),
      threshold: 1,
      source: "host-substrate-span",
      gating: true,
      status: countMatching(spans, "firegrid.unified.adapter.deregister") > 0 ? "pass" : "fail",
    },
    {
      id: "session.terminal_ordering",
      description: "Terminal signal was recorded before adapter deregister for a session",
      count: terminalBeforeDeregisterCount,
      threshold: 1,
      source: "host-substrate-span",
      gating: true,
      status: terminalBeforeDeregisterCount > 0 ? "pass" : "fail",
    },
    {
      id: "acp.tool_use_observed",
      description: "firegrid-runtime-host-modularity.CODEC_RUNTIME.5 real ACP ToolUse reached the journal path",
      count: acpToolUseUpdateCount,
      threshold: 1,
      source: "host-substrate-span",
      gating: true,
      status: acpToolUseUpdateCount > 0 ? "pass" : "fail",
    },
    {
      id: "acp.tool_result_rejection_absent",
      description: "firegrid-runtime-host-modularity.CODEC_RUNTIME.5 ACP provider-executed ToolUse does not relay ToolResult",
      count: acpToolResultRejectionCount,
      threshold: 0,
      expectation: "exactly",
      source: "host-substrate-span",
      gating: true,
      status: acpToolResultRejectionCount === 0 ? "pass" : "fail",
    },
    {
      id: "tool_result.codec_send_failure_absent",
      description: "firegrid-runtime-host-modularity.CODEC_RUNTIME.4 ToolResult codec-send failure absent on ACP tool-calling turn",
      count: toolResultCodecSendFailureCount,
      threshold: 0,
      expectation: "exactly",
      source: "host-substrate-span",
      gating: true,
      status: toolResultCodecSendFailureCount === 0 ? "pass" : "fail",
    },
    {
      id: "firegrid.ukv.snapshot_run_count",
      description: "Driver snapshot corroborates that at least one run exists",
      count: snapshotRunCount,
      threshold: 1,
      source: "driver-corroboration",
      gating: false,
      status: snapshotRunCount > 0 ? "pass" : "fail",
    },
  ]

  const seams: ReadonlyArray<SeamCoverage> = SEAMS.map(seam => {
    const matched = spans.filter(span => seam.match(span.name))
    const optional = "optional" in seam ? Boolean(seam.optional) : false
    const status: "pass" | "fail" | "skipped" = matched.length > 0
      ? "pass"
      : optional
        ? "skipped"
        : "fail"
    return {
      id: seam.id,
      description: seam.description,
      count: matched.length,
      optional,
      status,
    }
  })

  const passing = seams.filter(s => s.status === "pass").length
  const failing = seams.filter(s => s.status === "fail").length
  const gatingProductionFailing = productionAssertions.filter(a => a.gating && a.status === "fail").length
  const nonGatingProductionFailing = productionAssertions.filter(a => !a.gating && a.status === "fail").length

  return {
    runDir,
    totalSpans: spans.length,
    productionAssertions,
    seams,
    passing,
    failing,
    nonGatingProductionFailing,
    gatingProductionFailing,
    verdict: gatingProductionFailing === 0 ? "execution-spans-covered" : "missing-execution-spans",
  }
}

const printSummary = (
  summary: SeamCoverageSummary,
  outputPath: string,
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const skipped = summary.seams.filter(s => s.status === "skipped").length
    yield* Console.log(`OTel seam coverage — ${summary.runDir}`)
    yield* Console.log(`Total spans in trace: ${summary.totalSpans}`)
    yield* Console.log("")
    yield* Console.log("UKV production-path assertions:")
    for (const assertion of summary.productionAssertions) {
      const mark = assertion.status === "pass" ? "✓" : "✗"
      const gate = assertion.gating ? "gating" : "report-only"
      const comparator = assertion.expectation === "exactly" ? "==" : ">="
      yield* Console.log(
        `  ${mark} ${assertion.id.padEnd(38)} ${String(assertion.count).padStart(4)}× ${comparator} ${String(assertion.threshold).padStart(1)} — ${assertion.description} (${assertion.source}, ${gate})`,
      )
    }
    yield* Console.log("")
    yield* Console.log(
      "Report-only note: snapshot_run_count verifies the OUTPUT-READ-BACK / TERMINAL-RELAY path = tf-ll90.5 (recordExited writes RuntimeControlPlaneTable.runs); not built yet — add to the gate's pass-condition when .5 lands.",
    )
    yield* Console.log("")
    yield* Console.log(
      `Seams: ${summary.passing}/${SEAMS.length} covered${skipped > 0 ? ` (${skipped} optional skipped)` : ""}`,
    )
    yield* Console.log("")
    for (const c of summary.seams) {
      const mark = c.status === "pass" ? "✓" : c.status === "skipped" ? "⊘" : "✗"
      yield* Console.log(`  ${mark} ${c.id.padEnd(38)} ${String(c.count).padStart(4)}× — ${c.description}`)
    }
    yield* Console.log("")
    yield* Console.log(`Wrote: ${outputPath}`)

    if (summary.gatingProductionFailing > 0) {
      yield* Console.error(
        `FAIL: ${summary.gatingProductionFailing} gating production assertion(s) not covered. Report-only gaps: ${summary.nonGatingProductionFailing} corroboration assertion(s), ${summary.failing} seam(s).`,
      )
    } else if (summary.failing > 0 || summary.nonGatingProductionFailing > 0) {
      yield* Console.warn(
        `WARN: gate passed; report-only gaps remain: ${summary.nonGatingProductionFailing} corroboration assertion(s), ${summary.failing} seam(s).`,
      )
    }
  })

// The newest `*unified-kernel-validation*` run directory. Run dir names are
// timestamp-prefixed, so a descending lexicographic sort is chronological —
// matching the runner's resolveRunDir fallback (no statSync needed).
const latestUnifiedKernelValidationRunDir = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* runsRoot
  // A missing runs dir (fresh checkout, no sim run yet) is "no runs", not a
  // crash — mirror resolveRunDir's tolerance in trace.ts.
  const names = yield* fs.readDirectory(root).pipe(
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
  )
  const ukv = names.filter(name => name.includes("unified-kernel-validation")).sort()
  const latest = ukv.at(-1)
  if (latest === undefined) {
    return yield* Effect.fail(new NoUnifiedKernelValidationRun({ runsRoot: root }))
  }
  return path.join(root, latest)
})

// Resolve a run (explicit id, or the latest UKV run), read its trace, compute
// coverage, write `seam-coverage.json` beside the trace, and print the report.
// Returns the summary; callers (bins) map gatingProductionFailing → exit code.
export const runSeamCoverage = (runId: string | undefined) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const runDir = runId === undefined
      ? yield* latestUnifiedKernelValidationRunDir
      : yield* resolveRunDir(runId)
    const spans = yield* readTraceSpans(runDir)
    const summary = analyzeSeamCoverage(runDir, spans)
    const outputPath = path.join(runDir, "seam-coverage.json")
    yield* fs.writeFileString(outputPath, JSON.stringify(summary, null, 2))
    yield* printSummary(summary, outputPath)
    return summary
  })
