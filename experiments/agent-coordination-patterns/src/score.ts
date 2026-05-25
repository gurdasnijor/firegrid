import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { experimentRoot, readJson, resolveRunDir, writeJson } from "./files.ts"
import type {
  ArmScore,
  ArmSummary,
  BoardScore,
  TraceContextLifetime,
  TraceScore,
  TraceSideSummary,
  TraceSpanSummary,
  TraceTimelineEvent,
} from "./types.ts"
import type { CoordinationBoardRow } from "./app/coordination-board.ts"

const parseTraceLine = (line: string): unknown | undefined => {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return undefined
  }
}

const textOf = (value: unknown): string =>
  JSON.stringify(value)

const hrToMs = (value: unknown): number | undefined =>
  Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
    ? value[0] * 1_000 + value[1] / 1_000_000
    : undefined

const finiteMs = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, value)

const roundMs = (value: number): number =>
  Math.round(value * 10) / 10

const markdownCell = (value: unknown): string =>
  String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim()

const traceAttrs = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null &&
    typeof (value as { readonly attributes?: unknown }).attributes === "object" &&
    (value as { readonly attributes?: unknown }).attributes !== null
    ? (value as { readonly attributes: Record<string, unknown> }).attributes
    : {}

const traceResource = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null &&
    typeof (value as { readonly resource?: unknown }).resource === "object" &&
    (value as { readonly resource?: unknown }).resource !== null
    ? (value as { readonly resource: Record<string, unknown> }).resource
    : {}

const traceName = (value: unknown): string =>
  typeof value === "object" && value !== null &&
    typeof (value as { readonly name?: unknown }).name === "string"
    ? (value as { readonly name: string }).name
    : "unknown"

const traceStatus = (value: unknown): "ok" | "error" => {
  if (typeof value !== "object" || value === null) return "ok"
  const status = (value as { readonly status?: unknown }).status
  return typeof status === "object" && status !== null &&
      (status as { readonly code?: unknown }).code === 2
    ? "error"
    : "ok"
}

const traceStartMs = (value: unknown): number | undefined =>
  typeof value === "object" && value !== null
    ? hrToMs((value as { readonly startTime?: unknown }).startTime)
    : undefined

const traceDurationMs = (value: unknown): number =>
  typeof value === "object" && value !== null
    ? finiteMs(hrToMs((value as { readonly duration?: unknown }).duration))
    : 0

const traceSide = (value: unknown): string => {
  const attrs = traceAttrs(value)
  const resource = traceResource(value)
  const side = attrs["firegrid.side"] ?? resource["firegrid.side"] ??
    resource["firegrid.process.role"]
  return typeof side === "string" && side.length > 0 ? side : "unknown"
}

const traceContextId = (value: unknown): string | undefined => {
  const contextId = traceAttrs(value)["firegrid.context.id"]
  return typeof contextId === "string" && contextId.length > 0
    ? contextId
    : undefined
}

const addSummary = <A extends { count: number; totalMs: number; maxMs?: number }>(
  map: Map<string, A>,
  key: string,
  make: () => A,
  durationMs: number,
): void => {
  const current = map.get(key) ?? make()
  current.count += 1
  current.totalMs += durationMs
  if (current.maxMs !== undefined) current.maxMs = Math.max(current.maxMs, durationMs)
  map.set(key, current)
}

const timelineInteresting = (name: string): boolean =>
  [
    "session",
    "coordination.",
    "tools/call",
    "Toolkit.",
    "runtime_context",
    "agent_event_pipeline",
    "channel.",
    "workflow",
  ].some(token => name.includes(token))

const byTotalMsDesc = <A extends { readonly totalMs: number; readonly count: number }>(
  left: A,
  right: A,
): number =>
  right.totalMs - left.totalMs || right.count - left.count

const isClientClosedSpan = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false
  const attributes = (value as { readonly attributes?: unknown }).attributes
  return typeof attributes === "object" && attributes !== null &&
    (attributes as { readonly ["http.response.status_code"]?: unknown })[
        "http.response.status_code"
      ] === 499
}

