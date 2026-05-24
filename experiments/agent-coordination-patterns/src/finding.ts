import { writeFile } from "node:fs/promises"
import path from "node:path"
import { readJson } from "./files.ts"
import type { ArmScore } from "./types.ts"
import type { ExperimentScenario } from "./types.ts"

const scenarioLabel = (
  scenario: ExperimentScenario | undefined,
  scenarioId: string | undefined,
): string => scenario === undefined
  ? scenarioId ?? "ad-hoc"
  : `${scenario.id} — ${scenario.name}`

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
    `| ${scenarioLabel(scenarioById.get(score.scenarioId ?? ""), score.scenarioId)} | ${score.arm} | ${score.summary?.status ?? "unknown"} | ${score.summary?.durationMs ?? 0} | ${score.summary?.sessionCount ?? 0} | ${score.summary?.outputCount ?? 0} | ${score.board?.rows ?? 0} | ${score.trace?.spans ?? 0} | ${score.trace?.errorSpans ?? 0} | ${score.trace?.clientClosedSpans ?? 0} | ${score.trace?.toolsCallSpans ?? 0} |`,
  )
  const boardRows = scoresPayload.scores.map(score =>
    `| ${scenarioLabel(scenarioById.get(score.scenarioId ?? ""), score.scenarioId)} | ${score.arm} | ${Object.entries(score.board?.byChannel ?? {}).map(([channel, count]) => `${channel}:${count}`).join(", ") || "none"} |`,
  )
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
      "| Scenario | Arm | Status | Duration ms | Sessions | Outputs | Board rows | Spans | Trace errors | Client closed | Tool-call spans |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      "## Board Rows By Channel",
      "",
      "| Scenario | Arm | Channels |",
      "| --- | --- | --- |",
      ...boardRows,
      "",
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
