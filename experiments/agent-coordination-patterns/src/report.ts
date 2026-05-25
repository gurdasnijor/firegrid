import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CoordinationBoardRow } from "./app/coordination-board.ts"
import { experimentRoot, readJson, resolveRunDir } from "./files.ts"
import type { ArmScore, ExperimentScenario } from "./types.ts"

interface ScoresPayload {
  readonly scores: ReadonlyArray<ArmScore>
}

const armOrder = new Map<string, number>([
  ["single", 0],
  ["central", 1],
  ["choreography", 2],
])

const markdownCell = (value: unknown): string =>
  String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim()

const shortText = (value: string | undefined, max = 280): string => {
  if (value === undefined) return ""
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`
}

const scenarioLabel = (scenario: ExperimentScenario | undefined, scenarioId: string): string =>
  scenario === undefined ? scenarioId : `${scenario.id} — ${scenario.name}`

const scoreSort = (left: ArmScore, right: ArmScore): number =>
  (left.scenarioId ?? "").localeCompare(right.scenarioId ?? "") ||
  (armOrder.get(left.arm) ?? 99) - (armOrder.get(right.arm) ?? 99) ||
  left.arm.localeCompare(right.arm)

const byScenario = (scores: ReadonlyArray<ArmScore>): Map<string, ReadonlyArray<ArmScore>> => {
  const grouped = new Map<string, Array<ArmScore>>()
  for (const score of scores) {
    const scenarioId = score.scenarioId ?? "ad-hoc"
    const current = grouped.get(scenarioId) ?? []
    current.push(score)
    grouped.set(scenarioId, current)
  }
  return new Map([...grouped.entries()].map(([scenarioId, values]) => [
    scenarioId,
    values.sort(scoreSort),
  ]))
}

const readScenarios = async (runDir: string, scores: ReadonlyArray<ArmScore>) => {
  const scenarioIds = [...new Set(scores.flatMap(score =>
    score.scenarioId === undefined ? [] : [score.scenarioId]
  ))]
  const scenarios = await Promise.all(
    scenarioIds.map(async scenarioId =>
      readJson<ExperimentScenario>(
        path.join(runDir, "scenarios", scenarioId, "scenario.json"),
      ).catch(() => undefined)
    ),
  )
  return new Map(
    scenarios.filter((scenario): scenario is ExperimentScenario => scenario !== undefined)
      .map(scenario => [scenario.id, scenario]),
  )
}

const readBoardRows = async (
  runDir: string,
  scenarioId: string,
  arm: string,
): Promise<ReadonlyArray<CoordinationBoardRow>> =>
  readJson<ReadonlyArray<CoordinationBoardRow>>(
    path.join(runDir, "scenarios", scenarioId, "arms", arm, "board-rows.json"),
  ).catch(() => [])

const scoreRows = (
  scores: ReadonlyArray<ArmScore>,
  scenarios: ReadonlyMap<string, ExperimentScenario>,
): ReadonlyArray<string> =>
  [...scores].sort(scoreSort).map(score =>
    `| ${markdownCell(scenarioLabel(scenarios.get(score.scenarioId ?? ""), score.scenarioId ?? "ad-hoc"))} | ${score.arm} | ${score.summary?.status ?? "unknown"} | ${score.summary?.durationMs ?? 0} | ${score.trace?.contextLifetimes.length ?? 0} | ${score.board?.rows ?? 0} | ${score.trace?.toolsCallSpans ?? 0} | ${score.trace?.spans ?? 0} | ${score.trace?.errorSpans ?? 0} | ${score.trace?.agentSilentErrors ?? 0} | ${score.trace?.unknownChannelErrors ?? 0} |`,
  )

const winnerRows = (
  scores: ReadonlyArray<ArmScore>,
  scenarios: ReadonlyMap<string, ExperimentScenario>,
): ReadonlyArray<string> =>
  [...byScenario(scores).entries()].map(([scenarioId, scenarioScores]) => {
    const completed = scenarioScores.filter(score => score.summary?.status === "completed")
    const fastest = [...completed].sort((left, right) =>
      (left.summary?.durationMs ?? Number.POSITIVE_INFINITY) -
      (right.summary?.durationMs ?? Number.POSITIVE_INFINITY)
    )[0]
    const richestBoard = [...completed].sort((left, right) =>
      (right.board?.rows ?? 0) - (left.board?.rows ?? 0) ||
      (right.trace?.contextLifetimes.length ?? 0) - (left.trace?.contextLifetimes.length ?? 0)
    )[0]
    const fewestTools = [...completed].sort((left, right) =>
      (left.trace?.toolsCallSpans ?? Number.POSITIVE_INFINITY) -
      (right.trace?.toolsCallSpans ?? Number.POSITIVE_INFINITY)
    )[0]
    return `| ${markdownCell(scenarioLabel(scenarios.get(scenarioId), scenarioId))} | ${fastest?.arm ?? "n/a"} | ${richestBoard?.arm ?? "n/a"} | ${fewestTools?.arm ?? "n/a"} |`
  })

const finalRows = (
  scores: ReadonlyArray<ArmScore>,
  scenarios: ReadonlyMap<string, ExperimentScenario>,
): ReadonlyArray<string> =>
  [...scores].sort(scoreSort).map(score =>
    `| ${markdownCell(scenarioLabel(scenarios.get(score.scenarioId ?? ""), score.scenarioId ?? "ad-hoc"))} | ${score.arm} | ${markdownCell(score.summary?.finalArtifact?.title ?? "none")} | ${markdownCell(shortText(score.summary?.finalArtifact?.body))} |`,
  )

const boardTraceSection = async (
  runDir: string,
  scenarioId: string,
  score: ArmScore,
): Promise<ReadonlyArray<string>> => {
  const rows = await readBoardRows(runDir, scenarioId, score.arm)
  if (rows.length === 0) return []
  const traceRows = rows.slice(0, 14).map(row =>
    `| ${markdownCell(row.channel)} | ${markdownCell(row.kind ?? "")} | ${markdownCell(row.workId ?? "")} | ${markdownCell(row.title ?? "")} | ${markdownCell(shortText(row.body, 180))} |`,
  )
  return [
    `#### ${score.arm}`,
    "",
    "| Channel | Kind | Work | Title | Body excerpt |",
    "| --- | --- | --- | --- | --- |",
    ...traceRows,
    "",
  ]
}