const scoreTrace = async (tracePath: string): Promise<TraceScore> => {
  const text = await readFile(tracePath, "utf8").catch(() => "")
  const lines = text.split(/\r?\n/u).filter(Boolean)
  const sideCounts = new Map<string, { count: number; totalMs: number }>()
  const spanCounts = new Map<string, { count: number; totalMs: number; maxMs: number }>()
  const contextCounts = new Map<
    string,
    {
      count: number
      firstMs: number
      lastMs: number
      sides: Set<string>
    }
  >()
  const timeline: Array<TraceTimelineEvent & { readonly absoluteStartMs: number }> = []
  let firstStartMs: number | undefined
  let errorSpans = 0
  let clientClosedSpans = 0
  let agentSilentErrors = 0
  let unknownChannelErrors = 0
  let toolsCallSpans = 0
  let permissionRequestSpans = 0
  let sessionAgentOutputSpans = 0

  for (const line of lines) {
    const parsed = parseTraceLine(line)
    const serialized = textOf(parsed)
    const name = traceName(parsed)
    const side = traceSide(parsed)
    const durationMs = traceDurationMs(parsed)
    const startMs = traceStartMs(parsed)
    if (startMs !== undefined) {
      firstStartMs = firstStartMs === undefined ? startMs : Math.min(firstStartMs, startMs)
    }
    addSummary(
      sideCounts,
      side,
      () => ({ count: 0, totalMs: 0 }),
      durationMs,
    )
    addSummary(
      spanCounts,
      name,
      () => ({ count: 0, totalMs: 0, maxMs: 0 }),
      durationMs,
    )
    const contextId = traceContextId(parsed)
    if (contextId !== undefined && startMs !== undefined) {
      const current = contextCounts.get(contextId) ?? {
        count: 0,
        firstMs: startMs,
        lastMs: startMs,
        sides: new Set<string>(),
      }
      current.count += 1
      current.firstMs = Math.min(current.firstMs, startMs)
      current.lastMs = Math.max(current.lastMs, startMs + durationMs)
      current.sides.add(side)
      contextCounts.set(contextId, current)
    }
    if (startMs !== undefined && timelineInteresting(name)) {
      timeline.push({
        absoluteStartMs: startMs,
        atMs: 0,
        side,
        ...(contextId === undefined ? {} : { contextId }),
        name,
        durationMs: roundMs(durationMs),
        status: traceStatus(parsed),
      })
    }
    if (isClientClosedSpan(parsed)) {
      clientClosedSpans += 1
    } else if (
      serialized.includes("\"status\":{\"code\":2") ||
      serialized.includes("\"level\":\"ERROR\"")
    ) {
      errorSpans += 1
    }
    if (
      serialized.includes("\"reason\":\"agent_silent\"") ||
      serialized.includes("\"_tag\":\"AcpStdioEdgeTurnOutputError\"")
    ) {
      agentSilentErrors += 1
    }
    if (
      serialized.includes("UnknownChannelTarget") ||
      serialized.includes("\"reason\":\"unknown-channel\"")
    ) {
      unknownChannelErrors += 1
    }
    if (serialized.includes("tools/call")) toolsCallSpans += 1
    if (serialized.includes("permission_request")) permissionRequestSpans += 1
    if (serialized.includes("session_agent_output") || serialized.includes("session.agent_output")) {
      sessionAgentOutputSpans += 1
    }
  }

  const bySide: ReadonlyArray<TraceSideSummary> = [...sideCounts.entries()]
    .map(([side, summary]) => ({
      side,
      count: summary.count,
      totalMs: roundMs(summary.totalMs),
      avgMs: roundMs(summary.totalMs / Math.max(1, summary.count)),
    }))
    .sort(byTotalMsDesc)
  const topSpans: ReadonlyArray<TraceSpanSummary> = [...spanCounts.entries()]
    .map(([name, summary]) => ({
      name,
      count: summary.count,
      totalMs: roundMs(summary.totalMs),
      avgMs: roundMs(summary.totalMs / Math.max(1, summary.count)),
      maxMs: roundMs(summary.maxMs),
    }))
    .sort(byTotalMsDesc)
    .slice(0, 12)
  const contextLifetimes: ReadonlyArray<TraceContextLifetime> = [...contextCounts.entries()]
    .map(([contextId, summary]) => ({
      contextId,
      count: summary.count,
      firstMs: roundMs(summary.firstMs - (firstStartMs ?? summary.firstMs)),
      lastMs: roundMs(summary.lastMs - (firstStartMs ?? summary.lastMs)),
      durationMs: roundMs(summary.lastMs - summary.firstMs),
      sides: [...summary.sides].sort(),
    }))
    .sort((left, right) => right.durationMs - left.durationMs || right.count - left.count)
    .slice(0, 12)
  const normalizedTimeline: ReadonlyArray<TraceTimelineEvent> = timeline
    .map(({ absoluteStartMs, ...event }) => ({
      ...event,
      atMs: roundMs(absoluteStartMs - (firstStartMs ?? absoluteStartMs)),
    }))
    .sort((left, right) => left.atMs - right.atMs || right.durationMs - left.durationMs)
    .slice(0, 40)

  return {
    spans: lines.length,
    errorSpans,
    clientClosedSpans,
    agentSilentErrors,
    unknownChannelErrors,
    toolsCallSpans,
    permissionRequestSpans,
    sessionAgentOutputSpans,
    bySide,
    topSpans,
    contextLifetimes,
    timeline: normalizedTimeline,
  }
}

