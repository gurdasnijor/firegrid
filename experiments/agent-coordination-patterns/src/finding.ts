import { writeFile } from "node:fs/promises"
import path from "node:path"
import { experimentRoot, readJson, resolveRunDir } from "./files.ts"
import type { ArmScore } from "./types.ts"
import type { ExperimentScenario } from "./types.ts"

const scenarioLabel = (
  scenario: ExperimentScenario | undefined,
  scenarioId: string | undefined,
): string => scenario === undefined
  ? scenarioId ?? "ad-hoc"
  : `${scenario.id} — ${scenario.name}`

const markdownCell = (value: unknown): string =>
  String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim()

const shortText = (value: string | undefined, max = 260): string => {
  if (value === undefined) return ""
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`
}

const traceSummaryRows = (
  scores: ReadonlyArray<ArmScore>,
  scenarioById: ReadonlyMap<string, ExperimentScenario>,
): ReadonlyArray<string> =>
  scores.map((score) => {
    const sideText = score.trace?.bySide
      .slice(0, 3)
      .map(side => `${side.side}:${side.count}/${side.totalMs}ms`)
      .join(", ") ?? "none"
    const topSpan = score.trace?.topSpans[0]
    return `| ${scenarioLabel(scenarioById.get(score.scenarioId ?? ""), score.scenarioId)} | ${score.arm} | ${markdownCell(sideText)} | ${markdownCell(topSpan?.name ?? "none")} | ${topSpan?.totalMs ?? 0} | ${score.trace?.contextLifetimes.length ?? 0} |`
  })

const finalArtifactRows = (
  scores: ReadonlyArray<ArmScore>,
  scenarioById: ReadonlyMap<string, ExperimentScenario>,
): ReadonlyArray<string> =>
  scores.map(score =>
    `| ${scenarioLabel(scenarioById.get(score.scenarioId ?? ""), score.scenarioId)} | ${score.arm} | ${markdownCell(score.summary?.finalArtifact?.title ?? "none")} | ${markdownCell(shortText(score.summary?.finalArtifact?.body))} |`,
  )

const timelineBlocks = (
  scores: ReadonlyArray<ArmScore>,
  scenarioById: ReadonlyMap<string, ExperimentScenario>,
): ReadonlyArray<string> =>
  scores.flatMap((score) => {
    const events = score.trace?.timeline.slice(0, 14) ?? []
    if (events.length === 0) return []
    return [
      `### ${scenarioLabel(scenarioById.get(score.scenarioId ?? ""), score.scenarioId)} / ${score.arm}`,
      "",
      "```text",
      ...events.map(event =>
        `${String(event.atMs).padStart(8, " ")}ms  ${event.side.padEnd(8, " ")}  ${event.status.padEnd(5, " ")}  ${event.name}`,
      ),
      "```",
      "",
    ]
  })

export const compileFinding = async (runDir: string): Promise<void> => {
  const scoresPayload = await readJson<{ readonly scores: ReadonlyArray<ArmScore> }>(
    path.join(runDir, "scores.json"),
  )
  const scenarioIds = [...new Set(scoresPayload.scores.flatMap(score =>
    score.scenarioId === undefined ? [] : [score.scenarioId]
  ))]
  const scenarios = await Promise.all(
    scenarioIds
      .map(async scenarioId =>
        readJson<ExperimentScenario>(
          path.join(runDir, "scenarios", scenarioId, "scenario.json"),
        ).catch(() => undefined)
      ),
  )
  const scenarioById = new Map(
    scenarios.filter((scenario): scenario is ExperimentScenario => scenario !== undefined)
      .map(scenario => [scenario.id, scenario]),
  )
  const rows = scoresPayload.scores.map(score =>
    // agent-coordination-patterns-experiment.ARTIFACTS.5
    `| ${scenarioLabel(scenarioById.get(score.scenarioId ?? ""), score.scenarioId)} | ${score.arm} | ${score.summary?.status ?? "unknown"} | ${score.summary?.durationMs ?? 0} | ${score.summary?.sessionCount ?? 0} | ${score.summary?.outputCount ?? 0} | ${score.trace?.contextLifetimes.length ?? 0} | ${score.board?.rows ?? 0} | ${score.trace?.spans ?? 0} | ${score.trace?.errorSpans ?? 0} | ${score.trace?.clientClosedSpans ?? 0} | ${score.trace?.toolsCallSpans ?? 0} |`,
  )
  const boardRows = scoresPayload.scores.map(score =>
    `| ${scenarioLabel(scenarioById.get(score.scenarioId ?? ""), score.scenarioId)} | ${score.arm} | ${Object.entries(score.board?.byChannel ?? {}).map(([channel, count]) => `${channel}:${count}`).join(", ") || "none"} |`,
  )
  const traceRows = traceSummaryRows(scoresPayload.scores, scenarioById)
  const finalRows = finalArtifactRows(scoresPayload.scores, scenarioById)
  const timelines = timelineBlocks(scoresPayload.scores, scenarioById)
  const blocked = scoresPayload.scores.filter(score => score.summary?.status === "blocked")
  await writeFile(
    path.join(runDir, "FINDING.md"),
    [
      "# Agent Coordination Patterns Experiment Finding",
      "",
      "Status: draft generated from run artifacts",
      "",
      "## Scenario Matrix",
      "",
      ...scenarios.filter((scenario): scenario is ExperimentScenario => scenario !== undefined)
        .flatMap(scenario => [
          `### ${scenario.id} — ${scenario.name}`,
          "",
          `Axis: ${scenario.axis}`,
          "",
          `Hypothesis: ${scenario.hypothesis}`,
          "",
          `Expected divergence: ${scenario.expectedDivergence}`,
          "",
        ]),
      "",
      "## Arm Summary",
      "",
      "| Scenario | Arm | Status | Duration ms | Captured sessions | Outputs | Runtime contexts | Board rows | Spans | Trace errors | Client closed | Tool-call spans |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      "## Board Rows By Channel",
      "",
      "| Scenario | Arm | Channels |",
      "| --- | --- | --- |",
      ...boardRows,
      "",
      "## Trace Shape",
      "",
      "| Scenario | Arm | Top sides | Highest-cost span | Highest-cost total ms | Contexts shown |",
      "| --- | --- | --- | --- | ---: | ---: |",
      ...traceRows,
      "",
      "## Final Artifacts",
      "",
      "| Scenario | Arm | Title | Body excerpt |",
      "| --- | --- | --- | --- |",
      ...finalRows,
      "",
      "## Representative Timelines",
      "",
      // agent-coordination-patterns-experiment.ARTIFACTS.6
      ...timelines,
      "## Initial Interpretation",
      "",
      "- Treat this as a generated scaffold finding, not a final research conclusion.",
      "- Generic coordination conclusions require comparing successful arms on the same task packet.",
      "- Firegrid-specific implementation findings should be separated from generic coordination findings.",
      "",
      ...(blocked.length === 0
        ? []
        : [
          "## Blocked Arms",
          "",
          ...blocked.map(score => `- ${score.arm}: ${score.summary?.reason ?? "blocked"}`),
          "",
        ]),
      "## Acceptance Hooks",
      "",
      "- agent-coordination-patterns-experiment.ARTIFACTS.3",
      "",
    ].join("\n"),
    "utf8",
  )
}

export const compileLatestFinding = async (): Promise<string> => {
  // agent-coordination-patterns-experiment.EXECUTION.8
  const runDir = await resolveRunDir(path.join(experimentRoot, "latest"))
  await compileFinding(runDir)
  return path.join(runDir, "FINDING.md")
}