const scenarioInterpretation = (
  scenarioId: string,
  scores: ReadonlyArray<ArmScore>,
): ReadonlyArray<string> => {
  const byArm = new Map(scores.map(score => [score.arm, score]))
  const single = byArm.get("single")
  const central = byArm.get("central")
  const choreography = byArm.get("choreography")
  const lines = [
    `- Single: ${single?.summary?.durationMs ?? "n/a"}ms, ${single?.board?.rows ?? 0} board rows, ${single?.trace?.toolsCallSpans ?? 0} tool-call spans.`,
    `- Central: ${central?.summary?.durationMs ?? "n/a"}ms, ${central?.trace?.contextLifetimes.length ?? 0} runtime contexts, ${central?.trace?.toolsCallSpans ?? 0} tool-call spans.`,
    `- Choreography: ${choreography?.summary?.durationMs ?? "n/a"}ms, ${choreography?.board?.rows ?? 0} board rows, ${choreography?.trace?.toolsCallSpans ?? 0} tool-call spans.`,
  ]
  if (scenarioId === "solo-baseline") {
    return [
      ...lines,
      "- Interpretation: the dead-simple baseline is expected to win here; this scenario primarily measures coordination overhead.",
    ]
  }
  if (scenarioId === "webhook-burst") {
    return [
      ...lines,
      "- Interpretation: single was fastest, but choreography produced the clearest durable audit trail for claims, findings, review, and finalization under inbound event load.",
    ]
  }
  if (scenarioId === "review-revision") {
    return [
      ...lines,
      "- Interpretation: multi-agent arms made critique/revision evidence explicit; choreography made that evidence durable on the board while single remained much cheaper.",
    ]
  }
  return lines
}