const scoreBoard = async (armDir: string): Promise<BoardScore> => {
  const rows = await readJson<ReadonlyArray<CoordinationBoardRow>>(
    path.join(armDir, "board-rows.json"),
  ).catch((): ReadonlyArray<CoordinationBoardRow> => [])
  const byChannel = rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.channel] = (counts[row.channel] ?? 0) + 1
    return counts
  }, {})
  return {
    rows: rows.length,
    byChannel,
  }
}

const scoreArms = async (
  options: {
    readonly runDir: string
    readonly scenarioId?: string
    readonly armsDir: string
  },
): Promise<ReadonlyArray<ArmScore>> => {
  const arms = await readdir(options.armsDir).catch(() => [])
  const scores: Array<ArmScore> = []
  for (const arm of arms) {
    const armDir = path.join(options.armsDir, arm)
    const summary = await readJson<ArmSummary>(path.join(armDir, "summary.json"))
      .catch(() => undefined)
    const trace = await scoreTrace(path.join(armDir, "trace.jsonl"))
    const board = await scoreBoard(armDir)
    const score: ArmScore = {
      ...(options.scenarioId === undefined ? {} : { scenarioId: options.scenarioId }),
      arm,
      ...(summary === undefined ? {} : { summary }),
      trace,
      board,
    }
    scores.push(score)
    await writeJson(path.join(armDir, "score.json"), score)
  }
  return scores
}

export const scoreRun = async (runDir: string): Promise<ReadonlyArray<ArmScore>> => {
  const scenariosDir = path.join(runDir, "scenarios")
  const scenarioIds = await readdir(scenariosDir).catch(() => [])
  const scores = scenarioIds.length === 0
    ? await scoreArms({
      runDir,
      armsDir: path.join(runDir, "arms"),
    })
    : (
      await Promise.all(scenarioIds.map(scenarioId =>
        scoreArms({
          runDir,
          scenarioId,
          armsDir: path.join(scenariosDir, scenarioId, "arms"),
        })
      ))
    ).flat()

  await writeJson(path.join(runDir, "scores.json"), {
    "agent-coordination-patterns-experiment.ARTIFACTS.2": true,
    "agent-coordination-patterns-experiment.ARTIFACTS.4": true,
    scores,
  })
  return scores
}

export const writeScoreMarkdown = async (
  runDir: string,
  scores: ReadonlyArray<ArmScore>,
): Promise<void> => {
  const rows = scores.map(score =>
    // agent-coordination-patterns-experiment.ARTIFACTS.5
    `| ${score.scenarioId ?? "ad-hoc"} | ${score.arm} | ${score.summary?.status ?? "unknown"} | ${score.summary?.durationMs ?? 0} | ${score.summary?.sessionCount ?? 0} | ${score.summary?.outputCount ?? 0} | ${score.trace?.contextLifetimes.length ?? 0} | ${score.board?.rows ?? 0} | ${score.trace?.spans ?? 0} | ${score.trace?.errorSpans ?? 0} | ${score.trace?.clientClosedSpans ?? 0} | ${score.trace?.toolsCallSpans ?? 0} | ${score.trace?.agentSilentErrors ?? 0} | ${score.trace?.unknownChannelErrors ?? 0} |`,
  )
  const boardRows = scores.map(score =>
    `| ${score.scenarioId ?? "ad-hoc"} | ${score.arm} | ${Object.entries(score.board?.byChannel ?? {}).map(([channel, count]) => `${channel}:${count}`).join(", ") || "none"} |`,
  )
  await writeFile(
    path.join(runDir, "SCORE.md"),
    [
      "# Agent Coordination Pattern Scores",
      "",
      "| Scenario | Arm | Status | Duration ms | Captured sessions | Outputs | Runtime contexts | Board rows | Spans | Errors | Client closed | Tool Calls | agent_silent | unknown-channel |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      "## Board Rows By Channel",
      "",
      "| Scenario | Arm | Channels |",
      "| --- | --- | --- |",
      ...boardRows,
      "",
    ].join("\n"),
    "utf8",
  )
}

