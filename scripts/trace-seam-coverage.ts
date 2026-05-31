#!/usr/bin/env tsx
/**
 * Summarize the architectural-seam coverage of a tiny-firegrid run's
 * OTel trace. Reads `trace.jsonl`, counts spans per seam, asserts
 * every documented seam fired at least once, and prints a coverage
 * report.
 *
 * Used to prove the production-flow scenario exercises every
 * architectural path the unified architecture introduces. Run via:
 *
 *   pnpm tsx scripts/trace-seam-coverage.ts <runId>
 *
 * Or without an arg to read the latest run.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

interface Span {
  readonly name: string
  readonly traceId?: string
  readonly spanId?: string
  readonly parentSpanId?: string
  readonly startTime?: readonly [number, number]
  readonly endTime?: readonly [number, number]
  readonly attributes?: Record<string, unknown>
  readonly status?: { readonly code: number; readonly message?: string }
}

/**
 * The architectural seams the unified architecture introduces.
 * Each entry: { id, matcher: (span name → boolean), description }.
 */
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
  },
  {
    id: "tool.execute",
    match: (n: string) => n.startsWith("unified.tool.execute/"),
    description: "ToolDispatchWorkflow invokes the executor",
  },
  {
    id: "tool.relay",
    match: (n: string) => n.startsWith("unified.tool.relay/"),
    description: "ToolDispatchWorkflow relays result back to session (§D)",
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
    description: "LocalProcessSandboxProvider — real subprocess spawn (scenario 9, env-gated)",
    optional: true,
  },
] as const

interface Coverage {
  readonly id: string
  readonly description: string
  readonly count: number
  readonly optional: boolean
  readonly status: "pass" | "fail" | "skipped"
}

const findLatestRun = (runsRoot: string): string => {
  const entries = readdirSync(runsRoot)
    .filter((d) => d.includes("unified-kernel-validation"))
    .map((d) => ({ name: d, mtime: statSync(join(runsRoot, d)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (entries.length === 0) {
    throw new Error(`no unified-kernel-validation runs in ${runsRoot}`)
  }
  return join(runsRoot, entries[0]!.name)
}

const readSpans = (tracePath: string): ReadonlyArray<Span> => {
  const text = readFileSync(tracePath, "utf8")
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Span)
    .filter((s) => typeof s.name === "string")
}

const main = (): void => {
  const cwd = process.cwd()
  const runsRoot = join(cwd, "packages/tiny-firegrid/.simulate/runs")
  const arg = process.argv[2]
  const runDir = arg === undefined
    ? findLatestRun(runsRoot)
    : join(runsRoot, arg)
  const tracePath = join(runDir, "trace.jsonl")

  const spans = readSpans(tracePath)

  const coverage: ReadonlyArray<Coverage> = SEAMS.map((seam) => {
    const matched = spans.filter((s) => seam.match(s.name))
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

  const passing = coverage.filter((c) => c.status === "pass").length
  const failing = coverage.filter((c) => c.status === "fail").length
  const skipped = coverage.filter((c) => c.status === "skipped").length

  const summary = {
    runDir,
    totalSpans: spans.length,
    seams: coverage,
    passing,
    failing,
    verdict: failing === 0 ? "all-seams-covered" : "missing-seams",
  }

  const outputPath = join(runDir, "seam-coverage.json")
  writeFileSync(outputPath, JSON.stringify(summary, null, 2))

  console.log(`OTel seam coverage — ${runDir}`)
  console.log(`Total spans in trace: ${spans.length}`)
  console.log(`Seams: ${passing}/${SEAMS.length} covered${skipped > 0 ? ` (${skipped} optional skipped)` : ""}`)
  console.log("")
  for (const c of coverage) {
    const mark = c.status === "pass" ? "✓" : c.status === "skipped" ? "⊘" : "✗"
    console.log(`  ${mark} ${c.id.padEnd(38)} ${String(c.count).padStart(4)}× — ${c.description}`)
  }
  console.log("")
  console.log(`Wrote: ${outputPath}`)

  if (failing > 0) {
    console.error(`FAIL: ${failing} seam(s) not covered.`)
    process.exit(1)
  }
}

main()