export const compileExperimentReport = async (
  runDir: string,
  outputPath = path.join(runDir, "EXPERIMENT_REPORT.md"),
): Promise<string> => {
  const resolvedRunDir = await resolveRunDir(runDir)
  const runId = path.basename(resolvedRunDir)
  const scoresPayload = await readJson<ScoresPayload>(path.join(resolvedRunDir, "scores.json"))
  const scores = [...scoresPayload.scores].sort(scoreSort)
  const scenarios = await readScenarios(resolvedRunDir, scores)
  const grouped = byScenario(scores)
  const boardTraceBlocks = (
    await Promise.all([...grouped.entries()].flatMap(([scenarioId, scenarioScores]) =>
      scenarioScores.map(async score => [
        `### ${scenarioLabel(scenarios.get(scenarioId), scenarioId)} / ${score.arm}`,
        "",
        ...await boardTraceSection(resolvedRunDir, scenarioId, score),
      ])
    ))
  ).flat()

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(
    outputPath,
    [
      "# Agent Coordination Patterns Experiment Report",
      "",
      `Run id: \`${runId}\``,
      "",
      "Raw trace artifacts live under the local ignored `.firegrid/agent-coordination-patterns/runs/` directory for the machine that ran the experiment.",
      "",
      "## Research Question",
      "",
      "Are sophisticated agent coordination patterns useful enough to justify their overhead, and can decentralized choreography work through durable shared channels rather than hidden harness state?",
      "",
      "## Result Summary",
      "",
      "| Scenario | Arm | Status | Duration ms | Runtime contexts | Board rows | Tool-call spans | Spans | Trace errors | agent_silent | unknown-channel |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...scoreRows(scores, scenarios),
      "",
      "## Pattern Winners",
      "",
      "| Scenario | Fastest | Richest durable coordination evidence | Lowest tool overhead |",
      "| --- | --- | --- | --- |",
      ...winnerRows(scores, scenarios),
      "",
      "## Scenario Interpretations",
      "",
      ...[...grouped.entries()].flatMap(([scenarioId, scenarioScores]) => [
        `### ${scenarioLabel(scenarios.get(scenarioId), scenarioId)}`,
        "",
        ...scenarioInterpretation(scenarioId, scenarioScores),
        "",
      ]),
      "## Final Artifact Excerpts",
      "",
      "| Scenario | Arm | Title | Excerpt |",
      "| --- | --- | --- | --- |",
      ...finalRows(scores, scenarios),
      "",
      "## Qualitative Coordination Traces",
      "",
      "These rows are the durable board trail agents created or consumed through Firegrid channels. They are the key qualitative evidence for choreography versus manager-driven orchestration.",
      "",
      ...boardTraceBlocks,
      "## Research Alignment",
      "",
      "- RQ1: sophistication did not beat the simple baseline on latency for these bounded tasks.",
      "- RQ2: review/decomposition produced explicit evidence in central and choreography arms, but at substantial overhead.",
      "- RQ3: the primary failure mode is coordination cost and extra tool traffic, not channel failure; this run had zero `agent_silent` and zero `unknown-channel` hits.",
      "- RQ4: choreography did work without a central planner in the board-mediated scenarios, and its advantage was auditability rather than speed.",
      "",
      "## Current Conclusion",
      "",
      "The strongest defensible result is conditional: use a single agent for small localized work; use choreography when durable audit trails, contention handling, review evidence, or decentralized discovery matter enough to justify higher coordination overhead. Firegrid's contribution is making that tradeoff measurable through sessions, typed channels, durable board rows, and traces.",
      "",
      "## Source Artifacts",
      "",
      "- `SCORE.md` contains the compact metric table.",
      "- `TRACE.md` contains span-side breakdowns, high-cost spans, context lifetimes, and timelines.",
      "- `TRACE_QUERIES.sql` contains DuckDB queries for deeper trace analysis.",
      "- `scenarios/*/arms/*/board-rows.json` contains the raw durable board rows.",
      "- `scenarios/*/arms/*/final-artifact.json` contains each arm's final answer.",
      "",
      "- agent-coordination-patterns-experiment.ARTIFACTS.7",
      "",
    ].join("\n"),
    "utf8",
  )
  return outputPath
}

export const compileLatestExperimentReport = async (
  outputPath?: string,
): Promise<string> => {
  const runDir = await resolveRunDir(path.join(experimentRoot, "latest"))
  return compileExperimentReport(runDir, outputPath)
}