const shortContext = (contextId: string | undefined): string =>
  contextId === undefined ? "" : contextId.length <= 18 ? contextId : `${contextId.slice(0, 15)}...`

const durationBar = (value: number, max: number): string => {
  if (max <= 0) return ""
  const width = Math.max(1, Math.round((value / max) * 20))
  return "█".repeat(width)
}

const traceHeading = (score: ArmScore): string =>
  `${score.scenarioId ?? "ad-hoc"} / ${score.arm}`

const sqlString = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`

export const writeTraceMarkdown = async (
  runDir: string,
  scores: ReadonlyArray<ArmScore>,
): Promise<void> => {
  const sections = scores.flatMap(score => {
    const trace = score.trace
    if (trace === undefined) return []
    const maxSideMs = Math.max(0, ...trace.bySide.map(side => side.totalMs))
    const sideRows = trace.bySide.map(side =>
      `| ${markdownCell(side.side)} | ${side.count} | ${side.totalMs} | ${side.avgMs} | ${durationBar(side.totalMs, maxSideMs)} |`,
    )
    const spanRows = trace.topSpans.map(span =>
      `| ${markdownCell(span.name)} | ${span.count} | ${span.totalMs} | ${span.avgMs} | ${span.maxMs} |`,
    )
    const contextRows = trace.contextLifetimes.map(context =>
      `| ${markdownCell(shortContext(context.contextId))} | ${context.count} | ${context.firstMs} | ${context.lastMs} | ${context.durationMs} | ${markdownCell(context.sides.join(", "))} |`,
    )
    const timelineRows = trace.timeline.map(event =>
      `| ${event.atMs} | ${markdownCell(event.side)} | ${markdownCell(shortContext(event.contextId))} | ${markdownCell(event.name)} | ${event.durationMs} | ${event.status} |`,
    )
    return [
      `## ${traceHeading(score)}`,
      "",
      `Spans: ${trace.spans}; errors: ${trace.errorSpans}; tool-call spans: ${trace.toolsCallSpans}; permission spans: ${trace.permissionRequestSpans}; session.agent_output spans: ${trace.sessionAgentOutputSpans}.`,
      "",
      "### Span Sides",
      "",
      "| Side | Spans | Total ms | Avg ms | Share |",
      "| --- | ---: | ---: | ---: | --- |",
      ...sideRows,
      "",
      "### Highest-Cost Span Families",
      "",
      "| Span | Count | Total ms | Avg ms | Max ms |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...spanRows,
      "",
      "### Context Lifetimes",
      "",
      "| Context | Spans | First ms | Last ms | Lifetime ms | Sides |",
      "| --- | ---: | ---: | ---: | ---: | --- |",
      ...contextRows,
      "",
      "### Representative Event Timeline",
      "",
      "| At ms | Side | Context | Span | Duration ms | Status |",
      "| ---: | --- | --- | --- | ---: | --- |",
      ...timelineRows,
      "",
    ]
  })
  await writeFile(
    path.join(runDir, "TRACE.md"),
    [
      "# Agent Coordination Trace Report",
      "",
      "Generated from Firegrid OTel JSONL span artifacts.",
      "",
      // agent-coordination-patterns-experiment.ARTIFACTS.6
      ...sections,
    ].join("\n"),
    "utf8",
  )
}

export const writeTraceSql = async (runDir: string): Promise<void> => {
  const traceGlob = path.join(runDir, "scenarios", "*", "arms", "*", "trace.jsonl")
  await writeFile(
    path.join(runDir, "TRACE_QUERIES.sql"),
    [
      "-- Agent Coordination trace analysis queries.",
      "-- Usage: duckdb < TRACE_QUERIES.sql",
      "-- Source format: Firegrid's flat OTel JSONL spans, one JSON object per line.",
      "",
      "CREATE OR REPLACE VIEW spans AS",
      "SELECT",
      "  regexp_extract(filename, '/scenarios/([^/]+)/arms/([^/]+)/trace\\.jsonl$', 1) AS scenario_id,",
      "  regexp_extract(filename, '/scenarios/([^/]+)/arms/([^/]+)/trace\\.jsonl$', 2) AS arm,",
      "  json->>'name' AS name,",
      "  json->>'traceId' AS trace_id,",
      "  json->>'spanId' AS span_id,",
      "  json->>'parentSpanId' AS parent_span_id,",
      "  (json->'startTime'->>0)::DOUBLE * 1000 + (json->'startTime'->>1)::DOUBLE / 1e6 AS start_ms,",
      "  (json->'duration'->>0)::DOUBLE * 1000 + (json->'duration'->>1)::DOUBLE / 1e6 AS dur_ms,",
      "  (json->'status'->>'code')::INT AS status_code,",
      "  json->'status'->>'message' AS status_msg,",
      "  COALESCE(json->'attributes'->>'firegrid.side', json->'resource'->>'firegrid.process.role', 'unknown') AS side,",
      "  json->'attributes'->>'firegrid.context.id' AS context_id,",
      "  json->'attributes' AS attributes,",
      "  filename",
      `FROM read_json_objects(${sqlString(traceGlob)}, filename=true);`,
      "",
      "-- Arm-level health and overhead.",
      "SELECT scenario_id, arm, count(*) AS spans,",
      "       count(*) FILTER (WHERE status_code=2) AS errors,",
      "       count(*) FILTER (WHERE name LIKE '%tools/call%') AS tools_call_spans,",
      "       round(sum(dur_ms), 1) AS total_span_ms",
      "FROM spans GROUP BY scenario_id, arm ORDER BY scenario_id, arm;",
      "",
      "-- Span-side breakdown.",
      "SELECT scenario_id, arm, side, count(*) AS spans, round(sum(dur_ms), 1) AS total_ms",
      "FROM spans GROUP BY scenario_id, arm, side ORDER BY scenario_id, arm, total_ms DESC;",
      "",
      "-- Highest-cost span families.",
      "SELECT scenario_id, arm, name, count(*) AS spans, round(sum(dur_ms), 1) AS total_ms, round(max(dur_ms), 1) AS max_ms",
      "FROM spans GROUP BY scenario_id, arm, name ORDER BY scenario_id, arm, total_ms DESC LIMIT 80;",
      "",
      "-- Context lifetimes.",
      "SELECT scenario_id, arm, context_id, count(*) AS spans,",
      "       round(max(start_ms + dur_ms) - min(start_ms), 1) AS lifetime_ms,",
      "       string_agg(DISTINCT side, ', ' ORDER BY side) AS sides",
      "FROM spans WHERE context_id IS NOT NULL",
      "GROUP BY scenario_id, arm, context_id",
      "ORDER BY scenario_id, arm, lifetime_ms DESC;",
      "",
      "-- Agent wire bytes; this is the agent subprocess view.",
      "SELECT scenario_id, arm, start_ms, side,",
      "       attributes->>'firegrid.wire.direction' AS direction,",
      "       substr(attributes->>'firegrid.wire.raw', 1, 240) AS raw",
      "FROM spans WHERE name LIKE '%local_process.stdout_bytes%' OR name LIKE '%local_process.stderr_bytes%'",
      "ORDER BY start_ms;",
      "",
      "-- Permission round-trip health.",
      "SELECT scenario_id, arm,",
      "  count(*) FILTER (WHERE name='firegrid.agent_event_pipeline.acp.permission_request') AS permission_requests,",
      "  count(*) FILTER (WHERE name='firegrid.channel.host.permissions.respond.call') AS permission_respond_calls,",
      "  count(*) FILTER (WHERE name='firegrid.agent_event_pipeline.acp.permission_response') AS permission_responses",
      "FROM spans GROUP BY scenario_id, arm ORDER BY scenario_id, arm;",
      "",
    ].join("\n"),
    "utf8",
  )
}

export const scoreLatestRun = async (): Promise<string> => {
  // agent-coordination-patterns-experiment.EXECUTION.8
  const runDir = await resolveRunDir(path.join(experimentRoot, "latest"))
  const scores = await scoreRun(runDir)
  await writeScoreMarkdown(runDir, scores)
  await writeTraceMarkdown(runDir, scores)
  await writeTraceSql(runDir)
  return path.join(runDir, "SCORE.md")
}
